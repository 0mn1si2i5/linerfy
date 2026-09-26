"""Real enrichment stage handlers, wired from v1 dependencies.

Each stage reads its input from the job and the persisted database, performs
external HTTP/model work OUTSIDE any transaction, and persists its output so a
later stage (or a re-run after a crash) can pick up where it left off. Stages
are idempotent and resumable: entity/source/document writes upsert, and each
source summary or consensus block publishes itself atomically in one guarded
transaction -- there is no release-wide publish stage.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
import uuid
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass

from .critiquebrainz import CritiqueBrainzAdapter
from .db import connect, delete_metadata_genres, seed
from .enrich import corpus_from_documents, fetch_documents_parallel, genres_from_release_group
from .jobs import (
    EnrichmentJob,
    JobStore,
    JobUnavailable,
    Stage,
    StageHandler,
    assert_active_lease,
    record_corpus_hash,
)
from .models import (
    ArtistEntity,
    IngestedContext,
    Rating,
    ReleaseEntity,
    license_pool,
)
from .musicbrainz import MusicBrainzAdapter, resolve_release_group
from .pitchfork import PitchforkAdapter
from .providers import ChatResult
from .request import NowPlayingRequest
from .seed import stable_uuid
from .summarize import (
    PROMPT_VERSION,
    StoredDocument,
    corpus_hash,
    publish_consensus_skipped,
    publish_summary,
    read_stored_documents,
    summarize,
)
from .wikipedia import WikipediaAdapter


@dataclass
class PipelineDeps:
    """The live dependencies a stage handler uses (no held DB connection)."""

    store: JobStore
    musicbrainz: MusicBrainzAdapter
    critiquebrainz: CritiqueBrainzAdapter
    wikipedia: WikipediaAdapter
    model: str
    chat: Callable[[list[dict]], ChatResult]
    pitchfork: PitchforkAdapter | None = None


def _slugify(text: str) -> str:
    """A readable, collision-free slug; identical to apps/web/lib/request.ts.

    A readable ASCII slug is only safe when the name is entirely ASCII:
    otherwise stripping non-ASCII letters (accented Latin, CJK, …) collapses
    distinct names onto the same slug — the "unknown-unknown" collision that
    made 周杰伦/范特西 and 王菲/寓言 share one release. Non-ASCII names hash
    their NFC-normalized form instead, so identity stays lossless.
    """
    if text.isascii():
        return re.sub(r"[^a-z0-9]+", "-", text.casefold()).strip("-") or "unknown"
    normalized = unicodedata.normalize("NFC", text)
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:12]


def _release_slug(request: NowPlayingRequest) -> str:
    return f"{_slugify(request.artist)}-{_slugify(request.album)}"


def _first_release_year(value: str | None) -> int | None:
    if not value:
        return None
    match = re.match(r"(\d{4})", value)
    return int(match.group(1)) if match else None


def _request(job: EnrichmentJob) -> NowPlayingRequest:
    return NowPlayingRequest.model_validate(job.payload)


def _release_for(request: NowPlayingRequest, release_group) -> ReleaseEntity:
    return ReleaseEntity(
        id=_release_slug(request),
        title=release_group.title or request.album,
        artist_id=_slugify(request.artist),
        year=_first_release_year(release_group.first_release_date),
        artwork_url=release_group.artwork_url,
    )


def _musicbrainz_rating(mbid: str, release_group) -> Rating | None:
    """The MusicBrainz rating snapshot, on MusicBrainz's own 0–5 scale.

    ``rating`` is the community average and ``rating_votes`` its population
    count; when the release group has no rating there is no snapshot at all.
    """
    if release_group.rating is None:
        return None
    return Rating(
        provider="musicbrainz",
        value=release_group.rating,
        scale=5,
        vote_count=release_group.rating_votes or None,
        source_url=f"https://musicbrainz.org/release-group/{mbid}",
    )


# --- stage handlers -----------------------------------------------------------


def _resolve_entity(job: EnrichmentJob, lease_id: str, deps: PipelineDeps) -> bool:
    request = _request(job)
    key = request.lookup_key()
    result = resolve_release_group(key["artist"], key["album"], deps.musicbrainz)
    if result.status == "matched" and result.release_group is not None:
        deps.store.set_resolution(job.id, lease_id, result.release_group.mbid, "resolved")
        return True
    status = "unavailable" if result.status == "not-found" else "ambiguous"
    deps.store.set_resolution(job.id, lease_id, None, status)
    raise JobUnavailable(result.reason or "cannot resolve entity")


def _fetch_sources(job: EnrichmentJob, lease_id: str, deps: PipelineDeps) -> bool:
    mbid = job.resolved_release_group_id
    if not mbid:
        raise JobUnavailable("no resolved release group id")
    request = _request(job)
    # External HTTP, outside any database transaction.
    release_group = deps.musicbrainz.get_release_group(mbid)
    release = _release_for(request, release_group)
    artist = ArtistEntity(id=release.artist_id, name=request.artist)
    genres = genres_from_release_group(release_group)
    mb_rating = _musicbrainz_rating(mbid, release_group)

    # Persist the MusicBrainz entity, genres, and rating immediately, before the
    # slower source fetches, so title/year/genres/rating show as early as
    # possible.
    entity = IngestedContext(
        release=release,
        artist=artist,
        sources=[],
        review_documents=[],
        genres=genres,
        ratings=[mb_rating] if mb_rating else [],
    )
    with connect(autocommit=False) as conn:
        assert_active_lease(conn, job.id, lease_id)
        # Replace the previous metadata genre set (uncited) so a re-fetch drops
        # stale tag-based genres instead of accumulating them next to the new
        # curated genres.
        delete_metadata_genres(conn, uuid.UUID(stable_uuid("release", release.id)))
        seed(conn, entity)
        conn.commit()

    # Fetch CritiqueBrainz and Wikipedia in parallel; persist each source's
    # documents and rating as its request completes, so a fast source is not
    # held up by a slow one. Every write re-checks the active lease, so an
    # expired worker can neither overwrite review documents nor record the
    # corpus it fetched.
    all_documents = []
    source_errors = []
    for result in fetch_documents_parallel(
        release_group, release, release.title, deps.critiquebrainz, deps.wikipedia, deps.pitchfork
    ):
        if result.error:
            source_errors.append(f"{result.source.id}:{result.error}")
        if not result.documents and not result.rating:
            continue
        all_documents.extend(result.documents)
        partial = IngestedContext(
            release=release,
            artist=artist,
            sources=[result.source] if result.documents else [],
            review_documents=result.documents,
            ratings=[result.rating] if result.rating else [],
        )
        with connect(autocommit=False) as conn:
            assert_active_lease(conn, job.id, lease_id)
            seed(conn, partial)
            conn.commit()

    # A fetch where every source failed is a transient failure worth retrying,
    # distinct from "every source genuinely has no coverage" (empty corpus). Only
    # the former raises; an empty-but-successful corpus falls through to the
    # summary stage, which marks the job unavailable.
    if not all_documents and source_errors:
        raise RuntimeError("all sources failed to fetch: " + ", ".join(source_errors))

    # Record the corpus hash once every document is in.
    with connect(autocommit=False) as conn:
        assert_active_lease(conn, job.id, lease_id)
        record_corpus_hash(
            conn, job.id, lease_id, corpus_hash(corpus_from_documents(all_documents))
        )
        conn.execute(
            "UPDATE public.enrichment_jobs SET source_errors = %s WHERE id = %s",
            (source_errors, job.id),
        )
        conn.commit()
    return True


def _group_by_source(
    documents: list[StoredDocument],
) -> dict[tuple[str, str], list[StoredDocument]]:
    grouped: dict[tuple[str, str], list[StoredDocument]] = {}
    for document in documents:
        grouped.setdefault((document.source_id, license_pool(document.license_id)), []).append(
            document
        )
    return grouped


def _group_by_pool(documents: list[StoredDocument]) -> dict[str, list[StoredDocument]]:
    grouped: dict[str, list[StoredDocument]] = {}
    for document in documents:
        grouped.setdefault(license_pool(document.license_id), []).append(document)
    return grouped


def _existing_source_summaries(conn, release_slug: str, model: str) -> dict[tuple[str, str], str]:
    """Map source id -> corpus_hash of the current published summary.

    A source is only treated as "done" when its published generation was built
    from the same corpus hash, so a changed corpus triggers regeneration rather
    than a permanent skip.
    """
    rows = conn.execute(
        "SELECT source_id, license_pool, corpus_hash FROM public.summary_runs s "
        "JOIN public.releases r ON r.id = s.release_id "
        "WHERE r.slug = %s AND s.summary_kind = 'source' "
        "AND s.status = 'published' AND s.prompt_version = %s AND s.model = %s",
        (release_slug, PROMPT_VERSION, model),
    ).fetchall()
    return {(row[0], row[1]): row[2] for row in rows if row[0]}


def _existing_consensus_pools(conn, release_slug: str, model: str) -> dict[str, str]:
    """Map license pool -> corpus_hash of the current published block."""
    rows = conn.execute(
        "SELECT license_pool, corpus_hash FROM public.summary_runs s "
        "JOIN public.releases r ON r.id = s.release_id "
        "WHERE r.slug = %s AND s.summary_kind = 'consensus' "
        "AND s.status = 'published' AND ((s.prompt_version = %s AND s.model = %s) "
        "OR s.prompt_version = 'consensus-skip')",
        (release_slug, PROMPT_VERSION, model),
    ).fetchall()
    return {row[0]: row[1] for row in rows}


def _build_source_summaries(job: EnrichmentJob, lease_id: str, deps: PipelineDeps) -> bool:
    request = _request(job)
    slug = _release_slug(request)
    with connect() as conn:
        documents = read_stored_documents(conn, slug)
        done = _existing_source_summaries(conn, slug, deps.model)
    if not documents:
        return True
    by_source = _group_by_source(documents)
    # Spend the first model slots on criticism, not secondary background.
    ordered = sorted(
        by_source,
        key=lambda key: (key[0] == "wikipedia", key[0] == "critiquebrainz", key),
    )
    pending = [
        by_source[key]
        for key in ordered
        if done.get(key) != corpus_hash(_as_corpus(by_source[key]))
    ][:2]
    if not pending:
        return True
    deps.store.renew(job.id, lease_id)

    def generate(source_documents):
        first = source_documents[0]
        return summarize(
            _as_corpus(source_documents),
            model=deps.model,
            chat=deps.chat,
            kind="source",
            license_pool=license_pool(first.license_id),
            license_url=first.license_url,
            source_id=first.source_id,
            attribution=_attribution(first),
        )

    errors = []
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(generate, documents) for documents in pending]
        for future in as_completed(futures):
            try:
                summary = future.result()
                with connect(autocommit=False) as conn:
                    publish_summary(conn, slug, summary, job_id=job.id, lease_id=lease_id)
            except Exception as exc:
                errors.append(exc)
    # Keep successful publications even when the other source fails.
    if errors:
        raise errors[0]
    deps.store.commit(job.id, lease_id, stage=job.stage, state="queued")
    return False


def _build_consensus(job: EnrichmentJob, lease_id: str, deps: PipelineDeps) -> bool:
    request = _request(job)
    slug = _release_slug(request)
    with connect() as conn:
        documents = read_stored_documents(conn, slug)
        done = _existing_consensus_pools(conn, slug, deps.model)
    if not documents:
        return True
    by_pool = _group_by_pool(documents)
    for pool, pool_documents in by_pool.items():
        # Wikipedia often quotes the same reviews; it is not another critic.
        independent_reviews = [d for d in pool_documents if d.source_id != "wikipedia"]
        basis = independent_reviews or pool_documents
        pool_hash = corpus_hash(_as_corpus(basis))
        if done.get(pool) == pool_hash:
            continue
        distinct_sources = {d.source_id for d in independent_reviews}
        first = basis[0]
        attribution = _attribution(first)
        if len(distinct_sources) < 2:
            with connect(autocommit=False) as conn:
                publish_consensus_skipped(
                    conn,
                    slug,
                    license_pool=pool,
                    license_url=first.license_url,
                    attribution=attribution,
                    corpus_hash=pool_hash,
                    job_id=job.id,
                    lease_id=lease_id,
                )
        else:
            # Renew the lease before the model call so it cannot be reaped.
            deps.store.renew(job.id, lease_id)
            consensus = summarize(
                _as_corpus(independent_reviews),
                model=deps.model,
                chat=deps.chat,
                kind="consensus",
                license_pool=pool,
                license_url=first.license_url,
                attribution=attribution,
            )
            with connect(autocommit=False) as conn:
                publish_summary(conn, slug, consensus, job_id=job.id, lease_id=lease_id)
        deps.store.commit(job.id, lease_id, stage=job.stage, state="queued")
        return False
    return True


def _attribution(document: StoredDocument) -> str:
    return f"{document.publication} — {document.license_id}"


def _as_corpus(documents: list[StoredDocument]):
    from .summarize import CorpusDocument

    return [
        CorpusDocument(
            id=document.id, text=document.content,
            kind={"wikipedia": "background", "critiquebrainz": "community"}.get(
                document.source_id, "review"
            ),
        )
        for document in documents
    ]


def build_handlers(deps: PipelineDeps) -> dict[Stage, StageHandler]:
    """The real four-stage handler map, constructed from live dependencies.

    Each summary/consensus block publishes itself in a single transaction, so
    there is no release-wide publish stage: a job reaches ``ready`` when every
    source summary and license-pool block is published.
    """
    return {
        "resolve_entity": lambda job, lease_id: _resolve_entity(job, lease_id, deps),
        "fetch_sources": lambda job, lease_id: _fetch_sources(job, lease_id, deps),
        "build_source_summaries": lambda job, lease_id: _build_source_summaries(
            job, lease_id, deps
        ),
        "build_consensus": lambda job, lease_id: _build_consensus(job, lease_id, deps),
    }
