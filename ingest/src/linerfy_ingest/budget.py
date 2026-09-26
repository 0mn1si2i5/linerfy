"""A small, auditable CNY cost ledger for pre-launch real model calls.

Every real call is charged against an explicit per-model rate (input/output/
cache tokens), with a worst-case estimate reserved before the call and the
actual usage settled after. The cumulative total is capped at 100 CNY; once
reached, no further real call is allowed. Unknown models and models without a
declared rate are refused outright (fail closed) rather than assumed cheap.
"""

from __future__ import annotations

import json
import os
import uuid
from dataclasses import dataclass

from .admin import set_pause
from .db import connect
from .providers import TokenUsage

BUDGET_YUAN = 100.0


@dataclass(frozen=True)
class ModelRate:
    """Price in CNY per one million tokens."""

    input: float
    output: float
    cache_read: float = 0.0
    cache_write: float = 0.0


class BudgetError(RuntimeError):
    """Raised when a real model call cannot be charged to the budget."""

    category = "budget_unavailable"
    retryable = False


# Approximate list prices in CNY per 1M tokens, as of 2026-09. These are
# conservative placeholders for pre-launch spend control, not a billing source;
# review and adjust via MODEL_RATES_JSON before production use. Any model not
# present here is refused for real calls.
_MODEL_RATES: dict[str, ModelRate] = {
    "deepseek-chat": ModelRate(input=2.0, output=8.0, cache_read=0.5, cache_write=2.0),
    "deepseek-reasoner": ModelRate(input=4.0, output=16.0),
    "gpt-5": ModelRate(input=8.75, output=35.0, cache_read=0.875),
    "gpt-5-mini": ModelRate(input=1.75, output=7.0, cache_read=0.175),
    "claude-sonnet-5": ModelRate(input=21.0, output=105.0, cache_read=2.1, cache_write=26.25),
    "claude-haiku-4-5": ModelRate(input=7.0, output=35.0, cache_read=0.7, cache_write=8.75),
}


def load_rates(raw: str | None) -> dict[str, ModelRate]:
    """Merge an optional ``MODEL_RATES_JSON`` override onto the defaults.

    The override is a JSON object mapping model id to a rate object with any of
    ``input``/``output``/``cache_read``/``cache_write`` (CNY per 1M tokens).
    """
    if not raw:
        return dict(_MODEL_RATES)
    rates = dict(_MODEL_RATES)
    override = json.loads(raw)
    for model, value in override.items():
        rates[model] = ModelRate(
            input=float(value.get("input", 0)),
            output=float(value.get("output", 0)),
            cache_read=float(value.get("cache_read", 0)),
            cache_write=float(value.get("cache_write", 0)),
        )
    return rates


def estimate_cost_cny(usage: TokenUsage, rate: ModelRate) -> float:
    """Estimated CNY cost of a usage against a rate."""
    cost = (
        usage.input * rate.input
        + usage.output * rate.output
        + usage.cache_read * rate.cache_read
        + usage.cache_write * rate.cache_write
    )
    return cost / 1_000_000


# A small, explicit safety margin applied on top of the per-token worst case, so
# rounding, per-request overhead, and multi-part pricing can never push a real
# call just past the cap.
SAFETY_MARGIN = 1.1


def reserve_cost_cny(rate: ModelRate, input_tokens: int, max_output_tokens: int) -> float:
    """The conservative CNY upper bound to reserve for one call.

    Assumes the whole prompt is non-cached input (billed at the input rate), the
    model emits the full output budget, and the prompt is also cache-written
    (billed at the cache-write rate where a provider charges it); then a safety
    margin is applied. This never under-bills a real call.
    """
    usage = TokenUsage(
        input=input_tokens,
        output=max_output_tokens,
        cache_write=input_tokens,
    )
    return estimate_cost_cny(usage, rate) * SAFETY_MARGIN


class DbBudgetLedger:
    """A durable, concurrency-safe budget ledger backed by Postgres.

    The Vercel worker is serverless, so a local JSON file cannot be the
    authority. Before a real call ``reserve`` atomically locks the single-row
    running total, checks ``committed + reserved + worst <= budget``, and writes
    a reservation. After the call ``settle`` releases the reserved amount and
    records the actual cost. Concurrent invocations serialise on the row lock,
    so they can never jointly exceed the cap.
    """

    def __init__(
        self,
        *,
        budget_yuan: float = BUDGET_YUAN,
        rates: dict[str, ModelRate] | None = None,
        reservation_seconds: int = 3600,
    ) -> None:
        self.budget_yuan = budget_yuan
        self.rates = (
            rates if rates is not None else load_rates(os.environ.get("MODEL_RATES_JSON"))
        )
        self.reservation_seconds = reservation_seconds

    def rate(self, model: str) -> ModelRate:
        rate = self.rates.get(model)
        if rate is None:
            raise BudgetError(f"unknown model {model!r}; refusing real call")
        return rate

    def committed_cny(self) -> float:
        with connect() as conn:
            row = conn.execute(
                "SELECT committed_cny, reserved_cny FROM public.model_budget WHERE id = 1"
            ).fetchone()
            return float(row[0]) if row else 0.0

    def reserve(
        self,
        *,
        model: str,
        input_tokens: int,
        max_output_tokens: int,
        request_id: str,
        provider: str = "",
        job_id: str | None = None,
    ) -> float:
        """Atomically reserve a worst-case cost for one call; idempotent.

        The reserved amount covers the prompt input upper bound, the full output
        budget, and a safety margin. A retry with the same ``request_id`` returns
        the original reservation without charging again; a replay with different
        parameters is rejected, and the reservation is only created (and the
        running total raised) when no reservation for the id exists.
        """
        rate = self.rate(model)
        worst = reserve_cost_cny(rate, input_tokens, max_output_tokens)
        job_uuid = uuid.UUID(job_id) if job_id else None
        with connect(autocommit=False) as conn:
            existing = conn.execute(
                "SELECT model, input_tokens, output_tokens, reserved_cny, status "
                "FROM public.model_usage_reservations "
                "WHERE request_id = %s FOR UPDATE",
                (request_id,),
            ).fetchone()
            if existing is not None:
                ex_model, ex_in, ex_out, ex_reserved, ex_status = existing
                if ex_status != "reserved":
                    raise BudgetError(
                        f"request {request_id} is already {ex_status}"
                    )
                if ex_model != model:
                    raise BudgetError(
                        f"request {request_id} replayed with a different model"
                    )
                if int(ex_in or 0) != input_tokens or int(ex_out or 0) != max_output_tokens:
                    raise BudgetError(
                        f"request {request_id} replayed with different parameters"
                    )
                return float(ex_reserved or 0.0)  # idempotent retry

            row = conn.execute(
                "SELECT committed_cny, reserved_cny FROM public.model_budget "
                "WHERE id = 1 FOR UPDATE"
            ).fetchone()
            committed = float(row[0]) if row else 0.0
            reserved = float(row[1]) if row else 0.0
            if committed + reserved + worst > self.budget_yuan:
                raise BudgetError(
                    f"budget exhausted ({committed + reserved:.4f} CNY committed+reserved)"
                )
            conn.execute(
                "UPDATE public.model_budget SET reserved_cny = reserved_cny + %s "
                "WHERE id = 1",
                (worst,),
            )
            conn.execute(
                "INSERT INTO public.model_usage_reservations "
                "(request_id, job_id, provider, model, input_tokens, output_tokens, "
                " reserved_cny, status, expires_at) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,'reserved', now() + make_interval(secs => %s))",
                (
                    request_id,
                    job_uuid,
                    provider,
                    model,
                    input_tokens,
                    max_output_tokens,
                    worst,
                    self.reservation_seconds,
                ),
            )
            conn.commit()
        return worst

    def settle(
        self,
        *,
        request_id: str,
        model: str,
        usage: TokenUsage,
    ) -> float:
        """Release the reservation and record the actual cost; idempotent.

        If the actual cost exceeds the reserved worst-case bound, the real cost
        is still recorded, the global model-generation pause is set, and a
        ``BudgetError`` is raised so the caller fails closed instead of silently
        pretending the hard cap still holds.
        """
        rate = self.rate(model)
        actual = estimate_cost_cny(usage, rate)
        with connect(autocommit=False) as conn:
            row = conn.execute(
                "SELECT reserved_cny, status, settled_cny FROM public.model_usage_reservations "
                "WHERE request_id = %s FOR UPDATE",
                (request_id,),
            ).fetchone()
            if row is None:
                raise BudgetError(f"no reservation for request {request_id}")
            reserved, status, settled_cny = row
            if status == "settled":
                return float(settled_cny or 0.0)  # already settled; idempotent
            if status == "expired":
                raise BudgetError(f"request {request_id} was already released/expired")
            overrun = actual > float(reserved or 0.0)
            conn.execute(
                "UPDATE public.model_budget "
                "SET reserved_cny = GREATEST(0, reserved_cny - %s), "
                "committed_cny = committed_cny + %s "
                "WHERE id = 1",
                (float(reserved or 0.0), actual),
            )
            conn.execute(
                "UPDATE public.model_usage_reservations "
                "SET status = 'settled', settled_cny = %s, input_tokens = %s, "
                "output_tokens = %s, cache_read_tokens = %s, cache_write_tokens = %s, "
                "settled_at = now() WHERE request_id = %s",
                (
                    actual,
                    usage.input,
                    usage.output,
                    usage.cache_read,
                    usage.cache_write,
                    request_id,
                ),
            )
            if overrun:
                set_pause(conn, True)
                conn.commit()
                raise BudgetError(
                    f"actual cost {actual:.6f} CNY exceeded reservation "
                    f"{float(reserved or 0.0):.6f}; pausing model calls"
                )
            conn.commit()
        return actual

    def release(self, *, request_id: str) -> None:
        """Explicitly rescind a reservation without settling; idempotent.

        Releases the reserved amount back to the running total and marks the
        reservation expired. Calling it twice, or on an already-expired
        reservation, has no further effect; settling a released reservation is
        refused.
        """
        with connect(autocommit=False) as conn:
            row = conn.execute(
                "SELECT reserved_cny, status FROM public.model_usage_reservations "
                "WHERE request_id = %s FOR UPDATE",
                (request_id,),
            ).fetchone()
            if row is None or row[1] == "expired":
                return
            if row[1] == "settled":
                raise BudgetError(f"request {request_id} is already settled")
            conn.execute(
                "UPDATE public.model_budget SET reserved_cny = reserved_cny - %s "
                "WHERE id = 1",
                (float(row[0] or 0.0),),
            )
            conn.execute(
                "UPDATE public.model_usage_reservations SET status = 'expired' "
                "WHERE request_id = %s",
                (request_id,),
            )
            conn.commit()

    def expire_stale(self) -> int:
        """Release reservations past their deadline, returning the count."""
        with connect(autocommit=False) as conn:
            rows = conn.execute(
                "SELECT request_id, reserved_cny FROM public.model_usage_reservations "
                "WHERE status = 'reserved' AND expires_at < now() FOR UPDATE"
            ).fetchall()
            for request_id, reserved in rows:
                conn.execute(
                    "UPDATE public.model_budget SET reserved_cny = reserved_cny - %s "
                    "WHERE id = 1",
                    (float(reserved),),
                )
                conn.execute(
                    "UPDATE public.model_usage_reservations SET status = 'expired' "
                    "WHERE request_id = %s",
                    (request_id,),
                )
            conn.commit()
            return len(rows)
