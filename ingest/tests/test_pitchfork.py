"""Structured album-review parsing with synthetic, non-article review text."""

from __future__ import annotations

import json
from datetime import date

import pytest

from linerfy_ingest.models import ReleaseEntity
from linerfy_ingest.pitchfork import parse_review, review_url

_URL = "https://pitchfork.com/reviews/albums/charli-xcx-wuthering-heights/"
_RELEASE = ReleaseEntity(
    id="test-charli-wuthering-heights", title="Wuthering Heights", artist_id="charli-xcx"
)
_BODY = (
    "The clipped drums leave space around the vocal. Distorted strings enter in the second verse, "
    "while the final refrain replaces the percussion with a sustained bass tone. "
    "These are synthetic observations written only for the parser test."
)


def _review() -> dict:
    return {
        "@type": "Review",
        "url": _URL,
        "itemReviewed": {"@type": "MusicAlbum", "name": "Charli XCX: Wuthering Heights"},
        "reviewBody": _BODY,
        "author": [{"@type": "Person", "name": "Test Reviewer"}],
        "datePublished": "2026-02-13T10:00:00Z",
    }


def _page(review: dict) -> str:
    data = {"@context": "https://schema.org", "@graph": [{"@type": "WebSite"}, review]}
    return f'<html><script type="application/ld+json">{json.dumps(data)}</script></html>'


@pytest.mark.parametrize("with_score", [False, True])
def test_structured_album_review_preserves_identity_body_author_and_optional_score(with_score):
    payload = _review()
    if with_score:
        payload["reviewRating"] = {"ratingValue": "8.1", "bestRating": "10"}
    doc = parse_review(_page(payload), _URL, _RELEASE, "charli xcx")
    assert doc.source_id == "pitchfork"
    assert doc.release_id == _RELEASE.id
    assert doc.source_url == _URL
    assert doc.title == "Charli XCX: Wuthering Heights"
    assert doc.author == "Test Reviewer"
    assert doc.published_at == date(2026, 2, 13)
    assert doc.content == _BODY
    assert (doc.score, doc.score_scale) == ((8.1, 10) if with_score else (None, None))


@pytest.mark.parametrize("problem", ["wrong-artist", "novel", "empty-body"])
def test_rejects_mismatched_work_or_missing_review_body(problem):
    payload = _review()
    if problem == "wrong-artist":
        payload["itemReviewed"]["name"] = "Another Artist: Wuthering Heights"
    elif problem == "novel":
        payload["itemReviewed"] = {"@type": "Book", "name": "Emily Brontë: Wuthering Heights"}
    else:
        payload["reviewBody"] = "   "
    with pytest.raises(ValueError, match="missing or mismatched"):
        parse_review(_page(payload), _URL, _RELEASE, "Charli XCX")


def test_structured_review_url_must_match_the_requested_article():
    payload = _review()
    payload["url"] = "https://pitchfork.com/reviews/albums/another-review/"
    with pytest.raises(ValueError, match="missing or mismatched"):
        parse_review(_page(payload), _URL, _RELEASE, "Charli XCX")


def test_review_url_accepts_only_pitchfork_album_review_paths():
    assert review_url(_URL) == _URL
    assert review_url(_URL.replace("pitchfork.com", "www.pitchfork.com") + "?ref=wiki") == _URL
    for invalid in (
        "http://pitchfork.com/reviews/albums/test/",
        "https://pitchfork.com.example.org/reviews/albums/test/",
        "https://pitchfork.com/news/test/",
        "https://pitchfork.com/reviews/albums/",
        "https://user@pitchfork.com/reviews/albums/test/",
        "https://pitchfork.com:444/reviews/albums/test/",
    ):
        assert review_url(invalid) is None
