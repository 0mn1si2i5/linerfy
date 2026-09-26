"""Fixture-based tests for the Wikipedia Reception adapter, no network."""

from __future__ import annotations

from linerfy_ingest.models import ReleaseEntity
from linerfy_ingest.wikipedia import (
    WIKIPEDIA_POLICY,
    WikipediaAdapter,
    article_title_matches,
    normalize_article_title,
    page_url,
    strip_wikitext,
    to_document,
)

_RELEASE = ReleaseEntity(
    id="norman-fucking-rockwell",
    title="Norman Fucking Rockwell!",
    artist_id="lana-del-rey",
    year=2019,
)

_SECTIONS_PAYLOAD = {
    "parse": {
        "sections": [
            {"index": "1", "line": "Background", "level": "2"},
            {"index": "2", "line": "Critical reception", "level": "2"},
        ]
    }
}

_WIKITEXT_PAYLOAD = {
    "parse": {
        "wikitext": {
            "*": (
                "Critical response was positive.<ref name=pfk>{{cite web "
                "|title=Pitchfork review}}</ref> The album was praised for its "
                "[[singer-songwriter|songwriting]] and '''restraint'''."
            )
        }
    }
}


class FakeWikipedia(WikipediaAdapter):
    def __init__(self, sections: dict, wikitext: dict):
        super().__init__()
        self.sections = sections
        self.wikitext = wikitext
        self.urls: list[str] = []

    def _get_json(self, url: str) -> dict:
        self.urls.append(url)
        if "prop=sections" in url:
            return self.sections
        return self.wikitext


def test_strip_wikitext_removes_refs_templates_and_links() -> None:
    text = strip_wikitext(_WIKITEXT_PAYLOAD["parse"]["wikitext"]["*"])
    assert "songwriting" in text
    assert "restraint" in text
    assert "cite web" not in text
    assert "[[" not in text and "]]" not in text


def test_reception_section_finds_the_heading() -> None:
    adapter = FakeWikipedia(_SECTIONS_PAYLOAD, _WIKITEXT_PAYLOAD)
    section = adapter.reception_section("Norman Fucking Rockwell!")
    assert section is not None
    assert section.title == "Critical reception"
    assert "songwriting" in section.plain_text


def test_reception_section_returns_none_without_heading() -> None:
    adapter = FakeWikipedia(
        {"parse": {"sections": [{"index": "1", "line": "Track listing", "level": "2"}]}},
        _WIKITEXT_PAYLOAD,
    )
    assert adapter.reception_section("Some Album") is None


def test_reception_section_uses_a_ranked_article_fallback() -> None:
    class SearchingWikipedia(WikipediaAdapter):
        def search_article_titles(self, title: str, artist: str) -> list[str]:
            assert artist == "Lynyrd Skynyrd"
            return ["MusicBrainz title (album)"]

        def list_sections(self, title: str) -> list[dict]:
            return (
                []
                if title != "MusicBrainz title (album)"
                else [{"index": "2", "line": "Reception"}]
            )

        def section_wikitext(self, title: str, index: str) -> str:
            if index == "0":
                return "{{Infobox album\n| artist = [[Lynyrd Skynyrd]]\n}}"
            return "The album received positive reviews."

    section = SearchingWikipedia().reception_section("MusicBrainz title", artist="Lynyrd Skynyrd")
    assert section is not None
    assert section.article_title == "MusicBrainz title (album)"


def test_album_lookup_rejects_same_named_novel_and_other_artist():
    class Albums(WikipediaAdapter):
        def search_article_titles(self, title, artist):
            return ["Wuthering Heights (album)", "Wuthering Heights (soundtrack)"]

        def list_sections(self, title):
            return [{"index": "2", "line": "Critical reception"}]

        def section_wikitext(self, title, index):
            if index == "0":
                if title.endswith("(soundtrack)"):
                    return "{{Infobox album\n| artist = [[Charli XCX]]\n}}"
                if title.endswith("(album)"):
                    return "{{Infobox album\n| artist = Different Artist\n}}"
                return "{{Infobox book\n| author = Emily Brontë\n}}"
            return "Correct soundtrack review" if title.endswith("(soundtrack)") else "Wrong work"

    found = Albums().reception_section("Wuthering Heights", artist="Charli xcx")
    assert found is not None
    assert found.article_title == "Wuthering Heights (soundtrack)"
    assert found.plain_text == "Correct soundtrack review"


def test_page_url_encodes_title() -> None:
    assert page_url("Norman Fucking Rockwell!") == (
        "https://en.wikipedia.org/wiki/Norman_Fucking_Rockwell%21"
    )


def test_normalize_article_title_replaces_musicbrainz_smart_quotes() -> None:
    assert normalize_article_title("(pronounced ’lĕh-’nérd ’skin-’nérd)") == (
        "(Pronounced 'lĕh-'nérd 'skin-'nérd)"
    )


def test_article_title_match_allows_disambiguation_but_rejects_other_albums() -> None:
    assert article_title_matches("Shelly", "Shelly (album)")
    assert not article_title_matches("Shelly", "Empathy (Bill Evans and Shelly Manne album)")


def test_to_document_bounds_excerpt_and_sets_policy() -> None:
    section = FakeWikipedia(_SECTIONS_PAYLOAD, _WIKITEXT_PAYLOAD).reception_section(
        "Norman Fucking Rockwell!"
    )
    assert section is not None
    document = to_document(section, _RELEASE, "Norman Fucking Rockwell!")
    assert document.source_id == "wikipedia"
    assert document.source_url.endswith("Norman_Fucking_Rockwell%21")
    assert len(document.public_excerpt) <= WIKIPEDIA_POLICY.excerpt_max_chars
    assert document.policy.source_id == "wikipedia"
    assert document.score is None
