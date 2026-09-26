"""Persistent enrichment job lifecycle with short, atomic leases.

An enrichment job walks a release through four idempotent stages --
``resolve_entity -> fetch_sources -> build_source_summaries -> build_consensus``.
A worker performs external HTTP and model work OUTSIDE any database transaction,
so the job row is never locked across a network call.

Claiming writes a fresh ``lease_id`` + ``lease_expires_at`` in one short
transaction; committing a result is a compare-and-set on ``(id, lease_id)``, so
a stale worker whose lease was reaped can never overwrite a newer claim. Jobs
are claimed with ``FOR UPDATE SKIP LOCKED`` so concurrent workers never process
the same row, retried at most ``MAX_RETRIES`` times, and model stages are gated
behind a global pause flag.
"""

from __future__ import annotations

import os
import re
import sys
import time
import traceback
import uuid
from contextlib import suppress
from dataclasses import dataclass
from typing import Literal, Protocol

import psycopg
from pydantic import BaseModel, Field

from .db import connect

Stage = Literal[
    "resolve_entity",
    "fetch_sources",
    "build_source_summaries",
    "build_consensus",
]
JobState = Literal["queued", "running", "ready", "unavailable", "failed"]

STAGES: tuple[Stage, ...] = (
    "resolve_entity",
    "fetch_sources",
    "build_source_summaries",
    "build_consensus",
)
# Stages that invoke a model; paused while the global model-generation flag is on.
MODEL_STAGES: frozenset[Stage] = frozenset(
    {"build_source_summaries", "build_consensus"}
)
MAX_RETRIES = 2
LEASE_SECONDS = 120
PAUSE_FLAG = "model_generation_paused"
_SAFE_REQUEST_ID = re.compile(r"[A-Za-z0-9._:-]{1,128}")


class EnrichmentJob(BaseModel):
    """A single release's position in the enrichment pipeline.

    ``entity_id`` holds the request fingerprint (the dedup key); ``payload``
    holds the bounded, untrusted now-playing metadata; ``resolved_release_group_id``
    and ``resolution_status`` are filled by ``resolve_entity``.
    """

    model_config = {"extra": "forbid"}

    id: str = Field(min_length=1)
    entity_id: str = Field(min_length=1)
    stage: Stage
    state: JobState
    retry_count: int = Field(default=0, ge=0)
    last_error: str | None = None
    corpus_hash: str | None = None
    payload: dict = Field(default_factory=dict)
    resolved_release_group_id: str | None = None
    resolution_status: str = "pending"


@dataclass(frozen=True)
class ClaimedJob:
    """A job plus the fresh lease that owns it, needed for compare-and-set."""

    job: EnrichmentJob
    lease_id: str


class StaleLease(Exception):
    """A commit was refused because the lease no longer matches the row."""


def error_label(exc: BaseException) -> str:
    """A safe, non-sensitive error label for the default error path.

    Returns only the exception type name (the error category), so a request
    body, token, key, or full traceback never reaches the durable ``last_error``
    field or the default worker log. A domain exception that carries a static
    ``category`` (e.g. ``SummaryError``) is labelled ``Type:category`` so an
    operator can distinguish the actual failure instead of seeing a bare
    ``ValueError``. Set ``LINERFY_DEBUG_TRACEBACK=1`` to opt into the full
    traceback for local debugging.
    """
    if os.environ.get("LINERFY_DEBUG_TRACEBACK") == "1":
        return "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
    category = getattr(exc, "category", None)
    if isinstance(category, str) and category:
        return f"{type(exc).__name__}:{category}"
    return type(exc).__name__


class JobUnavailable(Exception):
    """Raised by a stage to mark a job terminally unavailable (no retry)."""


# The single "active lease" invariant: a worker may only write results for a job
# it still owns, while the job is running, and before the lease has expired. A
# stale worker whose lease was reaped must fail the CAS just like a wrong id or
# lease id. Every job mutation and every summary publish shares this predicate.
_ACTIVE_LEASE_PREDICATE = "state = 'running' AND lease_expires_at > now()"


def assert_active_lease(conn: psycopg.Connection, job_id: str, lease_id: str) -> None:
    """Raise ``StaleLease`` unless the job is running under an unexpired lease.

    Used at the start of a write transaction (e.g. seeding review documents or
    publishing a summary) so an expired worker can neither overwrite the corpus
    nor publish a summary. ``FOR UPDATE`` locks the job row for the rest of the
    transaction, so a concurrent reaper cannot take over the lease between this
    check and the caller's commit: the reaper's ``UPDATE`` blocks until this
    transaction finishes. The write that follows re-checks the same predicate in
    its own WHERE clause, so this guard is an early-out and the lock is the fence.
    """
    row = conn.execute(
        "SELECT 1 FROM public.enrichment_jobs "
        "WHERE id = %s AND lease_id = %s AND " + _ACTIVE_LEASE_PREDICATE
        + " FOR UPDATE",
        (job_id, lease_id),
    ).fetchone()
    if row is None:
        raise StaleLease("lease is not active; refusing to write")


def record_corpus_hash(
    conn: psycopg.Connection, job_id: str, lease_id: str, corpus_hash: str
) -> None:
    """Update the job's corpus hash on an already-open transaction.

    Shares the active-lease predicate with the other job mutations, so an
    expired worker can neither seed the corpus it fetched nor record it. The
    caller opens the transaction and commits it; this only mutates the row.
    """
    cursor = conn.execute(
        "UPDATE public.enrichment_jobs SET corpus_hash = %s, updated_at = now() "
        "WHERE id = %s AND lease_id = %s AND " + _ACTIVE_LEASE_PREDICATE,
        (corpus_hash, job_id, lease_id),
    )
    if cursor.rowcount == 0:
        raise StaleLease("lease is not active; refusing to record corpus")


class JobStore(Protocol):
    """Queue operations the worker performs, each a short transaction."""

    def paused(self) -> bool: ...

    def reap_and_claim(
        self, *, skip_model_stages: bool = False
    ) -> ClaimedJob | None: ...

    def commit(
        self,
        job_id: str,
        lease_id: str,
        *,
        stage: Stage | None,
        state: JobState,
    ) -> None: ...

    def renew(self, job_id: str, lease_id: str) -> None: ...

    def fail(self, job_id: str, lease_id: str, error: str, *, retryable: bool = True) -> None: ...

    def set_resolution(
        self, job_id: str, lease_id: str, release_group_id: str | None, status: str
    ) -> None: ...


class StageHandler(Protocol):
    """One pipeline stage; raising marks the job failed (and retryable)."""

    def __call__(self, job: EnrichmentJob, lease_id: str) -> None: ...


def next_stage(stage: Stage) -> Stage | None:
    """The stage after ``stage``, or None at the end of the pipeline."""
    index = STAGES.index(stage)
    return STAGES[index + 1] if index + 1 < len(STAGES) else None


def run_job(
    job: EnrichmentJob,
    lease_id: str,
    handlers: dict[Stage, StageHandler],
    store: JobStore,
) -> None:
    """Run a claimed job's current stage and advance it, idempotently."""
    handler = handlers.get(job.stage)
    if handler is None:
        _fail(
            store,
            job.id,
            lease_id,
            f"no handler for stage {job.stage}",
            retryable=False,
        )
        return
    started = time.monotonic()
    try:
        advance = handler(job, lease_id)
    except JobUnavailable:
        _log_stage(job, started, "unavailable")
        _commit(store, job.id, lease_id, stage=None, state="unavailable")
        return
    except StaleLease:
        _log_stage(job, started, "stale")
        return  # another worker took over this job; do nothing
    except Exception as exc:  # the job boundary absorbs stage errors for retry
        # Log only job / stage / error category / correlation id. The full
        # message or traceback is opt-in (LINERFY_DEBUG_TRACEBACK=1) so a
        # request body, token, or key never reaches the default log.
        label = error_label(exc)
        raw_request_id = getattr(exc, "request_id", None)
        request_id = (
            raw_request_id
            if isinstance(raw_request_id, str) and _SAFE_REQUEST_ID.fullmatch(raw_request_id)
            else None
        )
        request_context = f" provider_request_id {request_id}" if request_id else ""
        print(
            f"job {job.entity_id} stage {job.stage} error {label}{request_context}",
            file=sys.stderr,
        )
        _log_stage(job, started, "failed")
        retryable = getattr(exc, "retryable", True)
        _fail(
            store,
            job.id,
            lease_id,
            label,
            retryable=retryable if isinstance(retryable, bool) else True,
        )
        return
    if not advance:
        _log_stage(job, started, "requeued")
        return  # the handler re-queued itself; do not advance again
    _log_stage(job, started, "advanced")
    following = next_stage(job.stage)
    _commit(
        store,
        job.id,
        lease_id,
        stage=following,
        state="ready" if following is None else "queued",
    )


def _log_stage(job: EnrichmentJob, started: float, result: str) -> None:
    """Emit one stage-timing line: stage, elapsed ms, job id, result category.

    Deliberately no body, prompt, token, or secret — only the correlation ids and
    a coarse outcome, so a stage's cost is observable without leaking content.
    """
    elapsed_ms = int((time.monotonic() - started) * 1000)
    print(
        f"job {job.id} stage {job.stage} result {result} ms {elapsed_ms}",
        file=sys.stderr,
    )


def _commit(store: JobStore, job_id: str, lease_id: str, *, stage, state) -> None:
    # A stale commit is not a failure: a newer claim owns this job now.
    with suppress(StaleLease):
        store.commit(job_id, lease_id, stage=stage, state=state)


def _fail(
    store: JobStore,
    job_id: str,
    lease_id: str,
    error: str,
    *,
    retryable: bool = True,
) -> None:
    # A stale fail is not a failure: a newer claim owns this job now.
    with suppress(StaleLease):
        store.fail(job_id, lease_id, error, retryable=retryable)


def run_once(store: JobStore, handlers: dict[Stage, StageHandler]) -> int:
    """One worker tick: reap timeouts, then process at most one job."""
    claimed = store.reap_and_claim(skip_model_stages=store.paused())
    if claimed is None:
        return 0
    run_job(claimed.job, claimed.lease_id, handlers, store)
    return 1


def run_batch(
    store: JobStore, handlers: dict[Stage, StageHandler], *, max_steps: int
) -> int:
    """Advance a small bounded batch, stopping as soon as the queue is idle."""
    processed = 0
    for _ in range(max_steps):
        advanced = run_once(store, handlers)
        if not advanced:
            break
        processed += advanced
    return processed


class PostgresJobStore:
    """Job queue backed by ``enrichment_jobs``; each op is a short transaction."""

    def __init__(self, *, lease_seconds: int = LEASE_SECONDS) -> None:
        self.lease_seconds = lease_seconds

    def paused(self) -> bool:
        with connect() as conn:
            row = conn.execute(
                "SELECT value FROM public.service_flags WHERE key = %s",
                (PAUSE_FLAG,),
            ).fetchone()
            return row is not None and row[0] == "true"

    def reap_and_claim(self, *, skip_model_stages: bool = False) -> ClaimedJob | None:
        with connect(autocommit=False) as conn:
            self._reap(conn)
            claimed = self._claim(conn, skip_model_stages)
            conn.commit()
            return claimed

    def _reap(self, conn: psycopg.Connection) -> None:
        """Expire leases past their deadline, atomically with the next claim."""
        conn.execute(
            "UPDATE public.enrichment_jobs SET retry_count = retry_count + 1, "
            "state = CASE WHEN retry_count < %s THEN 'queued' ELSE 'failed' END, "
            "last_error = 'lease expired', lease_id = NULL, lease_expires_at = NULL, "
            "updated_at = now() "
            "WHERE state = 'running' AND lease_expires_at < now()",
            (MAX_RETRIES,),
        )

    def _claim(
        self, conn: psycopg.Connection, skip_model_stages: bool
    ) -> ClaimedJob | None:
        stage_filter = ""
        if skip_model_stages:
            stage_filter = (
                "AND j.stage NOT IN ('build_source_summaries','build_consensus')"
            )
        row = conn.execute(
            "SELECT id, entity_id, stage, retry_count, last_error, corpus_hash, "
            "payload, resolved_release_group_id, resolution_status "
            "FROM public.enrichment_jobs j "
            f"WHERE j.state = 'queued' {stage_filter} "
            # Linerfy serves the album currently playing. Prioritize the newest
            # request and keep advancing it across ticks; older work resumes
            # when no newer album is waiting.
            "ORDER BY j.created_at DESC FOR UPDATE SKIP LOCKED LIMIT 1"
        ).fetchone()
        if row is None:
            return None
        lease_id = str(uuid.uuid4())
        conn.execute(
            "UPDATE public.enrichment_jobs SET state = 'running', "
            "lease_id = %s, lease_expires_at = now() + make_interval(secs => %s), "
            "attempt = attempt + 1, updated_at = now() WHERE id = %s",
            (lease_id, self.lease_seconds, row[0]),
        )
        return ClaimedJob(
            job=EnrichmentJob(
                id=str(row[0]),
                entity_id=row[1],
                stage=row[2],
                state="running",
                retry_count=row[3],
                last_error=row[4],
                corpus_hash=row[5],
                payload=row[6] or {},
                resolved_release_group_id=row[7],
                resolution_status=row[8] or "pending",
            ),
            lease_id=lease_id,
        )

    def _assert_cas(self, cursor: psycopg.Cursor) -> None:
        if cursor.rowcount == 0:
            raise StaleLease("lease no longer matches; refusing to commit")

    def commit(
        self,
        job_id: str,
        lease_id: str,
        *,
        stage: Stage | None,
        state: JobState,
    ) -> None:
        with connect(autocommit=False) as conn:
            cursor = conn.execute(
                "UPDATE public.enrichment_jobs SET stage = COALESCE(%s, stage), "
                "state = %s, lease_id = NULL, lease_expires_at = NULL, "
                "last_error = NULL, updated_at = now() "
                "WHERE id = %s AND lease_id = %s AND " + _ACTIVE_LEASE_PREDICATE,
                (stage, state, job_id, lease_id),
            )
            self._assert_cas(cursor)
            conn.commit()

    def renew(self, job_id: str, lease_id: str) -> None:
        """Extend the lease deadline, guarded by compare-and-set on the lease.

        A stage that spends a long time outside the database (an HTTP fetch or a
        model call) renews before that work so a concurrent reaper cannot take
        the job mid-stage. A stale worker's renew is refused just like a commit.
        """
        with connect(autocommit=False) as conn:
            cursor = conn.execute(
                "UPDATE public.enrichment_jobs SET "
                "lease_expires_at = now() + make_interval(secs => %s), "
                "updated_at = now() WHERE id = %s AND lease_id = %s AND " + _ACTIVE_LEASE_PREDICATE,
                (self.lease_seconds, job_id, lease_id),
            )
            self._assert_cas(cursor)
            conn.commit()

    def fail(self, job_id: str, lease_id: str, error: str, *, retryable: bool = True) -> None:
        with connect(autocommit=False) as conn:
            cursor = conn.execute(
                "UPDATE public.enrichment_jobs SET retry_count = retry_count + 1, "
                "state = CASE WHEN %s AND retry_count < %s THEN 'queued' ELSE 'failed' END, "
                "last_error = %s, lease_id = NULL, lease_expires_at = NULL, "
                "updated_at = now() WHERE id = %s AND lease_id = %s AND " + _ACTIVE_LEASE_PREDICATE,
                (retryable, MAX_RETRIES, error, job_id, lease_id),
            )
            self._assert_cas(cursor)
            conn.commit()

    def set_resolution(
        self, job_id: str, lease_id: str, release_group_id: str | None, status: str
    ) -> None:
        with connect(autocommit=False) as conn:
            cursor = conn.execute(
                "UPDATE public.enrichment_jobs SET resolved_release_group_id = %s, "
                "resolution_status = %s, updated_at = now() "
                "WHERE id = %s AND lease_id = %s AND " + _ACTIVE_LEASE_PREDICATE,
                (release_group_id, status, job_id, lease_id),
            )
            self._assert_cas(cursor)
            conn.commit()
