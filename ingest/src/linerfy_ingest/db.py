"""Load an ``IngestedContext`` into the Supabase catalog.

The pure transformations (``to_rows``) are covered by pytest; this module
exercises the real write path against a live database identified by
``DATABASE_URL``. Test-database setup (migration application, the Supabase role
and pg_cron stubs, and the test marker) lives in ``tests/_db_helpers.py``, not
here -- it is test infrastructure, not a product path.
"""

from __future__ import annotations

import os
import uuid

import psycopg

from .models import IngestedContext, ReviewDocument
from .seed import stable_uuid, to_rows

# Insertion order respects foreign keys (parents before children).
_TABLE_ORDER = [
    "artists",
    "releases",
    "genres",
    "release_ratings",
    "review_sources",
    "source_policies",
    "review_documents",
    "review_document_bodies",
    "review_excerpts",
    "genre_sources",
    "summary_runs",
    "claims",
    "claim_sources",
]

# Primary key columns per table, so a seed can upsert deterministically: the
# same canonical slug always maps to the same row, and re-seeding with real data
# replaces an earlier hand-authored placeholder instead of leaving it behind.
_PRIMARY_KEYS = {
    "artists": ["id"],
    "releases": ["id"],
    "genres": ["id"],
    "release_ratings": ["id"],
    "review_sources": ["id"],
    "source_policies": ["source_id"],
    "review_documents": ["id"],
    "review_document_bodies": ["document_id"],
    "review_excerpts": ["id"],
    "genre_sources": ["genre_id", "document_id"],
    "summary_runs": ["id"],
    "claims": ["id"],
    "claim_sources": ["claim_id", "document_id"],
}


def connect(*, autocommit: bool = True) -> psycopg.Connection:
    """Open a connection. Default is autocommit (one statement == one commit),
    used by the read path and one-shot seeding. Pass ``autocommit=False`` when a
    caller must control commit/rollback itself (e.g. an atomic summary write)."""
    url = os.getenv("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL is required")
    return psycopg.connect(url, autocommit=autocommit)


# The columns that are genuinely uuid-typed, per table. ``source_id`` is a uuid
# foreign key on documents/policies but a *text* slug on summary_runs, and
# ``license_id`` is a text slug on policies -- a naive ``endswith("_id")`` would
# coerce those to uuid and break the seed. This map is the precise source of truth.
_UUID_COLUMNS: dict[str, set[str]] = {
    "artists": {"id"},
    "releases": {"id", "artist_id"},
    "genres": {"id", "release_id"},
    "release_ratings": {"id", "release_id"},
    "review_sources": {"id"},
    "source_policies": {"source_id"},
    "review_documents": {"id", "release_id", "source_id"},
    "review_document_bodies": {"document_id"},
    "review_excerpts": {"id", "document_id"},
    "genre_sources": {"genre_id", "document_id"},
    "summary_runs": {"id", "release_id"},
    "claims": {"id", "summary_run_id"},
    "claim_sources": {"claim_id", "document_id"},
}


def _db_value(table: str, name: str, value: object) -> object:
    if value is None:
        return None
    if name in _UUID_COLUMNS.get(table, set()):
        return uuid.UUID(value)
    return value


def _release_present(conn: psycopg.Connection, rows: dict[str, list[dict]]) -> bool:
    """True when the context's release already has a row, so a bootstrap-only
    (``overwrite=False``) seed should write nothing."""
    release_rows = rows["releases"]
    if not release_rows:
        return False
    release_id = uuid.UUID(release_rows[0]["id"])
    return (
        conn.execute("SELECT 1 FROM public.releases WHERE id = %s", (release_id,)).fetchone()
        is not None
    )


def delete_metadata_genres(conn: psycopg.Connection, release_id: uuid.UUID) -> int:
    """Delete a release's uncited (metadata-owned) genres before re-seeding.

    MusicBrainz genres carry no document citation; genres attributed to review
    documents (which have ``genre_sources`` rows) are preserved. This makes a
    re-fetch replace the previous metadata genre set instead of accumulating
    stale tag-based genres alongside the new curated genres.
    """
    cursor = conn.execute(
        "DELETE FROM public.genres g "
        "WHERE g.release_id = %s "
        "AND NOT EXISTS (SELECT 1 FROM public.genre_sources gs WHERE gs.genre_id = g.id)",
        (release_id,),
    )
    return cursor.rowcount


def reconcile_source_documents(
    conn: psycopg.Connection,
    release_id: uuid.UUID,
    source_slug: str,
    documents: list[ReviewDocument],
) -> int:
    """Invalidate old claims after a *successful* source refresh, before seed.

    Run inside the caller's lease-guarded transaction. A failed source fetch
    must not call this function: its previous useful content stays available.
    Missing documents become drafts, not deleted records; summaries citing a
    removed document or changed body/URL are retained as superseded history.
    """
    if any(not document.content or not document.content.strip() for document in documents):
        raise ValueError("source refresh documents must contain review text")
    if any(
        document.source_id != source_slug
        or uuid.UUID(stable_uuid("release", document.release_id)) != release_id
        for document in documents
    ):
        raise ValueError("source refresh documents must belong to the requested release/source")
    incoming = {uuid.UUID(stable_uuid("document", document.id)): document for document in documents}
    rows = conn.execute(
        "SELECT d.id, d.source_url, b.content FROM public.review_documents d "
        "JOIN public.review_sources s ON s.id = d.source_id "
        "LEFT JOIN public.review_document_bodies b ON b.document_id = d.id "
        "WHERE d.release_id = %s AND s.slug = %s AND d.status = 'published'",
        (release_id, source_slug),
    ).fetchall()
    missing = []
    changed = []
    for document_id, source_url, content in rows:
        fresh = incoming.get(document_id)
        if fresh is None:
            missing.append(document_id)
        elif fresh.source_url != source_url or fresh.content != content:
            changed.append(document_id)
    affected = missing + changed
    if affected:
        conn.execute(
            "UPDATE public.summary_runs s SET status = 'superseded' "
            "WHERE s.release_id = %s AND s.status = 'published' AND EXISTS ("
            "SELECT 1 FROM public.claims c JOIN public.claim_sources cs ON cs.claim_id = c.id "
            "WHERE c.summary_run_id = s.id AND cs.document_id = ANY(%s))",
            (release_id, affected),
        )
    if missing:
        conn.execute(
            "UPDATE public.review_documents SET status = 'draft' WHERE id = ANY(%s)",
            (missing,),
        )
    return len(affected)


def seed(
    conn: psycopg.Connection, context: IngestedContext, *, overwrite: bool = True
) -> int:
    """Load a context into the catalog.

    ``overwrite=True`` (real adapters) upserts, so a later fetch with real data
    replaces an earlier placeholder. ``overwrite=False`` (the fixture) is a
    bootstrap-only write: if the release is already present it writes nothing at
    all, so it can neither overwrite nor extend a record that already exists --
    the hand-authored fixture stays a pure contract check.
    """
    rows = to_rows(context)
    if not overwrite and _release_present(conn, rows):
        return 0
    written = 0
    for table in _TABLE_ORDER:
        table_rows = rows[table]
        if not table_rows:
            continue
        columns = list(table_rows[0].keys())
        placeholders = ", ".join(["%s"] * len(columns))
        if not overwrite:
            on_conflict = "ON CONFLICT DO NOTHING"
        else:
            primary_keys = _PRIMARY_KEYS[table]
            update_columns = [
                column for column in columns if column not in primary_keys
            ]
            if update_columns:
                on_conflict = (
                    f"ON CONFLICT ({', '.join(primary_keys)}) DO UPDATE SET "
                    + ", ".join(
                        f"{column} = EXCLUDED.{column}" for column in update_columns
                    )
                )
            else:
                on_conflict = "ON CONFLICT DO NOTHING"
        statement = (
            f"INSERT INTO public.{table} ({', '.join(columns)}) "
            f"VALUES ({placeholders}) {on_conflict}"
        )
        for row in table_rows:
            values = [_db_value(table, column, row[column]) for column in columns]
            cursor = conn.execute(statement, values)
            written += cursor.rowcount
    return written
