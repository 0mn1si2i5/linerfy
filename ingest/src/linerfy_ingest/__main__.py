"""CLI for the Linerfy ingest pipeline.

Every mode is explicit. Running with no arguments prints help and exits without
touching the database.

Modes
-----
``--run-enrichment``
    Run one worker tick: reap leases, claim one job, run one bounded unit.
``--pause`` / ``--resume``
    Set / clear the global model-generation pause.
``--jobs``
    List the enrichment queue.
``--retry-failed``
    Re-queue failed jobs.
``--purge``
    Delete private bodies past their retention window.
"""

from __future__ import annotations

import sys

from .admin import list_jobs, purge_expired, retry_failed, set_pause
from .db import connect
from .worker import advance_once

_HELP = """usage: python -m linerfy_ingest <mode>

modes:
  --run-enrichment    run one worker tick (claim + advance one job)
  --pause / --resume  set / clear the global model-generation pause
  --jobs              list the enrichment queue
  --retry-failed      re-queue failed jobs (reset retry count)
  --purge             delete private bodies past their retention window
  --help              show this help

examples:
  python -m linerfy_ingest --run-enrichment
  python -m linerfy_ingest --pause
"""


def _run_enrichment() -> None:
    """Run one worker tick: reap leases, claim one job, run one bounded unit.

    External HTTP and model calls happen outside any database transaction; each
    job operation is its own short transaction guarded by an active-lease CAS.
    Model calls go directly through the configured provider; each job operation
    remains a short transaction guarded by its active lease.
    """
    processed = advance_once()
    print(f"enrichment tick: processed {processed} job(s)")


def _run_pause(paused: bool) -> None:
    with connect() as conn:
        set_pause(conn, paused)
    print(f"model generation {'paused' if paused else 'resumed'}")


def _run_jobs() -> None:
    with connect() as conn:
        jobs = list_jobs(conn)
    if not jobs:
        print("no enrichment jobs")
        return
    for job in jobs:
        error = f" ({job['last_error']})" if job["last_error"] else ""
        print(
            f"{job['entity_id']}\t{job['stage']}\t{job['state']}"
            f"\tretries={job['retry_count']}{error}"
        )


def _run_retry_failed() -> None:
    with connect() as conn:
        count = retry_failed(conn)
    print(f"re-queued {count} failed job(s)")


def _run_purge() -> None:
    with connect() as conn:
        count = purge_expired(conn)
    print(f"purged {count} expired private body/bodies")


def main() -> None:
    args = sys.argv[1:]
    if not args:
        print(_HELP)
        raise SystemExit(2)
    if "--help" in args or "-h" in args:
        print(_HELP)
        raise SystemExit(0)

    if "--run-enrichment" in args:
        _run_enrichment()
    elif "--pause" in args:
        _run_pause(True)
    elif "--resume" in args:
        _run_pause(False)
    elif "--jobs" in args:
        _run_jobs()
    elif "--retry-failed" in args:
        _run_retry_failed()
    elif "--purge" in args:
        _run_purge()
    else:
        print(_HELP)
        raise SystemExit(2)


if __name__ == "__main__":
    main()
