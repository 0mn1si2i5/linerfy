"""Database integration tests for per-scope summary publishing.

Opt-in and gated: they run only when both ``DATABASE_URL`` and
``LINERFY_DB_TESTS_ALLOWED=1`` are set, and then only against a database marked
with ``prepare_test_db``. Every entity is uniquely named and cleaned up, so a
real release such as Norman Fucking Rockwell! is never read or written.

These prove the per-scope publish invariants: a generation is written directly
as the current published version (superseding the old one) in one transaction,
guarded by an active lease; a safe retry with the same corpus hash is
idempotent; a changed corpus creates a new generation; and writing one scope
never touches another scope's published version.
"""

from __future__ import annotations

import os
import uuid
from datetime import UTC, datetime

import psycopg
import pytest
from _db_helpers import cleanup, skip_unless_test_db

from linerfy_ingest.db import connect, seed
from linerfy_ingest.jobs import StaleLease
from linerfy_ingest.models import (
    ArtistEntity,
    CitedClaim,
    IngestedContext,
    ReleaseEntity,
    ReviewDocument,
    ReviewSource,
    SourcePolicy,
    Summary,
)
from linerfy_ingest.seed import stable_uuid
from linerfy_ingest.summarize import publish_consensus_skipped, publish_summary

pytestmark = pytest.mark.skipif(
    not (os.environ.get("DATABASE_URL") and os.environ.get("LINERFY_DB_TESTS_ALLOWED") == "1"),
    reason="set DATABASE_URL and LINERFY_DB_TESTS_ALLOWED=1 to run DB integration tests",
)

_RELEASE_SLUG = "atomic-release"


def _sid(kind: str, slug: str) -> uuid.UUID:
    return uuid.UUID(stable_uuid(kind, slug))


def _summary(
    texts: list[str],
    *,
    corpus_hash: str = "test-corpus",
    kind: str = "source",
    source_id: str | None = "atomic-source",
    license_pool: str = "proprietary",
) -> Summary:
    """A summary whose claims all cite existing catalog documents by default."""
    default_sources = ["atomic-doc-a", "atomic-doc-b", "atomic-doc-c"]
    claims = [
        CitedClaim(text=text, source_ids=[default_sources[i % len(default_sources)]])
        for i, text in enumerate(texts)
    ]
    return Summary(
        locale="zh-CN",
        model="test-model",
        prompt_version="test-v1",
        generated_at=datetime(2026, 1, 1, tzinfo=UTC),
        corpus_hash=corpus_hash,
        claims=claims,
        kind=kind,
        source_id=source_id,
        license_pool=license_pool,
        license_url="https://example.com/license",
        attribution="Atomic Source",
    )


def _insert_atomic_catalog(conn) -> dict:
    ids = {
        "artist": _sid("artist", "atomic-artist"),
        "release": _sid("release", _RELEASE_SLUG),
        "source": _sid("source", "atomic-source"),
    }
    conn.execute(
        "INSERT INTO public.artists (id, slug, name) VALUES (%s,%s,%s)",
        (ids["artist"], "atomic-artist", "Atomic Artist"),
    )
    conn.execute(
        "INSERT INTO public.releases (id, slug, artist_id, title) VALUES (%s,%s,%s,%s)",
        (ids["release"], _RELEASE_SLUG, ids["artist"], "Atomic Release"),
    )
    conn.execute(
        "INSERT INTO public.review_sources "
        "(id, slug, publication, homepage_url) VALUES (%s,%s,%s,%s)",
        (ids["source"], "atomic-source", "Atomic Source", "https://example.com"),
    )
    for i in ("a", "b", "c"):
        slug = f"atomic-doc-{i}"
        conn.execute(
            "INSERT INTO public.review_documents "
            "(id, slug, release_id, source_id, source_url, title, license_id, "
            " license_url, content_fingerprint, status) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (
                _sid("document", slug),
                slug,
                ids["release"],
                ids["source"],
                f"https://example.com/{slug}",
                slug,
                "proprietary",
                "https://example.com/license",
                f"fingerprint-{slug}",
                "published",
            ),
        )
    return ids


def _insert_job(conn, lease_id: uuid.UUID, *, expired: bool = False) -> uuid.UUID:
    job_id = uuid.uuid4()
    conn.execute(
        "INSERT INTO public.enrichment_jobs "
        "(id, entity_id, entity_kind, stage, state, lease_id, lease_expires_at, payload) "
        "VALUES (%s,%s,%s,%s,%s,%s, now() + interval '120 seconds', %s)",
        (
            job_id,
            f"atomic-{job_id.hex[:8]}",
            "release",
            "build_source_summaries",
            "running",
            lease_id,
            '{"provider":"test","title":"T","artist":"A","album":"B","state":"playing"}',
        ),
    )
    if expired:
        conn.execute(
            "UPDATE public.enrichment_jobs SET lease_expires_at = now() - interval '1 second' "
            "WHERE id = %s",
            (job_id,),
        )
    return job_id


def _published(conn, release_id: uuid.UUID) -> dict[str, str]:
    rows = conn.execute(
        "SELECT corpus_hash, status FROM public.summary_runs WHERE release_id = %s "
        "ORDER BY corpus_hash",
        (release_id,),
    ).fetchall()
    return {row[0]: row[1] for row in rows}


def test_publish_writes_a_current_published_generation() -> None:
    with connect() as conn:
        skip_unless_test_db(conn)
        ids = _insert_atomic_catalog(conn)
        lease_id = uuid.uuid4()
        job_id = _insert_job(conn, lease_id)
    try:
        s = _summary(["结论一", "结论二", "结论三"])
        with connect(autocommit=False) as conn:
            publish_summary(conn, _RELEASE_SLUG, s, job_id=str(job_id), lease_id=str(lease_id))
        with connect() as conn:
            assert _published(conn, ids["release"]) == {"test-corpus": "published"}
    finally:
        with connect() as conn:
            conn.execute("DELETE FROM public.enrichment_jobs WHERE entity_id LIKE 'atomic-%'")
            cleanup(conn, artist_id=ids["artist"], source_id=ids["source"])


def test_publish_supersedes_old_and_retains_it() -> None:
    with connect() as conn:
        skip_unless_test_db(conn)
        ids = _insert_atomic_catalog(conn)
        lease_id = uuid.uuid4()
        job_id = _insert_job(conn, lease_id)
    try:
        v1 = _summary(["结论一", "结论二", "结论三"], corpus_hash="corpus-v1")
        v2 = _summary(["新结论一", "新结论二", "新结论三"], corpus_hash="corpus-v2")
        with connect(autocommit=False) as conn:
            publish_summary(conn, _RELEASE_SLUG, v1, job_id=str(job_id), lease_id=str(lease_id))
        with connect(autocommit=False) as conn:
            publish_summary(conn, _RELEASE_SLUG, v2, job_id=str(job_id), lease_id=str(lease_id))
        with connect() as conn:
            # v1 is retained but superseded; only v2 is current published.
            assert _published(conn, ids["release"]) == {
                "corpus-v1": "superseded",
                "corpus-v2": "published",
            }
    finally:
        with connect() as conn:
            conn.execute("DELETE FROM public.enrichment_jobs WHERE entity_id LIKE 'atomic-%'")
            cleanup(conn, artist_id=ids["artist"], source_id=ids["source"])


@pytest.mark.parametrize("changed_field", ["prompt_version", "model"])
def test_publish_same_corpus_hash_is_idempotent(changed_field) -> None:
    with connect() as conn:
        skip_unless_test_db(conn)
        ids = _insert_atomic_catalog(conn)
        lease_id = uuid.uuid4()
        job_id = _insert_job(conn, lease_id)
    try:
        s = _summary(["结论一", "结论二", "结论三"])
        with connect(autocommit=False) as conn:
            first = publish_summary(
                conn, _RELEASE_SLUG, s, job_id=str(job_id), lease_id=str(lease_id)
            )
        with connect(autocommit=False) as conn:
            second = publish_summary(
                conn, _RELEASE_SLUG, s, job_id=str(job_id), lease_id=str(lease_id)
            )
        assert first == second
        with connect() as conn:
            count = conn.execute(
                "SELECT count(*) FROM public.summary_runs WHERE release_id = %s",
                (ids["release"],),
            ).fetchone()[0]
            assert count == 1
        # Same corpus, different generator: replace once, then reuse that version.
        changed = s.model_copy(update={changed_field: "next-version"})
        with connect(autocommit=False) as conn:
            third = publish_summary(
                conn, _RELEASE_SLUG, changed, job_id=str(job_id), lease_id=str(lease_id)
            )
        assert third != first
        with connect(autocommit=False) as conn:
            assert (
                publish_summary(
                    conn, _RELEASE_SLUG, changed, job_id=str(job_id), lease_id=str(lease_id)
                )
                == third
            )
    finally:
        with connect() as conn:
            conn.execute("DELETE FROM public.enrichment_jobs WHERE entity_id LIKE 'atomic-%'")
            cleanup(conn, artist_id=ids["artist"], source_id=ids["source"])


def test_publish_rejected_when_lease_expired() -> None:
    with connect() as conn:
        skip_unless_test_db(conn)
        ids = _insert_atomic_catalog(conn)
        lease_id = uuid.uuid4()
        job_id = _insert_job(conn, lease_id, expired=True)
    try:
        s = _summary(["结论一", "结论二", "结论三"])
        with connect(autocommit=False) as conn, pytest.raises(StaleLease):
            publish_summary(conn, _RELEASE_SLUG, s, job_id=str(job_id), lease_id=str(lease_id))
        with connect() as conn:
            assert _published(conn, ids["release"]) == {}
    finally:
        with connect() as conn:
            conn.execute("DELETE FROM public.enrichment_jobs WHERE entity_id LIKE 'atomic-%'")
            cleanup(conn, artist_id=ids["artist"], source_id=ids["source"])


def test_publish_rejected_when_lease_mismatched() -> None:
    with connect() as conn:
        skip_unless_test_db(conn)
        ids = _insert_atomic_catalog(conn)
        job_id = _insert_job(conn, uuid.uuid4())
    try:
        s = _summary(["结论一", "结论二", "结论三"])
        with connect(autocommit=False) as conn, pytest.raises(StaleLease):
            publish_summary(
                conn,
                _RELEASE_SLUG,
                s,
                job_id=str(job_id),
                lease_id=str(uuid.uuid4()),  # wrong lease
            )
        with connect() as conn:
            assert _published(conn, ids["release"]) == {}
    finally:
        with connect() as conn:
            conn.execute("DELETE FROM public.enrichment_jobs WHERE entity_id LIKE 'atomic-%'")
            cleanup(conn, artist_id=ids["artist"], source_id=ids["source"])


def test_publish_failure_leaves_old_published() -> None:
    with connect() as conn:
        skip_unless_test_db(conn)
        ids = _insert_atomic_catalog(conn)
        lease_id = uuid.uuid4()
        job_id = _insert_job(conn, lease_id)
    try:
        v1 = _summary(["结论一", "结论二", "结论三"], corpus_hash="corpus-v1")
        with connect(autocommit=False) as conn:
            publish_summary(conn, _RELEASE_SLUG, v1, job_id=str(job_id), lease_id=str(lease_id))

        # A candidate citing a nonexistent document violates the claim_sources
        # foreign key; the transaction rolls back, leaving v1 published.
        bad = Summary(
            locale="zh-CN",
            model="test-model",
            prompt_version="test-v1",
            generated_at=datetime(2026, 1, 1, tzinfo=UTC),
            corpus_hash="corpus-v2",
            claims=[
                CitedClaim(text=f"结论{i}", source_ids=["atomic-doc-nonexistent"]) for i in range(3)
            ],
        )
        with connect(autocommit=False) as conn, pytest.raises(psycopg.errors.IntegrityError):
            publish_summary(conn, _RELEASE_SLUG, bad, job_id=str(job_id), lease_id=str(lease_id))
        with connect() as conn:
            assert _published(conn, ids["release"]) == {"corpus-v1": "published"}
    finally:
        with connect() as conn:
            conn.execute("DELETE FROM public.enrichment_jobs WHERE entity_id LIKE 'atomic-%'")
            cleanup(conn, artist_id=ids["artist"], source_id=ids["source"])


def test_source_a_publish_does_not_touch_source_b() -> None:
    with connect() as conn:
        skip_unless_test_db(conn)
        ids = _insert_atomic_catalog(conn)
        lease_id = uuid.uuid4()
        job_id = _insert_job(conn, lease_id)
    try:
        source_a = _summary(["结论一", "结论二", "结论三"], source_id="src-a")
        with connect(autocommit=False) as conn:
            publish_summary(
                conn,
                _RELEASE_SLUG,
                source_a,
                job_id=str(job_id),
                lease_id=str(lease_id),
            )
        with connect() as conn:
            scopes = conn.execute(
                "SELECT scope, status FROM public.summary_runs WHERE release_id = %s",
                (ids["release"],),
            ).fetchall()
            assert {row[0] for row in scopes} == {"source::src-a::proprietary"}
            # No published row exists for a different source.
            assert all(row[1] == "published" for row in scopes)
    finally:
        with connect() as conn:
            conn.execute("DELETE FROM public.enrichment_jobs WHERE entity_id LIKE 'atomic-%'")
            cleanup(conn, artist_id=ids["artist"], source_id=ids["source"])


def test_consensus_skipped_is_published() -> None:
    with connect() as conn:
        skip_unless_test_db(conn)
        ids = _insert_atomic_catalog(conn)
        lease_id = uuid.uuid4()
        job_id = _insert_job(conn, lease_id)
    try:
        with connect(autocommit=False) as conn:
            publish_consensus_skipped(
                conn,
                _RELEASE_SLUG,
                license_pool="pool-1",
                attribution="Atomic Source",
                corpus_hash="pool-v1",
                job_id=str(job_id),
                lease_id=str(lease_id),
            )
        with connect() as conn:
            row = conn.execute(
                "SELECT status, skipped_reason FROM public.summary_runs WHERE release_id = %s",
                (ids["release"],),
            ).fetchone()
            assert row == ("published", "insufficient-sources")
    finally:
        with connect() as conn:
            conn.execute("DELETE FROM public.enrichment_jobs WHERE entity_id LIKE 'atomic-%'")
            cleanup(conn, artist_id=ids["artist"], source_id=ids["source"])


@pytest.mark.parametrize("second_source", ["src-a", "src-b"])
def test_two_sources_and_two_pools_all_publish(second_source: str) -> None:
    with connect() as conn:
        skip_unless_test_db(conn)
        ids = _insert_atomic_catalog(conn)
        lease_id = uuid.uuid4()
        job_id = _insert_job(conn, lease_id)
    try:
        source_a = _summary(
            ["结论一", "结论二", "结论三"], source_id="src-a", license_pool="pool-1"
        )
        source_b = _summary(
            ["结论四", "结论五", "结论六"], source_id=second_source, license_pool="pool-2"
        )
        consensus_1 = _summary(
            ["共识一", "共识二", "共识三"], kind="consensus", license_pool="pool-1", source_id=None
        )
        consensus_2 = _summary(
            ["共识四", "共识五", "共识六"], kind="consensus", license_pool="pool-2", source_id=None
        )
        with connect(autocommit=False) as conn:
            for block in (source_a, source_b, consensus_1, consensus_2):
                publish_summary(
                    conn, _RELEASE_SLUG, block, job_id=str(job_id), lease_id=str(lease_id)
                )
        with connect() as conn:
            scopes = conn.execute(
                "SELECT scope, status FROM public.summary_runs WHERE release_id = %s",
                (ids["release"],),
            ).fetchall()
            assert {row[0] for row in scopes} == {
                "source::src-a::pool-1",
                f"source::{second_source}::pool-2",
                "consensus::pool-1",
                "consensus::pool-2",
            }
            assert all(row[1] == "published" for row in scopes)
    finally:
        with connect() as conn:
            conn.execute("DELETE FROM public.enrichment_jobs WHERE entity_id LIKE 'atomic-%'")
            cleanup(conn, artist_id=ids["artist"], source_id=ids["source"])


# --- insert-only seeding (the fixture no-overwrite guarantee, made synthetic) ---


def _synthetic_context(title: str, claim_text: str) -> IngestedContext:
    artist = ArtistEntity(id="synthetic-artist", name="Synthetic Artist")
    release = ReleaseEntity(id="synthetic-release", title=title, artist_id=artist.id, year=2000)
    source = ReviewSource(
        id="synthetic-source",
        publication="Synthetic Source",
        homepage_url="https://example.com/synthetic",
    )
    policy = SourcePolicy(
        source_id=source.id,
        crawl_allowed=True,
        requests_per_minute=10,
        retention_days=30,
        excerpt_max_chars=280,
        attribution_required=True,
        removal_contact="rights@example.com",
        license_id="CC0-1.0",
        license_url="https://creativecommons.org/publicdomain/zero/1.0/",
    )
    document = ReviewDocument(
        id="synthetic-doc",
        release_id=release.id,
        source_id=source.id,
        source_url="https://example.com/synthetic/doc",
        title=title,
        author=None,
        published_at=None,
        score=None,
        score_scale=None,
        public_excerpt="A synthetic excerpt.",
        content=None,
        license_id=policy.license_id,
        license_url=policy.license_url,
        policy=policy,
    )
    summary = Summary(
        locale="zh-CN",
        model="synthetic-model",
        prompt_version="synthetic-v1",
        generated_at=datetime(2026, 1, 1, tzinfo=UTC),
        corpus_hash="synthetic-corpus",
        claims=[CitedClaim(text=claim_text, source_ids=["synthetic-doc"])],
    )
    return IngestedContext(
        release=release,
        artist=artist,
        sources=[source],
        review_documents=[document],
        genres=[],
        summaries=[summary],
    )


def test_insert_only_seed_does_not_overwrite_existing_records() -> None:
    first = _synthetic_context("Synthetic Release v1", "claim v1")
    second = _synthetic_context("Synthetic Release v2", "claim v2")

    artist_id = _sid("artist", "synthetic-artist")
    source_id = _sid("source", "synthetic-source")
    release_id = _sid("release", "synthetic-release")
    summary_run_id = _sid("summary", "synthetic-release::source::unscoped::")

    with connect() as conn:
        skip_unless_test_db(conn)
        seed(conn, first, overwrite=False)
        written = seed(conn, second, overwrite=False)
        assert written == 0
        title = conn.execute(
            "SELECT title FROM public.releases WHERE id = %s", (release_id,)
        ).fetchone()[0]
        assert title == "Synthetic Release v1"
        claim_text = conn.execute(
            "SELECT claim_text FROM public.claims WHERE summary_run_id = %s ORDER BY claim_order",
            (summary_run_id,),
        ).fetchone()[0]
        assert claim_text == "claim v1"

    with connect() as conn:
        cleanup(conn, artist_id=artist_id, source_id=source_id)
