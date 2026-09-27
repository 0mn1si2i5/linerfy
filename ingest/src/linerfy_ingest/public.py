"""Map an IngestedContext to the public MusicContext shape consumed by clients.

This is the delivery boundary. The ingest contract (snake_case, provenance
focused) and the public contract (camelCase, display shaped, validated by Zod in
`packages/domain`) are intentionally different objects; this module is the only
place that translates between them. The two sides agree on a shared JSON fixture
that Python produces and Zod re-validates.
"""

from __future__ import annotations

from datetime import datetime

from .models import IngestedContext


def _iso_z(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


def _omit_none(mapping: dict) -> dict:
    return {key: value for key, value in mapping.items() if value is not None}


def _publication_name(context: IngestedContext, source_id: str) -> str:
    for source in context.sources:
        if source.id == source_id:
            return source.publication
    raise ValueError(f"unknown source: {source_id}")


def _source_role(source_id: str) -> str:
    if source_id == "wikipedia":
        return "background"
    if source_id == "critiquebrainz":
        return "community"
    return "review"


def _summary_claims(summary) -> list[dict]:
    return [
        {"id": f"claim-{order + 1}", "text": claim.text, "sourceIds": claim.source_ids}
        for order, claim in enumerate(summary.claims)
    ]


def _license(summary) -> dict:
    return {"id": summary.license_pool, "url": summary.license_url}


def to_public(context: IngestedContext) -> dict:
    sources = [
        _omit_none(
            {
                "id": document.id,
                "providerId": document.source_id,
                "role": _source_role(document.source_id),
                "publication": _publication_name(context, document.source_id),
                "author": document.author,
                "title": document.title,
                "url": document.source_url,
                "publishedAt": document.published_at.isoformat()
                if document.published_at
                else None,
                "score": (
                    {"value": document.score, "scale": document.score_scale}
                    if document.score is not None and document.score_scale is not None
                    else None
                ),
            }
        )
        for document in context.review_documents
    ]

    excerpts = [
        {
            "id": f"{document.id}-excerpt",
            "sourceId": document.id,
            "text": document.public_excerpt,
            "kind": "paraphrase",
        }
        for document in context.review_documents
    ]

    publication = {source.id: source.publication for source in context.sources}

    # A consensus block scopes itself to the sources that share its license pool;
    # those sources are the per-source summaries written with the same pool. Build
    # the per-source summaries first so the consensus blocks can cite them.
    source_summaries: list[dict] = []
    source_ids_by_pool: dict[str, list[str]] = {}
    for summary in context.summaries:
        if summary.kind == "source" and summary.source_id is not None:
            role = _source_role(summary.source_id)
            if role == "background" or not summary.claims:
                continue
            source_summaries.append(
                {
                    "source": {
                        "id": summary.source_id,
                        "publication": publication.get(summary.source_id, ""),
                        "role": role,
                    },
                    "license": _license(summary),
                    "attribution": summary.attribution,
                    "aiModified": summary.ai_modified,
                    "claims": _summary_claims(summary),
                }
            )
            source_ids_by_pool.setdefault(summary.license_pool, []).append(
                summary.source_id
            )
    source_summaries.sort(
        key=lambda summary: 0 if summary["source"]["role"] == "review" else 1
    )

    consensus_blocks: list[dict] = []
    for summary in context.summaries:
        if summary.kind != "consensus":
            continue
        block = {
            "licensePool": summary.license_pool,
            "license": _license(summary),
            "sourceIds": list(dict.fromkeys(source_ids_by_pool.get(summary.license_pool, []))),
            "attribution": summary.attribution,
            "aiModified": summary.ai_modified,
            "claims": _summary_claims(summary),
        }
        if summary.skipped_reason:
            block["skippedReason"] = summary.skipped_reason
        consensus_blocks.append(block)

    return {
        "scope": "album",
        "artist": {"id": context.artist.id, "name": context.artist.name},
        "release": _omit_none(
            {
                "id": context.release.id,
                "title": context.release.title,
                "artistId": context.release.artist_id,
                "year": context.release.year,
                "artworkUrl": context.release.artwork_url,
            }
        ),
        "recordings": [],
        "genres": [
            {"name": genre.name, "sourceIds": genre.source_ids}
            for genre in context.genres
        ],
        "ratings": [
            _omit_none(
                {
                    "provider": rating.provider,
                    "value": rating.value,
                    "scale": rating.scale,
                    "voteCount": rating.vote_count,
                    "sourceUrl": rating.source_url,
                }
            )
            for rating in context.ratings
        ],
        "sources": sources,
        "excerpts": excerpts,
        "sourceSummaries": source_summaries,
        "consensusBlocks": consensus_blocks,
    }
