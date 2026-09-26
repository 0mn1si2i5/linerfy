"""Fixture-based tests for the two model provider protocols, no network."""

from __future__ import annotations

import http.client
import io
import json
import urllib.error

import pytest

from linerfy_ingest.providers import (
    AnthropicProvider,
    ModelConfig,
    ModelConfigurationError,
    ModelProviderError,
    OpenAICompatibleProvider,
    _normalize_anthropic_stop_reason,
    resolve_provider,
)

_MESSAGES = [
    {"role": "system", "content": "you are a summarizer"},
    {"role": "user", "content": "summarize this"},
]


class _FakeOpenAI(OpenAICompatibleProvider):
    def __init__(self, payload: dict):
        super().__init__("https://api.deepseek.com", "deepseek-chat", "sk-test")
        self.payload = payload
        self.sent: tuple[str, dict, dict] | None = None

    def _post_json(self, url, headers, body):
        self.sent = (url, headers, json.loads(body))
        return self.payload


class _FakeAnthropic(AnthropicProvider):
    def __init__(self, payload: dict):
        super().__init__("claude-sonnet-5", "sk-ant-test")
        self.payload = payload
        self.sent: tuple[str, dict, dict] | None = None

    def _post_json(self, url, headers, body):
        self.sent = (url, headers, json.loads(body))
        return self.payload


def test_openai_provider_builds_chat_completions_request() -> None:
    provider = _FakeOpenAI(
        {
            "choices": [
                {
                    "message": {"content": '{"claims": []}'},
                    "finish_reason": "stop",
                }
            ],
            "usage": {"prompt_tokens": 100, "completion_tokens": 23},
        }
    )
    result = provider.chat(_MESSAGES)

    url, headers, body = provider.sent
    assert url == "https://api.deepseek.com/chat/completions"
    assert headers["Authorization"] == "Bearer sk-test"
    assert body["model"] == "deepseek-chat"
    assert body["response_format"] == {"type": "json_object"}
    assert body["max_tokens"] == 2048
    assert body["messages"] == _MESSAGES

    assert result.content == '{"claims": []}'
    assert result.finish_reason == "stop"
    assert result.usage.input == 100
    assert result.usage.output == 23


def test_openai_provider_reports_length_truncation() -> None:
    provider = _FakeOpenAI(
        {
            "choices": [{"message": {"content": "x"}, "finish_reason": "length"}],
            "usage": {},
        }
    )
    result = provider.chat(_MESSAGES)
    assert result.finish_reason == "length"
    assert result.usage.input == 0
    assert result.usage.output == 0


def test_anthropic_provider_splits_system_and_maps_stop_reason() -> None:
    provider = _FakeAnthropic(
        {
            "content": [{"type": "text", "text": '{"claims": []}'}],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 10, "output_tokens": 20},
        }
    )
    result = provider.chat(_MESSAGES)

    url, headers, body = provider.sent
    assert url == "https://api.anthropic.com/v1/messages"
    assert headers["x-api-key"] == "sk-ant-test"
    assert headers["anthropic-version"] == "2023-06-01"
    assert body["system"] == "you are a summarizer"
    assert body["messages"] == [{"role": "user", "content": "summarize this"}]

    assert result.content == '{"claims": []}'
    assert result.finish_reason == "stop"
    assert result.usage.input == 10
    assert result.usage.output == 20


def test_anthropic_provider_maps_max_tokens_to_length() -> None:
    provider = _FakeAnthropic(
        {"content": [{"type": "text", "text": "cut"}], "stop_reason": "max_tokens"}
    )
    result = provider.chat(_MESSAGES)
    assert result.finish_reason == "length"


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"choices": []},
        {"choices": [{}]},
        {"choices": [{"message": {}}]},
        {"choices": [{"message": {"content": 42}}]},
        {
            "choices": [{"message": {"content": "{}"}}],
            "usage": {"prompt_tokens_details": []},
        },
    ],
)
def test_openai_provider_rejects_missing_or_malformed_response_fields(payload) -> None:
    provider = _FakeOpenAI(payload)

    with pytest.raises(ModelProviderError) as raised:
        provider.chat(_MESSAGES)

    error = raised.value
    assert error.category == "invalid_response"
    assert error.retryable is True


@pytest.mark.parametrize(
    "payload",
    [
        {"stop_reason": "end_turn", "usage": {}},
        {"content": [{}], "stop_reason": "end_turn", "usage": {}},
        {"content": [{"text": 42}], "stop_reason": "end_turn", "usage": {}},
        {"content": [], "stop_reason": 42, "usage": {}},
        {"content": [], "stop_reason": "end_turn", "usage": []},
    ],
)
def test_anthropic_provider_rejects_missing_or_malformed_response_fields(payload) -> None:
    provider = _FakeAnthropic(payload)

    with pytest.raises(ModelProviderError) as raised:
        provider.chat(_MESSAGES)

    error = raised.value
    assert error.category == "invalid_response"
    assert error.retryable is True


def test_normalize_anthropic_stop_reason() -> None:
    assert _normalize_anthropic_stop_reason("end_turn") == "stop"
    assert _normalize_anthropic_stop_reason("max_tokens") == "length"
    assert _normalize_anthropic_stop_reason("stop_sequence") == "stop_sequence"


def test_resolve_provider_picks_openai_compatible_by_default() -> None:
    provider = resolve_provider(
        ModelConfig(protocol="openai-compatible", model="m", api_key="k")
    )
    assert isinstance(provider, OpenAICompatibleProvider)
    assert provider.base_url == "https://api.deepseek.com"


def test_resolve_provider_picks_anthropic() -> None:
    provider = resolve_provider(
        ModelConfig(protocol="anthropic", model="claude-sonnet-5", api_key="k")
    )
    assert isinstance(provider, AnthropicProvider)
    assert provider.model == "claude-sonnet-5"


def test_resolve_provider_uses_custom_openai_base_url() -> None:
    provider = resolve_provider(
        ModelConfig(
            protocol="openai-compatible",
            model="gpt-5",
            api_key="k",
            base_url="https://api.openai.com/v1",
        )
    )
    assert isinstance(provider, OpenAICompatibleProvider)
    assert provider.base_url == "https://api.openai.com/v1"
    assert provider.model == "gpt-5"


@pytest.mark.parametrize(
    ("status", "retryable"),
    [
        (400, False),
        (401, False),
        (429, True),
        (503, True),
    ],
)
def test_provider_classifies_http_errors_without_reading_body(
    monkeypatch, status, retryable
) -> None:
    secret = b"SECRET_PROVIDER_RESPONSE"

    def fail_request(*args, **kwargs):
        raise urllib.error.HTTPError(
            "https://api.deepseek.com/chat/completions",
            status,
            "sensitive reason",
            {"x-request-id": "req-safe-123"},
            io.BytesIO(secret),
        )

    monkeypatch.setattr("urllib.request.urlopen", fail_request)
    provider = OpenAICompatibleProvider("https://api.deepseek.com", "deepseek-chat", "sk-secret")

    with pytest.raises(ModelProviderError) as raised:
        provider.chat(_MESSAGES)

    error = raised.value
    assert error.category == f"http_{status}"
    assert error.status_code == status
    assert error.request_id == "req-safe-123"
    assert error.retryable is retryable
    assert secret.decode() not in str(error)
    assert "sensitive reason" not in str(error)


def test_provider_rejects_unsafe_request_id(monkeypatch) -> None:
    def fail_request(*args, **kwargs):
        raise urllib.error.HTTPError(
            "https://api.deepseek.com/chat/completions",
            401,
            "unauthorized",
            {"x-request-id": "unsafe request id"},
            io.BytesIO(b"secret"),
        )

    monkeypatch.setattr("urllib.request.urlopen", fail_request)
    provider = OpenAICompatibleProvider("https://api.deepseek.com", "deepseek-chat", "sk-secret")

    with pytest.raises(ModelProviderError) as raised:
        provider.chat(_MESSAGES)

    assert raised.value.request_id is None

    direct = ModelProviderError(
        "http_401",
        retryable=False,
        request_id="unsafe\nlog entry",
    )
    assert direct.request_id is None


def test_provider_classifies_transport_errors(monkeypatch) -> None:
    def fail_request(*args, **kwargs):
        raise urllib.error.URLError("SECRET_NETWORK_DETAIL")

    monkeypatch.setattr("urllib.request.urlopen", fail_request)
    provider = OpenAICompatibleProvider("https://api.deepseek.com", "deepseek-chat", "sk-secret")

    with pytest.raises(ModelProviderError) as raised:
        provider.chat(_MESSAGES)

    error = raised.value
    assert error.category == "transport_error"
    assert error.retryable is True
    assert "SECRET_NETWORK_DETAIL" not in str(error)


def test_provider_classifies_incomplete_response_read_as_transport_error(
    monkeypatch,
) -> None:
    class IncompleteResponse:
        headers = {"x-request-id": "req-incomplete-123"}

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def read(self):
            raise http.client.IncompleteRead(b"SECRET_PARTIAL_RESPONSE", 100)

    monkeypatch.setattr("urllib.request.urlopen", lambda *args, **kwargs: IncompleteResponse())
    provider = OpenAICompatibleProvider("https://api.deepseek.com", "deepseek-chat", "sk-secret")

    with pytest.raises(ModelProviderError) as raised:
        provider.chat(_MESSAGES)

    error = raised.value
    assert error.category == "transport_error"
    assert error.retryable is True
    assert "SECRET_PARTIAL_RESPONSE" not in str(error)


@pytest.mark.parametrize(
    "config,category",
    [
        (ModelConfig(protocol="openai-compatible", model="m", api_key=""), "missing_api_key"),
        (ModelConfig(protocol="unknown", model="m", api_key="k"), "unsupported_protocol"),
    ],
)
def test_resolve_provider_rejects_invalid_configuration(config, category) -> None:
    with pytest.raises(ModelConfigurationError) as raised:
        resolve_provider(config)
    assert raised.value.category == category
    assert raised.value.retryable is False
