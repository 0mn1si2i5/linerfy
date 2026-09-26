"""The worker's log/error boundary: category only, secrets never leak.

The default error path must log only a job / stage / error-category /
correlation-id, and must never write a request body, token, key, or full
traceback into the durable ``last_error`` field or the worker log. The full
traceback is opt-in via ``LINERFY_DEBUG_TRACEBACK=1``.
"""

from __future__ import annotations

from linerfy_ingest.jobs import EnrichmentJob, error_label, run_job
from linerfy_ingest.providers import ModelProviderError
from linerfy_ingest.summarize import SummaryError

_SECRET = "SECRET_TOKEN_abc123"


class _FakeStore:
    def __init__(self) -> None:
        self.failed: list[tuple[str, str, str, bool]] = []

    def fail(self, job_id: str, lease_id: str, error: str, *, retryable: bool = True) -> None:
        self.failed.append((job_id, lease_id, error, retryable))

    def commit(self, job_id: str, lease_id: str, *, stage, state) -> None:
        pass


def _boom(job: EnrichmentJob, lease_id: str) -> bool:
    raise ValueError(f"model returned {_SECRET} in the request body")


def test_error_label_default_is_category_only() -> None:
    exc = ValueError(f"body contained {_SECRET}")
    label = error_label(exc)
    assert label == "ValueError"
    assert _SECRET not in label
    assert "Traceback" not in label


def test_error_label_debug_opts_into_traceback(monkeypatch) -> None:
    monkeypatch.setenv("LINERFY_DEBUG_TRACEBACK", "1")
    try:
        raise ValueError(f"body contained {_SECRET}")
    except ValueError as exc:
        label = error_label(exc)
    assert "Traceback" in label
    assert "ValueError" in label
    assert _SECRET in label  # opt-in debugging includes the message


def test_error_label_uses_summary_error_category() -> None:
    # A summarization failure records its static category, not a bare ValueError,
    # so the operator can tell invalid_json / truncated / count / reference apart.
    assert error_label(SummaryError("invalid_claim_count", "got=1")) == (
        "SummaryError:invalid_claim_count"
    )


def test_summary_error_label_drops_the_detail() -> None:
    # `detail` may carry a sensitive value; the durable label must not include it.
    exc = SummaryError("invalid_reference", f"count=1 {_SECRET}")
    label = error_label(exc)
    assert label == "SummaryError:invalid_reference"
    assert _SECRET not in label


def test_run_job_logs_category_and_correlation_not_the_secret(capsys) -> None:
    job = EnrichmentJob(
        id="job-1",
        entity_id="corr-123",
        stage="build_source_summaries",
        state="running",
    )
    store = _FakeStore()
    run_job(job, "lease-1", {"build_source_summaries": _boom}, store)

    # The durable last_error carries the category, never the secret.
    assert store.failed == [("job-1", "lease-1", "ValueError", True)]

    # The default worker log is job / stage / category / correlation id only.
    captured = capsys.readouterr()
    assert _SECRET not in captured.err
    assert _SECRET not in captured.out
    assert "corr-123" in captured.err
    assert "build_source_summaries" in captured.err
    assert "ValueError" in captured.err


def test_provider_error_logs_safe_category_and_request_id(capsys) -> None:
    secret = "SECRET_RESPONSE_BODY"

    def fail_provider(job: EnrichmentJob, lease_id: str) -> bool:
        exc = ModelProviderError(
            "http_401",
            retryable=False,
            billing_uncertain=False,
            status_code=401,
            request_id="req-safe-123",
        )
        exc.__notes__ = [secret]
        raise exc

    job = EnrichmentJob(
        id="job-2",
        entity_id="corr-456",
        stage="build_source_summaries",
        state="running",
    )
    store = _FakeStore()
    run_job(job, "lease-2", {"build_source_summaries": fail_provider}, store)

    assert store.failed == [("job-2", "lease-2", "ModelProviderError:http_401", False)]
    captured = capsys.readouterr()
    assert "ModelProviderError:http_401" in captured.err
    assert "provider_request_id req-safe-123" in captured.err
    assert secret not in captured.err
