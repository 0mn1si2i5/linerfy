"""Shared worker entrypoint used by the CLI and the Vercel Python function.

Constructs the live four-stage handlers and runs one bounded tick. The model
provider is resolved lazily on the first model call, so resolve and fetch
stages still run when ``MODEL_API_KEY`` is absent. Adapters and ``chat`` are
injectable so a test can drive a synthetic job end to end without touching the
network or the model.
"""

from __future__ import annotations

import hashlib
import os

from .critiquebrainz import CritiqueBrainzAdapter
from .jobs import PostgresJobStore, run_batch, run_once
from .musicbrainz import MusicBrainzAdapter
from .pipeline import PipelineDeps, build_handlers
from .pitchfork import PitchforkAdapter
from .providers import ModelConfig, ModelConfigurationError, resolve_provider
from .wikipedia import WikipediaAdapter


def check_worker_auth(secret: str, authorization: str) -> int | None:
    """Return the HTTP status to reject a worker request, or None to allow.

    503 when no secret is configured; 401 on a missing or mismatched bearer
    token. The compare is constant-time so the secret is not leaked by timing.
    """
    if not secret:
        return 503
    token = authorization[7:] if authorization.startswith("Bearer ") else ""
    if not token:
        return 401
    if hashlib.sha256(secret.encode()).digest() != hashlib.sha256(token.encode()).digest():
        return 401
    return None


def _resolve_model():
    protocol = os.environ.get("MODEL_PROTOCOL", "openai-compatible")
    api_key = os.environ.get("MODEL_API_KEY", "")
    if not api_key:
        raise ModelConfigurationError("missing_api_key")
    return resolve_provider(
        ModelConfig(
            protocol=protocol,
            model=os.environ.get("MODEL_NAME", "deepseek-chat"),
            api_key=api_key,
            base_url=os.environ.get("MODEL_BASE_URL", "https://api.deepseek.com"),
            max_tokens=int(os.environ.get("MODEL_MAX_TOKENS", "2048")),
        )
    )


def build_worker_handlers(
    *,
    musicbrainz=None,
    critiquebrainz=None,
    wikipedia=None,
    pitchfork=None,
    chat=None,
):
    """Construct the four-stage handlers around one configured model provider."""
    provider_cache: dict[str, object] = {}

    def default_chat(messages):
        if "provider" not in provider_cache:
            provider_cache["provider"] = _resolve_model()
        provider = provider_cache["provider"]
        return provider.chat(messages)

    deps = PipelineDeps(
        store=PostgresJobStore(),
        musicbrainz=musicbrainz or MusicBrainzAdapter(),
        critiquebrainz=critiquebrainz or CritiqueBrainzAdapter(),
        wikipedia=wikipedia or WikipediaAdapter(),
        model=os.environ.get("MODEL_NAME", "deepseek-chat"),
        chat=chat or default_chat,
        pitchfork=pitchfork if pitchfork is not None else PitchforkAdapter(),
    )
    return build_handlers(deps)


def advance_once(
    *,
    musicbrainz=None,
    critiquebrainz=None,
    wikipedia=None,
    chat=None,
) -> int:
    """Reap leases and advance one bounded work unit; returns 1 or 0."""
    handlers = build_worker_handlers(
        musicbrainz=musicbrainz,
        critiquebrainz=critiquebrainz,
        wikipedia=wikipedia,
        chat=chat,
    )
    return run_once(PostgresJobStore(), handlers)


def advance_batch(*, max_steps: int = 8) -> int:
    """Advance enough bounded stages to finish one typical current release."""
    handlers = build_worker_handlers()
    return run_batch(PostgresJobStore(), handlers, max_steps=max_steps)
