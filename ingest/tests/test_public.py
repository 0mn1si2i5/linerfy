import json
from pathlib import Path

from linerfy_ingest import FixtureSourceAdapter, to_public

FIXTURE = Path(__file__).parent.parent / "fixtures" / "reviews.json"
# The shared fixture both languages agree on: Python produces it, Zod re-validates it.
SHARED = Path(__file__).resolve().parents[2] / "packages" / "domain" / "src" / "nfr.json"


def load_public() -> dict:
    return to_public(FixtureSourceAdapter(FIXTURE).fetch())


def test_public_output_matches_shared_fixture() -> None:
    assert load_public() == json.loads(SHARED.read_text(encoding="utf-8"))


def test_public_output_has_camel_case_shape() -> None:
    public = load_public()

    assert set(public) == {
        "scope",
        "artist",
        "release",
        "recordings",
        "genres",
        "ratings",
        "sources",
        "excerpts",
        "sourceSummaries",
        "consensusBlocks",
    }
    assert public["scope"] == "album"
    assert public["release"]["artistId"] == public["artist"]["id"]


def test_public_output_maps_ratings() -> None:
    from linerfy_ingest.models import ArtistEntity, IngestedContext, Rating, ReleaseEntity

    context = IngestedContext(
        release=ReleaseEntity(id="r", title="T", artist_id="a"),
        artist=ArtistEntity(id="a", name="A"),
        sources=[],
        review_documents=[],
        ratings=[
            Rating(
                provider="musicbrainz",
                value=4.2,
                scale=5,
                vote_count=87,
                source_url="https://musicbrainz.org/release-group/x",
            )
        ],
    )
    public = to_public(context)
    assert public["ratings"] == [
        {
            "provider": "musicbrainz",
            "value": 4.2,
            "scale": 5,
            "voteCount": 87,
            "sourceUrl": "https://musicbrainz.org/release-group/x",
        }
    ]


def test_public_output_distinguishes_sources_from_consensus() -> None:
    public = load_public()

    source_ids = [summary["source"]["id"] for summary in public["sourceSummaries"]]
    assert set(source_ids) == {"pitchfork", "guardian"}
    assert len(public["consensusBlocks"]) == 1
    consensus = public["consensusBlocks"][0]
    assert consensus["licensePool"] == "proprietary"
    assert set(consensus["sourceIds"]) == {"pitchfork", "guardian"}
    assert consensus["license"]["id"] == "proprietary"


def test_every_citation_resolves_to_a_public_source() -> None:
    public = load_public()

    source_ids = {source["id"] for source in public["sources"]}
    assert all(excerpt["sourceId"] in source_ids for excerpt in public["excerpts"])
    assert all(
        genre_source in source_ids
        for genre in public["genres"]
        for genre_source in genre["sourceIds"]
    )
    summaries_claims = [
        claim
        for summary in public["sourceSummaries"]
        for claim in summary["claims"]
    ]
    consensus_claims = [
        claim for block in public["consensusBlocks"] for claim in block["claims"]
    ]
    for claim in summaries_claims + consensus_claims:
        assert all(claim_source in source_ids for claim_source in claim["sourceIds"])
