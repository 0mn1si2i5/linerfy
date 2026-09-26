"""DB integration tests for short leases and compare-and-set commits.

Proves the worker lifecycle guarantees: a claim writes a fresh lease, a stale
lease can never commit, reaping an expired lease requeues the job, and a worker
holding an old lease cannot overwrite a newer claim. Gated like the other DB
integration tests.
"""

from __future__ import annotations

import os
import time

import psycopg
import pytest
from _db_helpers import skip_unless_test_db

from linerfy_ingest.db import connect
from linerfy_ingest.jobs import (
    PostgresJobStore,
    StaleLease,
    assert_active_lease,
    record_corpus_hash,
)

pytestmark = pytest.mark.skipif(
    not (
        os.environ.get("DATABASE_URL")
        and os.environ.get("LINERFY_DB_TESTS_ALLOWED") == "1"
    ),
    reason="set DATABASE_URL and LINERFY_DB_TESTS_ALLOWED=1 to run DB integration tests",
)


def _insert_job(conn, entity_id: str) -> None:
    conn.execute(
        "INSERT INTO public.enrichment_jobs "
        "(entity_id, entity_kind, stage, state, payload) "
        "VALUES (%s, 'release', 'resolve_entity', 'queued', '{}')",
        (entity_id,),
    )


def _delete_job(entity_id: str) -> None:
    with connect() as conn:
        conn.execute(
            "DELETE FROM public.enrichment_jobs WHERE entity_id = %s", (entity_id,)
        )


def test_claim_writes_lease_and_increments_attempt() -> None:
    with connect() as conn:
        skip_unless_test_db(conn)
    try:
        with connect() as conn:
            _insert_job(conn, "lease-1")
        store = PostgresJobStore()
        claimed = store.reap_and_claim()
        assert claimed is not None and claimed.lease_id
        with connect() as conn:
            row = conn.execute(
                "SELECT state, lease_id, attempt FROM public.enrichment_jobs "
                "WHERE entity_id = 'lease-1'"
            ).fetchone()
            assert row[0] == "running"
            assert str(row[1]) == claimed.lease_id
            assert row[2] == 1
    finally:
        _delete_job("lease-1")


def test_claim_is_exclusive() -> None:
    with connect() as conn:
        skip_unless_test_db(conn)
    try:
        with connect() as conn:
            _insert_job(conn, "lease-2")
        store = PostgresJobStore()
        first = store.reap_and_claim()
        assert first is not None
        # The job is now running, so a second claim finds nothing to claim.
        assert store.reap_and_claim() is None
    finally:
        _delete_job("lease-2")


@pytest.mark.parametrize(
    ("retryable", "expected_state"), [(False, "failed"), (True, "queued")]
)
def test_fail_respects_retryability(retryable: bool, expected_state: str) -> None:
    entity_id = f"lease-fail-{retryable}"
    with connect() as conn:
        skip_unless_test_db(conn)
    try:
        with connect() as conn:
            _insert_job(conn, entity_id)
        store = PostgresJobStore()
        claimed = store.reap_and_claim()
        assert claimed is not None

        store.fail(
            claimed.job.id,
            claimed.lease_id,
            "ModelProviderError:http_401",
            retryable=retryable,
        )

        with connect() as conn:
            row = conn.execute(
                "SELECT state, retry_count, last_error FROM public.enrichment_jobs "
                "WHERE entity_id = %s",
                (entity_id,),
            ).fetchone()
        assert row == (expected_state, 1, "ModelProviderError:http_401")
    finally:
        _delete_job(entity_id)


def test_claim_prioritizes_the_most_recent_now_playing_request() -> None:
    with connect() as conn:
        skip_unless_test_db(conn)
    try:
        with connect() as conn:
            _insert_job(conn, "claim-older")
            _insert_job(conn, "claim-current")
            conn.execute(
                "UPDATE public.enrichment_jobs SET created_at = now() - interval '1 hour' "
                "WHERE entity_id = 'claim-older'"
            )
        claimed = PostgresJobStore().reap_and_claim()
        assert claimed is not None
        assert claimed.job.entity_id == "claim-current"
    finally:
        _delete_job("claim-older")
        _delete_job("claim-current")


def test_stale_lease_commit_is_rejected() -> None:
    with connect() as conn:
        skip_unless_test_db(conn)
    try:
        with connect() as conn:
            _insert_job(conn, "lease-3")
        store = PostgresJobStore()
        claimed = store.reap_and_claim()
        assert claimed is not None
        # Simulate a reap + re-claim by another worker: replace the lease.
        with connect() as conn:
            conn.execute(
                "UPDATE public.enrichment_jobs "
                "SET lease_id = '00000000-0000-0000-0000-000000000000' "
                "WHERE entity_id = 'lease-3'"
            )
        with pytest.raises(StaleLease):
            store.commit(claimed.job.id, claimed.lease_id, stage=None, state="ready")
    finally:
        _delete_job("lease-3")


def test_expired_lease_is_reaped_and_old_worker_cannot_overwrite() -> None:
    with connect() as conn:
        skip_unless_test_db(conn)
    try:
        with connect() as conn:
            _insert_job(conn, "lease-4")
        store = PostgresJobStore()
        old = store.reap_and_claim()
        assert old is not None
        # Force the lease to expire.
        with connect() as conn:
            conn.execute(
                "UPDATE public.enrichment_jobs SET lease_expires_at = now() - interval '1 second' "
                "WHERE entity_id = 'lease-4'"
            )
        # Reap requeues the job, then a fresh claim takes it with a new lease.
        fresh = store.reap_and_claim()
        assert fresh is not None and fresh.lease_id != old.lease_id
        # The old worker's commit must now be refused.
        with pytest.raises(StaleLease):
            store.commit(old.job.id, old.lease_id, stage=None, state="ready")
        # The fresh worker's commit succeeds.
        store.commit(fresh.job.id, fresh.lease_id, stage=None, state="ready")
    finally:
        _delete_job("lease-4")


def test_renew_extends_lease_and_rejects_stale_lease() -> None:
    with connect() as conn:
        skip_unless_test_db(conn)
    try:
        with connect() as conn:
            _insert_job(conn, "lease-5")
        store = PostgresJobStore(lease_seconds=120)
        claimed = store.reap_and_claim()
        assert claimed is not None

        # A valid renew pushes the deadline out past the default 120s window.
        with connect() as conn:
            before = conn.execute(
                "SELECT lease_expires_at FROM public.enrichment_jobs "
                "WHERE entity_id = 'lease-5'"
            ).fetchone()[0]
        store.renew(claimed.job.id, claimed.lease_id)
        with connect() as conn:
            after = conn.execute(
                "SELECT lease_expires_at FROM public.enrichment_jobs "
                "WHERE entity_id = 'lease-5'"
            ).fetchone()[0]
        assert after >= before

        # A stale lease is refused by renew too.
        with connect() as conn:
            conn.execute(
                "UPDATE public.enrichment_jobs "
                "SET lease_id = '00000000-0000-0000-0000-000000000000' "
                "WHERE entity_id = 'lease-5'"
            )
        with pytest.raises(StaleLease):
            store.renew(claimed.job.id, claimed.lease_id)
    finally:
        _delete_job("lease-5")


def test_commit_rejected_when_lease_expired_with_matching_id() -> None:
    with connect() as conn:
        skip_unless_test_db(conn)
    try:
        with connect() as conn:
            _insert_job(conn, "lease-7")
        store = PostgresJobStore()
        claimed = store.reap_and_claim()
        assert claimed is not None
        # The id and lease_id both still match; only the lease has lapsed. The
        # active-lease predicate (state='running' AND lease_expires_at > now())
        # must refuse the write, unlike the old id+lease_id-only comparison.
        with connect() as conn:
            conn.execute(
                "UPDATE public.enrichment_jobs SET lease_expires_at = now() - interval '1 second' "
                "WHERE entity_id = 'lease-7'"
            )
        with pytest.raises(StaleLease):
            store.commit(claimed.job.id, claimed.lease_id, stage=None, state="ready")
    finally:
        _delete_job("lease-7")


def test_active_lease_helpers_reject_expired_lease() -> None:
    # The fetch_sources path guards seed + corpus recording with these helpers;
    # an expired lease must fence both off even when id and lease_id match.
    with connect() as conn:
        skip_unless_test_db(conn)
    try:
        with connect() as conn:
            _insert_job(conn, "lease-8")
        store = PostgresJobStore()
        claimed = store.reap_and_claim()
        assert claimed is not None
        with connect() as conn:
            conn.execute(
                "UPDATE public.enrichment_jobs SET lease_expires_at = now() - interval '1 second' "
                "WHERE entity_id = 'lease-8'"
            )
        with connect() as conn:
            with pytest.raises(StaleLease):
                assert_active_lease(conn, claimed.job.id, claimed.lease_id)
            with pytest.raises(StaleLease):
                record_corpus_hash(conn, claimed.job.id, claimed.lease_id, "corpus-1")
    finally:
        _delete_job("lease-8")


def test_active_lease_helpers_accept_valid_lease() -> None:
    with connect() as conn:
        skip_unless_test_db(conn)
    try:
        with connect() as conn:
            _insert_job(conn, "lease-9")
        store = PostgresJobStore()
        claimed = store.reap_and_claim()
        assert claimed is not None
        with connect(autocommit=False) as conn:
            assert_active_lease(conn, claimed.job.id, claimed.lease_id)
            record_corpus_hash(conn, claimed.job.id, claimed.lease_id, "corpus-9")
            conn.commit()
        with connect() as conn:
            row = conn.execute(
                "SELECT corpus_hash FROM public.enrichment_jobs WHERE entity_id = 'lease-9'"
            ).fetchone()
            assert row[0] == "corpus-9"
    finally:
        _delete_job("lease-9")


def test_reaper_cannot_take_over_between_lease_check_and_commit() -> None:
    with connect() as conn:
        skip_unless_test_db(conn)
    try:
        with connect() as conn:
            _insert_job(conn, "lease-race")
        store = PostgresJobStore(lease_seconds=1)
        claimed = store.reap_and_claim()
        assert claimed is not None
        job_id, lease_id = claimed.job.id, claimed.lease_id

        # Connection A: the lease check locks the job row FOR UPDATE and holds
        # it open — the window between the check and the caller's commit.
        conn_a = connect(autocommit=False)
        try:
            assert_active_lease(conn_a, job_id, lease_id)

            # Let the 1-second lease lapse so the reaper would target this row.
            time.sleep(2.0)

            # Connection B: the reaper must block on connection A's row lock
            # rather than take over the lease before the check's commit.
            conn_b = connect()
            conn_b.execute("SET lock_timeout = '500ms'")
            with pytest.raises(psycopg.errors.LockNotAvailable):
                store._reap(conn_b)
            conn_b.rollback()
            conn_b.close()

            # Only after connection A commits does the reaper get through.
            conn_a.commit()
        finally:
            conn_a.close()

        with connect() as conn:
            store._reap(conn)
        with connect() as conn:
            row = conn.execute(
                "SELECT state, lease_id FROM public.enrichment_jobs "
                "WHERE entity_id = 'lease-race'"
            ).fetchone()
            assert row[0] == "queued"
            assert row[1] is None
    finally:
        _delete_job("lease-race")


def test_timeout_reap_runs_real_sql_and_requeues() -> None:
    with connect() as conn:
        skip_unless_test_db(conn)
    try:
        with connect() as conn:
            _insert_job(conn, "lease-6")
        store = PostgresJobStore(lease_seconds=1)
        claimed = store.reap_and_claim()
        assert claimed is not None
        # Expire the lease directly with real SQL (this exercises make_interval
        # free of the quoted-placeholder bug that used to break the claim).
        with connect() as conn:
            conn.execute(
                "UPDATE public.enrichment_jobs SET lease_expires_at = now() - interval '1 second' "
                "WHERE entity_id = 'lease-6'"
            )
        # Reap bumps retry_count and requeues (retry_count 0 -> queued).
        with connect() as conn:
            conn.execute(
                "UPDATE public.enrichment_jobs SET retry_count = 0 WHERE entity_id = 'lease-6'"
            )
        fresh = store.reap_and_claim()
        assert fresh is not None and fresh.lease_id != claimed.lease_id
        with connect() as conn:
            row = conn.execute(
                "SELECT state, retry_count, attempt FROM public.enrichment_jobs "
                "WHERE entity_id = 'lease-6'"
            ).fetchone()
            assert row[0] == "running"
            assert row[1] == 1  # reaped once
            assert row[2] == 2  # claimed twice
    finally:
        _delete_job("lease-6")
