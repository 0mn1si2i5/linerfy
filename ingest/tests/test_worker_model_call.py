"""Focused checks for the direct model-call boundary."""

from __future__ import annotations

import pytest

from linerfy_ingest import worker
from linerfy_ingest.providers import ChatResult, ModelConfigurationError, TokenUsage


class _Provider:
    model = "deepseek-chat"

    def __init__(self) -> None:
        self.calls = 0

    def chat(self, messages):
        self.calls += 1
        return ChatResult(
            content='{"claims": []}',
            finish_reason="stop",
            usage=TokenUsage(input=3, output=2),
        )


def _direct_chat(monkeypatch: pytest.MonkeyPatch, provider: _Provider):
    monkeypatch.setattr(worker, "_resolve_model", lambda: provider)
    monkeypatch.setattr(worker, "build_handlers", lambda deps: deps)
    return worker.build_worker_handlers().chat


def test_model_call_goes_directly_to_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    provider = _Provider()
    result = _direct_chat(monkeypatch, provider)(
        [{"role": "user", "content": "test"}]
    )

    assert result.finish_reason == "stop"
    assert result.usage == TokenUsage(input=3, output=2)
    assert provider.calls == 1


def test_model_configuration_error_stops_before_provider_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        worker,
        "_resolve_model",
        lambda: (_ for _ in ()).throw(ModelConfigurationError("missing_api_key")),
    )
    monkeypatch.setattr(worker, "build_handlers", lambda deps: deps)
    chat = worker.build_worker_handlers().chat

    with pytest.raises(ModelConfigurationError, match="missing_api_key"):
        chat([{"role": "user", "content": "test"}])
