"""Vercel Python Function that advances the enrichment queue.

Deployed as the Worker Vercel Project (root directory ``ingest``). Supabase Cron
POSTs here once a minute; each call verifies the worker secret and advances a
small bounded batch. External HTTP and model work happen outside any database
transaction; short job leases coordinate concurrent invocations.

The response is structured statistics only — never a review body, prompt, or
secret. The default error path logs an error category, never a full traceback;
set ``LINERFY_DEBUG_TRACEBACK=1`` to opt into tracebacks for local debugging.

The Vercel Python runtime auto-detects this file in the ``api`` directory and
requires the module to expose a top-level ``handler`` that is a
``BaseHTTPRequestHandler`` subclass (lowercase ``handler``, not ``Handler``).
"""

from __future__ import annotations

import json
import os
import sys
import traceback
from http.server import BaseHTTPRequestHandler
from pathlib import Path

# The worker project root is `ingest`; the src-layout package lives under
# `ingest/src`. Make it importable regardless of how the runtime installs it.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from linerfy_ingest.worker import advance_batch, check_worker_auth  # noqa: E402


class handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # health check
        self._json(200, {"ok": True})

    def do_POST(self) -> None:
        status = check_worker_auth(
            os.environ.get("LINERFY_WORKER_SECRET", ""),
            self.headers.get("Authorization", ""),
        )
        if status is not None:
            self._json(
                status,
                {"error": "worker not configured" if status == 503 else "forbidden"},
            )
            return
        try:
            processed = advance_batch()
            self._json(200, {"processed": processed})
        except Exception as exc:  # never leak internals to the caller
            # Default: log only the error category. Full tracebacks are opt-in
            # for local debugging, so a production error never spills a review
            # body, secret, or stack into the logs.
            if os.environ.get("LINERFY_DEBUG_TRACEBACK") == "1":
                print(traceback.format_exc(), file=sys.stderr)
            else:
                print(f"worker error: {type(exc).__name__}", file=sys.stderr)
            self._json(500, {"error": "worker error"})

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args) -> None:  # suppress URL logging
        return
