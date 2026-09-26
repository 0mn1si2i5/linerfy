"""Model provider protocol boundaries.

v1 supports exactly two wire protocols:

* OpenAI-compatible chat completions (DeepSeek, OpenAI, and other drop-ins).
* Anthropic Messages (Claude).

Only one provider is active at a time, chosen from configuration. There is no
automatic fallback between providers: if the configured provider errors, that
error surfaces to the caller instead of being silently masked by another
vendor's model.
"""

from __future__ import annotations

import http.client
import json
import re
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Protocol

_ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages"
_ANTHROPIC_VERSION = "2023-06-01"

_DEFAULT_OPENAI_BASE = "https://api.deepseek.com"
_RETRYABLE_HTTP_STATUSES = frozenset({408, 409, 425, 429})
_REQUEST_ID_HEADERS = (
    "x-request-id",
    "request-id",
    "cf-ray",
    "x-amzn-requestid",
)
_SAFE_REQUEST_ID = re.compile(r"[A-Za-z0-9._:-]{1,128}")


class ModelConfigurationError(RuntimeError):
    """Static, non-retryable model configuration failure."""

    retryable = False

    def __init__(self, category: str) -> None:
        super().__init__(category)
        self.category = category


class ModelProviderError(RuntimeError):
    """A provider failure safe to persist and log without its response body."""

    def __init__(
        self,
        category: str,
        *,
        retryable: bool,
        status_code: int | None = None,
        request_id: str | None = None,
    ) -> None:
        super().__init__(category)
        self.category = category
        self.retryable = retryable
        self.status_code = status_code
        self.request_id = _sanitize_request_id(request_id)


def _sanitize_request_id(value: str | None) -> str | None:
    if value and _SAFE_REQUEST_ID.fullmatch(value):
        return value
    return None


def _request_id(headers) -> str | None:
    if headers is None:
        return None
    for name in _REQUEST_ID_HEADERS:
        value = _sanitize_request_id(headers.get(name))
        if value:
            return value
    return None


def _post_json(url: str, headers: dict[str, str], body: bytes) -> dict:
    """POST JSON while exposing only bounded, non-sensitive failure metadata."""
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        status = int(exc.code)
        retryable = status in _RETRYABLE_HTTP_STATUSES or status >= 500
        raise ModelProviderError(
            f"http_{status}",
            retryable=retryable,
            status_code=status,
            request_id=_request_id(exc.headers),
        ) from None
    except (
        urllib.error.URLError,
        TimeoutError,
        ConnectionError,
        http.client.IncompleteRead,
    ):
        raise ModelProviderError(
            "transport_error",
            retryable=True,
        ) from None
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ModelProviderError(
            "invalid_response",
            retryable=True,
            request_id=_request_id(response.headers),
        ) from None
    if not isinstance(payload, dict):
        raise ModelProviderError(
            "invalid_response",
            retryable=True,
            request_id=_request_id(response.headers),
        )
    return payload


def _token_count(value) -> int:
    if value is None:
        return 0
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise TypeError("invalid token count")
    return value


def _invalid_response() -> ModelProviderError:
    return ModelProviderError(
        "invalid_response",
        retryable=True,
    )


@dataclass(frozen=True)
class TokenUsage:
    """Provider-reported token usage retained as response metadata.

    Cache read/write are recorded only when a provider reports them; otherwise
    they stay zero.
    """

    input: int = 0
    output: int = 0
    cache_read: int = 0
    cache_write: int = 0


@dataclass(frozen=True)
class ChatResult:
    """A provider response normalized to a common shape.

    ``finish_reason`` is normalized to ``"stop"`` for a normal end-of-turn and
    ``"length"`` for a truncation, matching what the summarizer already checks.
    ``usage`` carries provider-reported counts for callers that need diagnostics.
    """

    content: str
    finish_reason: str
    usage: TokenUsage = field(default_factory=TokenUsage)


@dataclass(frozen=True)
class ModelConfig:
    """The single active model, resolved from environment by the caller."""

    protocol: str  # "openai-compatible" | "anthropic"
    model: str
    api_key: str
    base_url: str | None = None
    max_tokens: int = 2048


class ChatProvider(Protocol):
    """A provider exposes a single ``chat`` that maps messages to a result."""

    model: str

    def chat(self, messages: list[dict[str, str]]) -> ChatResult: ...


class OpenAICompatibleProvider:
    """An OpenAI-compatible ``/chat/completions`` client (DeepSeek, OpenAI, ...)."""

    def __init__(
        self, base_url: str, model: str, api_key: str, max_tokens: int = 2048
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.api_key = api_key
        self.max_tokens = max_tokens

    def chat(self, messages: list[dict[str, str]]) -> ChatResult:
        url = f"{self.base_url}/chat/completions"
        body = json.dumps(
            {
                "model": self.model,
                "messages": messages,
                "temperature": 0,
                "max_tokens": self.max_tokens,
                "response_format": {"type": "json_object"},
            }
        ).encode("utf-8")
        payload = self._post_json(
            url,
            {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.api_key}",
            },
            body,
        )
        try:
            choice = payload["choices"][0]
            content = choice["message"]["content"]
            finish_reason = choice.get("finish_reason", "")
            usage = payload.get("usage")
            if usage is None:
                usage = {}
            if not isinstance(content, str) or not isinstance(finish_reason, str):
                raise TypeError("invalid completion")
            if not isinstance(usage, dict):
                raise TypeError("invalid usage")
            details = usage.get("prompt_tokens_details")
            if details is None:
                details = {}
            if not isinstance(details, dict):
                raise TypeError("invalid usage details")
            return ChatResult(
                content=content,
                finish_reason=finish_reason,
                usage=TokenUsage(
                    input=_token_count(usage.get("prompt_tokens")),
                    output=_token_count(usage.get("completion_tokens")),
                    cache_read=_token_count(details.get("cached_tokens")),
                ),
            )
        except (AttributeError, IndexError, KeyError, TypeError):
            raise _invalid_response() from None

    def _post_json(self, url: str, headers: dict[str, str], body: bytes) -> dict:
        """POST and parse JSON; stubbable for tests."""
        return _post_json(url, headers, body)


class AnthropicProvider:
    """An Anthropic Messages API client (Claude)."""

    def __init__(self, model: str, api_key: str, max_tokens: int = 2048) -> None:
        self.model = model
        self.api_key = api_key
        self.max_tokens = max_tokens

    def chat(self, messages: list[dict[str, str]]) -> ChatResult:
        # Anthropic carries the system prompt in a dedicated field, not as a
        # message in the turn list, so split it out before sending.
        system = "\n\n".join(
            m["content"] for m in messages if m["role"] == "system"
        )
        turns = [
            {"role": m["role"], "content": m["content"]}
            for m in messages
            if m["role"] != "system"
        ]
        body = json.dumps(
            {
                "model": self.model,
                "max_tokens": self.max_tokens,
                "system": system,
                "messages": turns,
            }
        ).encode("utf-8")
        payload = self._post_json(
            _ANTHROPIC_ENDPOINT,
            {
                "Content-Type": "application/json",
                "x-api-key": self.api_key,
                "anthropic-version": _ANTHROPIC_VERSION,
            },
            body,
        )
        try:
            blocks = payload["content"]
            stop_reason = payload["stop_reason"]
            usage = payload.get("usage")
            if usage is None:
                usage = {}
            if not isinstance(blocks, list) or not blocks or not isinstance(stop_reason, str):
                raise TypeError("invalid message")
            if not isinstance(usage, dict):
                raise TypeError("invalid usage")
            texts = [block["text"] for block in blocks]
            if not all(isinstance(text, str) for text in texts):
                raise TypeError("invalid content")
            return ChatResult(
                content="".join(texts),
                finish_reason=_normalize_anthropic_stop_reason(stop_reason),
                usage=TokenUsage(
                    input=_token_count(usage.get("input_tokens")),
                    output=_token_count(usage.get("output_tokens")),
                    cache_read=_token_count(usage.get("cache_read_input_tokens")),
                    cache_write=_token_count(usage.get("cache_creation_input_tokens")),
                ),
            )
        except (AttributeError, IndexError, KeyError, TypeError):
            raise _invalid_response() from None

    def _post_json(self, url: str, headers: dict[str, str], body: bytes) -> dict:
        """POST and parse JSON; stubbable for tests."""
        return _post_json(url, headers, body)


def _normalize_anthropic_stop_reason(stop_reason: str) -> str:
    if stop_reason == "end_turn":
        return "stop"
    if stop_reason == "max_tokens":
        return "length"
    return stop_reason


def resolve_provider(config: ModelConfig) -> ChatProvider:
    """Build the single active provider from configuration, no fallback."""
    if not config.api_key:
        raise ModelConfigurationError("missing_api_key")
    if config.protocol == "anthropic":
        return AnthropicProvider(config.model, config.api_key, config.max_tokens)
    if config.protocol != "openai-compatible":
        raise ModelConfigurationError("unsupported_protocol")
    base_url = config.base_url or _DEFAULT_OPENAI_BASE
    return OpenAICompatibleProvider(
        base_url, config.model, config.api_key, config.max_tokens
    )
