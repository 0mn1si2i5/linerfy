"""Wikipedia Reception-section adapter (a licensed v1 review source).

Only the article's critical-reception section is fetched, through the official
MediaWiki API, and treated as a corpus document under CC BY-SA. The adapter
extracts readable plain text from wikitext; nothing is scraped from the rendered
page.
"""

from __future__ import annotations

import json
import re
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any

from .models import (
    ReleaseEntity,
    ReviewDocument,
    ReviewSource,
    SourcePolicy,
)

_API_BASE = "https://en.wikipedia.org/w/api.php"
_USER_AGENT = "Linerfy/0.0 (music-criticism companion; rights@linerfy.local)"

# Section headings that carry the critical reception.
_RECEPTION_HEADINGS = (
    "reception",
    "critical reception",
    "critical response",
    "critical reviews",
    "reception and legacy",
)

_REF_RE = re.compile(r"<ref[^>]*>.*?</ref>|<ref[^>]*/>", re.DOTALL | re.IGNORECASE)
_TEMPLATE_RE = re.compile(r"\{\{[^{}]*\}\}")
_LINK_RE = re.compile(r"\[\[([^\]|]*\|)?([^\]]*)\]\]")
_TAG_RE = re.compile(r"<[^>]+>")
_SMART_QUOTES = str.maketrans({"’": "'", "‘": "'", "“": '"', "”": '"'})


def normalize_article_title(title: str) -> str:
    """Normalize typographic quotes that prevent exact MediaWiki title lookup."""
    normalized = title.translate(_SMART_QUOTES)
    # MediaWiki normalizes the literal first character, but not the first word
    # when a title starts with punctuation such as "(pronounced ...)".
    return re.sub(
        r"^(\W*)([a-z])",
        lambda match: match.group(1) + match.group(2).upper(),
        normalized,
        count=1,
    )


def article_title_matches(requested: str, candidate: str) -> bool:
    """Accept an exact title or the same title with a disambiguation suffix."""
    requested_key = normalize_article_title(requested).casefold().strip()
    candidate_key = normalize_article_title(candidate).casefold().strip()
    return candidate_key == requested_key or candidate_key.startswith(requested_key + " (")


def strip_wikitext(raw: str) -> str:
    """Extract plain text from a section's wikitext.

    This is a conservative, best-effort cleanup for corpus use: references and
    templates are removed, wiki links collapse to their visible label, and the
    result is whitespace-normalised.
    """
    text = _REF_RE.sub("", raw)
    # Nested templates are rare in reception prose; strip a bounded depth.
    for _ in range(4):
        text = _TEMPLATE_RE.sub("", text)
    text = _LINK_RE.sub(lambda m: m.group(2) or m.group(1) or "", text)
    text = _TAG_RE.sub("", text)
    text = text.replace("'''", "").replace("''", "")
    lines = [re.sub(r"\s+", " ", line).strip() for line in text.split("\n")]
    return " ".join(line for line in lines if line).strip()


@dataclass(frozen=True)
class ReceptionSection:
    title: str
    plain_text: str
    article_title: str | None = None
    review_urls: tuple[str, ...] = ()


class WikipediaAdapter:
    """Read-only MediaWiki client, stubbable via ``_get_json`` for tests."""

    def __init__(self, user_agent: str = _USER_AGENT) -> None:
        self.user_agent = user_agent

    def _get_json(self, url: str) -> dict[str, Any]:
        request = urllib.request.Request(url, headers={"User-Agent": self.user_agent})
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.loads(response.read().decode("utf-8"))

    def list_sections(self, title: str) -> list[dict[str, Any]]:
        url = f"{_API_BASE}?action=parse&page={urllib.parse.quote(title)}&prop=sections&format=json"
        payload = self._get_json(url)
        return payload.get("parse", {}).get("sections", [])

    def section_wikitext(self, title: str, index: str) -> str:
        url = (
            f"{_API_BASE}?action=parse&page={urllib.parse.quote(title)}"
            f"&prop=wikitext&section={index}&format=json"
        )
        payload = self._get_json(url)
        return payload.get("parse", {}).get("wikitext", {}).get("*", "")

    def search_article_titles(self, title: str, artist: str) -> list[str]:
        query = f'"{title}" {artist} album'
        url = (
            f"{_API_BASE}?action=query&list=search"
            f"&srsearch={urllib.parse.quote(query)}&srlimit=3&format=json"
        )
        payload = self._get_json(url)
        return [
            str(item["title"])
            for item in payload.get("query", {}).get("search", [])
            if item.get("title")
        ]

    def reception_section(
        self, title: str, *, artist: str | None = None
    ) -> ReceptionSection | None:
        """Return a reception section from the exact or a searched article."""
        normalized = normalize_article_title(title)
        exact = self._reception_section_for_title(normalized, artist=artist)
        if exact is not None or not artist:
            return exact
        for article_title in dict.fromkeys(self.search_article_titles(normalized, artist)):
            if not article_title_matches(normalized, article_title):
                continue
            found = self._reception_section_for_title(article_title, artist=artist)
            if found is not None:
                return found
        return None

    def _reception_section_for_title(
        self, article_title: str, *, artist: str | None = None
    ) -> ReceptionSection | None:
        """Read one exact MediaWiki article title without doing discovery."""
        if artist:
            lead = self.section_wikitext(article_title, "0")
            if not re.search(r"\{\{\s*Infobox\s+(album|song|single)\b", lead, re.I):
                return None
            artist_field = re.search(r"^\|\s*artist\s*=\s*([^\n]+)", lead, re.M | re.I)
            if artist_field is None:
                return None

            def key(value):
                return re.sub(r"[^\w]+", "", strip_wikitext(value).casefold())

            if key(artist_field.group(1)) != key(artist):
                return None
        for section in self.list_sections(article_title):
            line = (section.get("line") or "").strip().lower()
            if line in _RECEPTION_HEADINGS:
                index = str(section.get("index", ""))
                if index:
                    wikitext = self.section_wikitext(article_title, index)
                    return ReceptionSection(
                        title=section.get("line", "Reception"),
                        plain_text=strip_wikitext(wikitext),
                        article_title=article_title,
                        review_urls=tuple(
                            dict.fromkeys(
                                re.findall(
                                    r"https://(?:www\.)?pitchfork\.com/reviews/albums/[^\s|}<\]\"']+",
                                    wikitext,
                                )
                            )
                        ),
                    )
        return None


WIKIPEDIA_SOURCE = ReviewSource(
    id="wikipedia",
    publication="Wikipedia",
    homepage_url="https://en.wikipedia.org",
)

WIKIPEDIA_POLICY = SourcePolicy(
    source_id="wikipedia",
    crawl_allowed=True,
    requests_per_minute=30,
    retention_days=30,
    excerpt_max_chars=280,
    attribution_required=True,
    removal_contact="rights@linerfy.local",
    license_id="CC BY-SA 4.0",
    license_url="https://creativecommons.org/licenses/by-sa/4.0/",
)


def page_url(title: str) -> str:
    """Canonical Wikipedia URL for an article title."""
    return f"https://en.wikipedia.org/wiki/{urllib.parse.quote(title.replace(' ', '_'))}"


def to_document(
    section: ReceptionSection, release: ReleaseEntity, article_title: str
) -> ReviewDocument:
    """Wrap a reception section in a ReviewDocument for the given release."""
    excerpt = section.plain_text[: WIKIPEDIA_POLICY.excerpt_max_chars]
    return ReviewDocument(
        id=f"wikipedia-{release.id}-reception",
        release_id=release.id,
        source_id=WIKIPEDIA_SOURCE.id,
        source_url=page_url(section.article_title or article_title),
        title=f"{release.title} — {section.title}",
        author=None,
        published_at=None,
        score=None,
        score_scale=None,
        public_excerpt=excerpt,
        content=section.plain_text,
        license_id=WIKIPEDIA_POLICY.license_id,
        license_url=WIKIPEDIA_POLICY.license_url,
        policy=WIKIPEDIA_POLICY,
    )
