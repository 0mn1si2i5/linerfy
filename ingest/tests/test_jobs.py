"""Tests for the enrichment job lifecycle state machine, no database."""

from __future__ import annotations

from linerfy_ingest.jobs import (
    ClaimedJob,
    EnrichmentJob,
    StaleLease,
    next_stage,
    run_batch,
    run_job,
    run_once,
)


class FakeStore:
    def __init__(self, jobs=None, *, paused=False, stale_commit=False):
        self.jobs = list(jobs or [])
        self.paused_flag = paused
        self.stale_commit = stale_commit
        self.reaped = 0
        self.claim_skips: list[bool] = []
        self.actions: list[tuple] = []

    def paused(self) -> bool:
        return self.paused_flag

    def reap_and_claim(self, *, skip_model_stages=False):
        self.reaped += 1
        self.claim_skips.append(skip_model_stages)
        if not self.jobs:
            return None
        return ClaimedJob(job=self.jobs.pop(0), lease_id="lease-1")

    def commit(self, job_id, lease_id, *, stage, state):
        if self.stale_commit:
            raise StaleLease("stale")
        self.actions.append(("commit", stage, state))

    def fail(self, job_id, lease_id, error, *, retryable=True):
        self.actions.append(("fail", error, retryable))

    def set_resolution(self, job_id, lease_id, release_group_id, status):
        self.actions.append(("resolution", release_group_id, status))


def _job(stage, retry_count=0):
    return EnrichmentJob(
        id="j1", entity_id="nfr", stage=stage, state="running", retry_count=retry_count
    )


def test_next_stage_walks_the_pipeline() -> None:
    assert next_stage("resolve_entity") == "fetch_sources"
    assert next_stage("build_source_summaries") == "build_consensus"
    assert next_stage("build_consensus") is None


def test_run_job_advances_to_next_stage() -> None:
    store = FakeStore()
    run_job(_job("resolve_entity"), "lease-1", {"resolve_entity": lambda j, lease: True}, store)
    assert store.actions == [("commit", "fetch_sources", "queued")]


def test_run_job_completes_after_build_consensus() -> None:
    store = FakeStore()
    run_job(
        _job("build_consensus"),
        "lease-1",
        {"build_consensus": lambda j, lease: True},
        store,
    )
    assert store.actions == [("commit", None, "ready")]


def test_run_job_does_not_advance_when_handler_requeues() -> None:
    store = FakeStore()
    run_job(
        _job("build_source_summaries"),
        "lease-1",
        {"build_source_summaries": lambda j, lease: False},
        store,
    )
    assert store.actions == []


def test_run_job_fails_when_handler_raises() -> None:
    store = FakeStore()

    def boom(job, lease_id):
        raise RuntimeError("upstream down")

    run_job(_job("fetch_sources"), "lease-1", {"fetch_sources": boom}, store)
    # The error boundary stores the category, not the message, so the default
    # path never leaks a body, token, or key into last_error.
    assert store.actions == [("fail", "RuntimeError", True)]


def test_run_job_drops_an_unsafe_request_id_from_any_exception(capsys) -> None:
    secret = "SECRET_REQUEST_ID"

    class UnsafeRequestError(RuntimeError):
        request_id = f"safe-prefix\n{secret}"

    def boom(job, lease_id):
        raise UnsafeRequestError("provider failed")

    store = FakeStore()
    run_job(_job("build_source_summaries"), "lease-1", {"build_source_summaries": boom}, store)

    assert store.actions == [("fail", "UnsafeRequestError", True)]
    captured = capsys.readouterr()
    assert secret not in captured.err
    assert "provider_request_id" not in captured.err


def test_run_job_fails_without_a_handler() -> None:
    store = FakeStore()
    run_job(_job("resolve_entity"), "lease-1", {}, store)
    assert store.actions == [("fail", "no handler for stage resolve_entity", False)]


def test_run_job_swallows_stale_lease() -> None:
    store = FakeStore(stale_commit=True)
    run_job(_job("resolve_entity"), "lease-1", {"resolve_entity": lambda j, lease: True}, store)
    # A stale commit must not be treated as a stage failure.
    assert store.actions == []


def test_run_once_reaps_then_claims_one_job() -> None:
    store = FakeStore([_job("resolve_entity")])
    processed = run_once(store, {"resolve_entity": lambda j, lease: True})
    assert store.reaped == 1
    assert processed == 1
    assert store.actions == [("commit", "fetch_sources", "queued")]


def test_run_once_skips_model_stages_when_paused() -> None:
    store = FakeStore([_job("resolve_entity")], paused=True)
    run_once(store, {"resolve_entity": lambda j, lease: True})
    assert store.claim_skips == [True]


def test_run_once_is_idle_with_no_jobs() -> None:
    store = FakeStore()
    assert run_once(store, {}) == 0
    assert store.actions == []


def test_run_batch_advances_available_work_until_idle() -> None:
    store = FakeStore([_job("resolve_entity"), _job("resolve_entity")])
    processed = run_batch(
        store, {"resolve_entity": lambda job, lease: True}, max_steps=8
    )
    assert processed == 2
    assert store.reaped == 3  # final idle check stops the bounded loop
