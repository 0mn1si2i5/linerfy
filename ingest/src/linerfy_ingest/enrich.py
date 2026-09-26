"""Compose the enrichment pipeline: entity resolution, source fetch, summarization.

This is the glue the worker's stage handlers call. It turns a resolved release
group into review documents (CritiqueBrainz, Wikipedia, referenced Pitchfork reviews),
maps them to a summarizer corpus, and produces a provenance-checked summary.
"""

from __future__ import annotations

from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from dataclasses import dataclass

from .critiquebrainz import CRITIQUEBRAINZ_SOURCE, CritiqueBrainzAdapter
from .critiquebrainz import to_document as cb_document
from .entities import ReleaseGroup
from .models import (
    Genre,
    Rating,
    ReleaseEntity,
    ReviewDocument,
    ReviewSource,
    Summary,
    license_pool,
)
from .pitchfork import PITCHFORK_SOURCE, PitchforkAdapter, review_url
from .summarize import CorpusDocument, summarize
from .wikipedia import WIKIPEDIA_SOURCE, WikipediaAdapter, normalize_article_title
from .wikipedia import to_document as wiki_document


def corpus_from_documents(documents: list[ReviewDocument]) -> list[CorpusDocument]:
    """Map stored review documents to the summarizer's corpus shape.

    The full body is the summarization input; it never becomes public.
    """
    return [
        CorpusDocument(
            id=document.id,
            text=document.content,
            kind={"wikipedia": "background", "critiquebrainz": "community"}.get(
                document.source_id, "review"
            ),
        )
        for document in documents
        if document.content and document.content.strip()
    ]


def pool_for_document(document: ReviewDocument) -> str:
    """The license-compatibility pool a document belongs to.

    Keyed on the document's own license (not the source policy), so two reviews
    from one source under different licenses stay in separate pools.
    """
    return license_pool(document.license_id)


def group_by_pool(
    documents: list[ReviewDocument],
) -> dict[str, list[ReviewDocument]]:
    """Partition documents so each license pool is summarized separately."""
    grouped: dict[str, list[ReviewDocument]] = {}
    for document in documents:
        grouped.setdefault(pool_for_document(document), []).append(document)
    return grouped


_MAX_GENRES = 5


def genres_from_release_group(release_group: ReleaseGroup) -> list[Genre]:
    """Return a short, deduplicated genre list from MusicBrainz's curated genres.

    MusicBrainz's ``genres`` list is maintained and voted on, so it needs no
    provenance denylist (unlike the user-supplied ``tags`` folksonomy, which
    carried languages, regions, eras and chart positions). The most-voted genres
    survive, ordered by vote count and capped at a handful, so a low-confidence
    genre never displaces a stronger one. No reliable genre leaves the list
    empty.
    """
    ranked = sorted(release_group.genres, key=lambda genre: genre.count, reverse=True)
    genres: list[Genre] = []
    seen: set[str] = set()
    for item in ranked:
        name = " ".join(item.name.split())
        key = name.casefold()
        if not name or key in seen or item.count <= 0:
            continue
        seen.add(key)
        genres.append(Genre(name=name.title() if name.islower() else name, source_ids=[]))
        if len(genres) == _MAX_GENRES:
            break
    return genres


@dataclass(frozen=True)
class SourceFetchResult:
    """One source's fetched documents plus its optional rating snapshot.

    ``error`` is the exception type name when the source's fetch failed (so a
    slow or failing source never blocks a faster one, and the caller can tell a
    genuine "no coverage" from a remote/parse failure).
    """

    source: ReviewSource
    documents: list[ReviewDocument]
    rating: Rating | None = None
    error: str | None = None
    review_urls: tuple[str, ...] = ()


def _cb_rating(listing, release_group: ReleaseGroup) -> Rating | None:
    """The official CritiqueBrainz aggregate rating, if the listing carries one.

    ``average_rating`` is the provider's own value + population count on its
    0–5 scale; the individual per-review ratings are not averaged locally.
    """
    if listing.average_rating is None:
        return None
    return Rating(
        provider=CRITIQUEBRAINZ_SOURCE.id,
        value=listing.average_rating,
        scale=5,
        vote_count=listing.rating_count or None,
        source_url=f"https://critiquebrainz.org/release-group/{release_group.mbid}",
    )


def build_documents(
    release_group: ReleaseGroup,
    release: ReleaseEntity,
    article_title: str,
    critiquebrainz: CritiqueBrainzAdapter,
    wikipedia: WikipediaAdapter,
) -> list[ReviewDocument]:
    """Fetch licensed review documents for a resolved release group.

    Rating-only CritiqueBrainz reviews are dropped here: they carry no body, so
    they are not review documents and must not be summarized.
    """
    listing = critiquebrainz.search_reviews(release_group.mbid)
    documents: list[ReviewDocument] = []
    for review in listing.reviews:
        document = cb_document(review, release)
        if document is not None:
            documents.append(document)
    article_title = normalize_article_title(article_title)
    reception = wikipedia.reception_section(article_title, artist=release_group.artist)
    if reception is not None:
        documents.append(wiki_document(reception, release, article_title))
    return documents


def fetch_documents_parallel(
    release_group: ReleaseGroup,
    release: ReleaseEntity,
    article_title: str,
    critiquebrainz: CritiqueBrainzAdapter,
    wikipedia: WikipediaAdapter,
    pitchfork: PitchforkAdapter | None = None,
):
    """Fetch CritiqueBrainz and Wikipedia in parallel, yielding per source.

    Yields one ``SourceFetchResult`` per source, in completion order, so the
    caller persists a fast source's documents (and rating) as soon as it
    finishes, without waiting for the slower one. A source that raises is
    yielded as an empty result carrying its ``error`` label, so one source's
    failure never prevents the other from being saved.
    """
    article_title = normalize_article_title(article_title)

    def fetch_cb() -> SourceFetchResult:
        try:
            listing = critiquebrainz.search_reviews(release_group.mbid)
            documents = [
                document
                for review in listing.reviews
                if (document := cb_document(review, release)) is not None
            ]
            return SourceFetchResult(
                CRITIQUEBRAINZ_SOURCE, documents, _cb_rating(listing, release_group)
            )
        except Exception as exc:  # noqa: BLE001 — isolate one source's failure
            return SourceFetchResult(CRITIQUEBRAINZ_SOURCE, [], error=type(exc).__name__)

    def fetch_wiki() -> SourceFetchResult:
        try:
            reception = wikipedia.reception_section(article_title, artist=release_group.artist)
            if reception is None:
                return SourceFetchResult(WIKIPEDIA_SOURCE, [])
            return SourceFetchResult(
                WIKIPEDIA_SOURCE,
                [wiki_document(reception, release, article_title)],
                review_urls=reception.review_urls,
            )
        except Exception as exc:  # noqa: BLE001 — isolate one source's failure
            return SourceFetchResult(WIKIPEDIA_SOURCE, [], error=type(exc).__name__)

    def fetch_media(urls: tuple[str, ...]) -> SourceFetchResult:
        candidates = list(dict.fromkeys(url for value in urls if (url := review_url(value))))[:2]
        failed = False
        for url in candidates:
            try:
                document = pitchfork.fetch(url, release, release_group.artist)
                return SourceFetchResult(PITCHFORK_SOURCE, [document])
            except Exception:
                failed = True
        return SourceFetchResult(
            PITCHFORK_SOURCE, [], error="ReviewFetchFailed" if failed else None
        )

    with ThreadPoolExecutor(max_workers=2) as pool:
        pending = {pool.submit(fetch_cb), pool.submit(fetch_wiki)}
        while pending:
            finished, pending = wait(pending, return_when=FIRST_COMPLETED)
            for future in finished:
                result = future.result()
                yield result
                if pitchfork is not None and result.source.id == "wikipedia":
                    if result.error:
                        yield SourceFetchResult(PITCHFORK_SOURCE, [], error="DiscoveryFailed")
                    else:
                        pending.add(pool.submit(fetch_media, result.review_urls))


def enrich_release(
    release: ReleaseEntity,
    release_group: ReleaseGroup,
    article_title: str,
    critiquebrainz: CritiqueBrainzAdapter,
    wikipedia: WikipediaAdapter,
    *,
    model: str,
    chat,
) -> dict[str, Summary]:
    """Fetch sources and summarize each license pool separately.

    Incompatible licenses are never merged into one corpus, so no claim can
    cite documents from two different pools. The result maps pool id (a license
    id) to that pool's validated summary.
    """
    documents = build_documents(release_group, release, article_title, critiquebrainz, wikipedia)
    summaries: dict[str, Summary] = {}
    for pool, pool_documents in group_by_pool(documents).items():
        summaries[pool] = summarize(corpus_from_documents(pool_documents), model=model, chat=chat)
    return summaries
