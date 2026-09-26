"""Source refresh reconciliation against the isolated, marked test database."""

from __future__ import annotations

import os
import uuid
from datetime import UTC, datetime

import pytest
from _db_helpers import skip_unless_test_db

from linerfy_ingest.db import connect, reconcile_source_documents, seed
from linerfy_ingest.models import (
    ArtistEntity,
    CitedClaim,
    IngestedContext,
    ReleaseEntity,
    ReviewDocument,
    ReviewSource,
    SourcePolicy,
    Summary,
)
from linerfy_ingest.seed import stable_uuid
from linerfy_ingest.summarize import read_stored_documents

pytestmark = pytest.mark.skipif(
    not (os.environ.get("DATABASE_URL") and os.environ.get("LINERFY_DB_TESTS_ALLOWED") == "1"),
    reason="set DATABASE_URL and LINERFY_DB_TESTS_ALLOWED=1 to run DB integration tests",
)


def _catalog() -> IngestedContext:
    prefix = f"refresh-test-{uuid.uuid4().hex}"
    artist = ArtistEntity(id=f"{prefix}-artist", name="Test Artist")
    release = ReleaseEntity(id=prefix, title="Test Album", artist_id=artist.id)
    sources = [
        ReviewSource(id=f"{prefix}-{name}", publication=name, homepage_url="https://example.com")
        for name in ("target", "other")
    ]
    documents = [
        ReviewDocument(
            id=f"{source.id}-doc",
            release_id=release.id,
            source_id=source.id,
            source_url=f"https://example.com/{source.id}",
            title=f"{source.publication} review of Test Album",
            content=f"{source.publication} describes the sparse percussion.",
            public_excerpt="Sparse percussion.",
            license_id="test",
            license_url="https://example.com/license",
            policy=SourcePolicy(
                source_id=source.id,
                crawl_allowed=True,
                requests_per_minute=10,
                retention_days=30,
                excerpt_max_chars=100,
                removal_contact="test@example.com",
                license_id="test",
                license_url="https://example.com/license",
            ),
        )
        for source in sources
    ]
    summaries = []
    for source_id, cited_documents in [
        (sources[0].id, documents[:1]),
        (sources[1].id, documents[1:]),
        (None, documents),
    ]:
        summaries.append(
            Summary(
                locale="zh-CN",
                model="test-model",
                prompt_version="test-v1",
                generated_at=datetime.now(UTC),
                corpus_hash=f"hash-{source_id}",
                kind="source" if source_id else "consensus",
                source_id=source_id,
                license_pool="test",
                license_url="https://example.com/license",
                claims=[
                    CitedClaim(text="打击乐编排稀疏。", source_ids=[d.id for d in cited_documents])
                ],
            )
        )
    return IngestedContext(
        release=release,
        artist=artist,
        sources=sources,
        review_documents=documents,
        summaries=summaries,
    )


@pytest.fixture
def catalog_db():
    with connect(autocommit=False) as conn:
        skip_unless_test_db(conn)
        context = _catalog()
        seed(conn, context)
        try:
            yield conn, context
        finally:
            conn.rollback()  # Includes setup; no test entities survive, even on assertion failure.


def _release_id(context):
    return uuid.UUID(stable_uuid("release", context.release.id))


def _summary_states(conn, context):
    return dict(
        conn.execute(
            "SELECT scope, status FROM public.summary_runs WHERE release_id = %s",
            (_release_id(context),),
        ).fetchall()
    )


@pytest.mark.parametrize("change", ["removed", "body", "url"])
def test_refresh_invalidates_only_summaries_citing_changed_documents(catalog_db, change):
    conn, context = catalog_db
    old = context.review_documents[0]
    updated = old.model_copy(
        update={
            "content": "The reviewer instead describes dense percussion."
            if change == "body"
            else old.content,
            "source_url": "https://example.com/correct-article"
            if change == "url"
            else old.source_url,
        }
    )
    documents = [] if change == "removed" else [updated]
    assert reconcile_source_documents(conn, _release_id(context), old.source_id, documents) == 1
    if documents:
        seed(
            conn,
            context.model_copy(
                update={
                    "sources": context.sources[:1],
                    "review_documents": documents,
                    "summaries": [],
                }
            ),
        )
    states = _summary_states(conn, context)
    assert states[f"source::{old.source_id}::test"] == "superseded"
    assert states["consensus::test"] == "superseded"
    assert states[f"source::{context.sources[1].id}::test"] == "published"
    stored = {d.id: d.content for d in read_stored_documents(conn, context.release.id)}
    if change == "removed":
        assert old.id not in stored
        assert conn.execute(
            "SELECT status FROM public.review_documents WHERE slug = %s",
            (old.id,),
        ).fetchone() == ("draft",)
    else:
        assert stored[old.id] == updated.content


def test_unchanged_successful_refresh_preserves_published_summaries(catalog_db):
    conn, context = catalog_db
    target = context.review_documents[0]
    assert reconcile_source_documents(conn, _release_id(context), target.source_id, [target]) == 0
    assert set(_summary_states(conn, context).values()) == {"published"}


@pytest.mark.parametrize("body", [None, "", " \t\n "])
def test_missing_or_blank_body_never_falls_back_to_article_title(catalog_db, body):
    conn, context = catalog_db
    target = context.review_documents[0]
    document_id = uuid.UUID(stable_uuid("document", target.id))
    if body is None:
        conn.execute(
            "DELETE FROM public.review_document_bodies WHERE document_id = %s", (document_id,)
        )
    else:
        conn.execute(
            "UPDATE public.review_document_bodies SET content = %s WHERE document_id = %s",
            (body, document_id),
        )
    stored = read_stored_documents(conn, context.release.id)
    assert [d.id for d in stored] == [context.review_documents[1].id]
    assert set(_summary_states(conn, context).values()) == {"published"}


@pytest.mark.parametrize("body", [None, "", " \t\n "])
def test_metadata_only_refresh_is_rejected_without_changing_old_records(catalog_db, body):
    conn, context = catalog_db
    target = context.review_documents[0].model_copy(update={"content": body})
    with pytest.raises(ValueError, match="must contain review text"):
        reconcile_source_documents(conn, _release_id(context), target.source_id, [target])
    stored = {d.id: d.content for d in read_stored_documents(conn, context.release.id)}
    assert stored == {d.id: d.content for d in context.review_documents}
    assert set(_summary_states(conn, context).values()) == {"published"}


def test_reconciliation_rejects_a_document_from_another_source(catalog_db):
    conn, context = catalog_db
    with pytest.raises(ValueError, match="requested release/source"):
        reconcile_source_documents(
            conn, _release_id(context), context.sources[0].id, context.review_documents[1:]
        )
    assert set(_summary_states(conn, context).values()) == {"published"}
