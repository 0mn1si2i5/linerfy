"""Shared worker entrypoint used by the CLI and the Vercel Python function.

Constructs the live four-stage handlers and runs one bounded tick. The model
budget is the durable Postgres ledger (serverless-safe); the model provider is
resolved lazily on the first model call, so resolve and fetch stages still run
when ``MODEL_API_KEY`` is absent. Adapters and ``chat`` are injectable so a test
can drive a synthetic job end to end without touching the network or the model.
"""

from __future__ import annotations

import hashlib
import os
import uuid

from .budget import DbBudgetLedger
from .critiquebrainz import CritiqueBrainzAdapter
from .jobs import PostgresJobStore, run_batch, run_once
from .musicbrainz import MusicBrainzAdapter
from .pipeline import PipelineDeps, build_handlers
from .pitchfork import PitchforkAdapter
from .providers import ModelConfig, ModelConfigurationError, ModelProviderError, resolve_provider
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


_PER_MESSAGE_OVERHEAD = 4  # role separator + protocol framing, in tokens


def _estimate_input_tokens(messages: list[dict[str, str]]) -> int:
    """A conservative upper bound on the prompt token count.

    Uses the UTF-8 byte length of each message as the content bound (a token is
    never larger than a few bytes, and CJK characters are ~3 bytes but ~1
    token), plus a small fixed per-message overhead. This over-estimates both
    CJK and ASCII, so the pre-call reservation can never under-bill the prompt.
    """
    total = sum(len(m.get("content", "").encode("utf-8")) for m in messages)
    return max(1, total + _PER_MESSAGE_OVERHEAD * len(messages))


def build_worker_handlers(
    *,
    budget: DbBudgetLedger | None = None,
    musicbrainz=None,
    critiquebrainz=None,
    wikipedia=None,
    pitchfork=None,
    chat=None,
):
    """Construct the four-stage handlers with a durable budget ledger.

    Passing ``chat`` bypasses the budget-wrapped provider (used by tests with a
    stub model); otherwise real model calls reserve and settle against the
    durable ledger.
    """
    ledger = budget if budget is not None else DbBudgetLedger()
    max_tokens = int(os.environ.get("MODEL_MAX_TOKENS", "2048"))
    provider_cache: dict[str, object] = {}

    def default_chat(messages):
        if "provider" not in provider_cache:
            provider_cache["provider"] = _resolve_model()
        provider = provider_cache["provider"]
        request_id = uuid.uuid4().hex
        ledger.expire_stale()
        ledger.reserve(
            model=provider.model,
            input_tokens=_estimate_input_tokens(messages),
            max_output_tokens=max_tokens,
            request_id=request_id,
        )
        try:
            result = provider.chat(messages)
        except Exception as exc:
            # A timeout or server error may have happened after inference began.
            # Keep that reservation until expiry so retries cannot undercount a
            # provider charge whose usage response never reached us.
            if not isinstance(exc, ModelProviderError) or not exc.billing_uncertain:
                ledger.release(request_id=request_id)
            raise
        ledger.settle(request_id=request_id, model=provider.model, usage=result.usage)
        return result

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
    budget: DbBudgetLedger | None = None,
    musicbrainz=None,
    critiquebrainz=None,
    wikipedia=None,
    chat=None,
) -> int:
    """Reap leases and advance one bounded work unit; returns 1 or 0."""
    handlers = build_worker_handlers(
        budget=budget,
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
