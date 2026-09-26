"""Budget behavior at the live model-call boundary, without network or DB."""

from __future__ import annotations

import pytest

from linerfy_ingest import worker
from linerfy_ingest.providers import ChatResult, ModelProviderError, TokenUsage


class _Ledger:
    def __init__(self) -> None:
        self.events: list[str] = []
        self.expired = 0
        self.reserved: list[str] = []
        self.released: list[str] = []
        self.settled: list[str] = []

    def expire_stale(self):
        self.events.append("expire")
        self.expired += 1
        return 0

    def reserve(self, *, request_id, **kwargs):
        self.events.append("reserve")
        self.reserved.append(request_id)

    def release(self, *, request_id):
        self.events.append("release")
        self.released.append(request_id)

    def settle(self, *, request_id, **kwargs):
        self.events.append("settle")
        self.settled.append(request_id)


class _Provider:
    model = "deepseek-chat"

    def __init__(self, result=None, error=None) -> None:
        self.result = result
        self.error = error

    def chat(self, messages):
        if self.error is not None:
            raise self.error
        return self.result


def _chat(monkeypatch, ledger, provider):
    monkeypatch.setattr(worker, "_resolve_model", lambda: provider)
    monkeypatch.setattr(worker, "build_handlers", lambda deps: deps)
    deps = worker.build_worker_handlers(budget=ledger)
    return deps.chat


def test_definitely_unbilled_failure_releases_reservation(monkeypatch) -> None:
    ledger = _Ledger()
    provider = _Provider(
        error=ModelProviderError(
            "http_401",
            retryable=False,
            billing_uncertain=False,
            status_code=401,
        )
    )

    with pytest.raises(ModelProviderError):
        _chat(monkeypatch, ledger, provider)([{"role": "user", "content": "x"}])

    assert ledger.released == ledger.reserved
    assert ledger.settled == []


def test_ambiguous_failure_keeps_reservation_until_expiry(monkeypatch) -> None:
    ledger = _Ledger()
    provider = _Provider(
        error=ModelProviderError(
            "http_503",
            retryable=True,
            billing_uncertain=True,
            status_code=503,
        )
    )

    with pytest.raises(ModelProviderError):
        _chat(monkeypatch, ledger, provider)([{"role": "user", "content": "x"}])

    assert len(ledger.reserved) == 1
    assert ledger.released == []
    assert ledger.settled == []


def test_success_settles_reservation(monkeypatch) -> None:
    ledger = _Ledger()
    provider = _Provider(
        result=ChatResult(
            content='{"claims": []}',
            finish_reason="stop",
            usage=TokenUsage(input=2, output=3),
        )
    )

    result = _chat(monkeypatch, ledger, provider)([{"role": "user", "content": "x"}])

    assert result.finish_reason == "stop"
    assert ledger.settled == ledger.reserved
    assert ledger.released == []


def test_each_model_call_expires_stale_reservations_before_reserving(monkeypatch) -> None:
    ledger = _Ledger()
    provider = _Provider(
        result=ChatResult(
            content='{"claims": []}',
            finish_reason="stop",
            usage=TokenUsage(input=2, output=3),
        )
    )
    chat = _chat(monkeypatch, ledger, provider)

    chat([{"role": "user", "content": "first"}])
    chat([{"role": "user", "content": "second"}])

    assert ledger.expired == 2
    assert ledger.events == [
        "expire",
        "reserve",
        "settle",
        "expire",
        "reserve",
        "settle",
    ]
