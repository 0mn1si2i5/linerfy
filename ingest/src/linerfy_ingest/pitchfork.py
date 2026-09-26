"""Read a referenced Pitchfork album review with independent identity checks."""

from __future__ import annotations

import html
import json
import re
import unicodedata
import urllib.parse
import urllib.request
from datetime import date
from html.parser import HTMLParser

from .models import ReleaseEntity, ReviewDocument, ReviewSource, SourcePolicy

PITCHFORK_SOURCE = ReviewSource(
    id="pitchfork", publication="Pitchfork", homepage_url="https://pitchfork.com"
)
PITCHFORK_POLICY = SourcePolicy(
    source_id="pitchfork",
    crawl_allowed=True,
    requests_per_minute=10,
    retention_days=30,
    excerpt_max_chars=280,
    attribution_required=True,
    removal_contact="local",
    license_id="proprietary",
    license_url="https://www.condenast.com/user-agreement",
)


def review_url(value: str) -> str | None:
    try:
        parsed = urllib.parse.urlsplit(html.unescape(value))
        if parsed.scheme != "https" or parsed.hostname not in {
            "pitchfork.com",
            "www.pitchfork.com",
        }:
            return None
        if parsed.username or parsed.password or parsed.port not in {None, 443}:
            return None
    except ValueError:
        return None
    if not re.fullmatch(r"/reviews/albums/[a-z0-9-]+/?", parsed.path):
        return None
    return "https://pitchfork.com" + parsed.path.rstrip("/") + "/"


class _StructuredData(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.scripts: list[str] = []
        self.current: list[str] | None = None

    def handle_starttag(self, tag, attrs):
        if tag == "script" and dict(attrs).get("type") == "application/ld+json":
            self.current = []

    def handle_data(self, data):
        if self.current is not None:
            self.current.append(data)

    def handle_endtag(self, tag):
        if tag == "script" and self.current is not None:
            self.scripts.append("".join(self.current))
            self.current = None


def _objects(value):
    if isinstance(value, list):
        for item in value:
            yield from _objects(item)
    elif isinstance(value, dict):
        yield value
        yield from _objects(value.get("@graph"))


def _key(value: str) -> str:
    return re.sub(r"[^\w]+", "", unicodedata.normalize("NFKC", html.unescape(value)).casefold())


def parse_review(page: str, url: str, release: ReleaseEntity, artist: str) -> ReviewDocument:
    canonical = review_url(url)
    if not canonical:
        raise ValueError("not an album-review URL")
    parser = _StructuredData()
    parser.feed(page)
    for raw in parser.scripts:
        try:
            objects = list(_objects(json.loads(raw)))
        except ValueError:
            continue
        for item in objects:
            if item.get("@type") != "Review":
                continue
            work = item.get("itemReviewed") or {}
            name = work.get("name", "") if isinstance(work, dict) else ""
            # Pitchfork's identity is "Artist: Album", independent of URL slug.
            if not isinstance(name, str) or _key(name) != _key(f"{artist}: {release.title}"):
                continue
            if review_url(item.get("url", "")) != canonical:
                continue
            body = item.get("reviewBody")
            if not isinstance(body, str) or len(body.strip()) < 120:
                continue
            authors = item.get("author", [])
            if isinstance(authors, dict):
                authors = [authors]
            author = ", ".join(a["name"] for a in authors if isinstance(a, dict) and a.get("name"))
            rating = item.get("reviewRating") or {}
            score, scale = rating.get("ratingValue"), rating.get("bestRating", 10)
            try:
                score, scale = float(score), int(scale)
                if not 0 <= score <= scale:
                    score, scale = None, None
            except (ValueError, TypeError):
                score, scale = None, None
            # Missing structured score stays missing, not a related album's score.
            return ReviewDocument(
                id=f"pitchfork-{release.id}",
                release_id=release.id,
                source_id="pitchfork",
                source_url=canonical,
                title=name,
                author=author or None,
                published_at=date.fromisoformat(item["datePublished"][:10])
                if item.get("datePublished")
                else None,
                score=score,
                score_scale=scale,
                public_excerpt=body[:280],
                content=body.strip(),
                license_id=PITCHFORK_POLICY.license_id,
                license_url=PITCHFORK_POLICY.license_url,
                policy=PITCHFORK_POLICY,
            )
    raise ValueError("missing or mismatched structured album review")


class PitchforkAdapter:
    def _read(self, url: str) -> str:
        request = urllib.request.Request(
            url, headers={"User-Agent": "Linerfy/0.0 personal music research"}
        )
        with urllib.request.urlopen(request, timeout=15) as response:
            if review_url(response.url) != review_url(url):
                raise ValueError("album review redirected to another page")
            body = response.read(2_000_001)
            if len(body) > 2_000_000:
                raise ValueError("review response too large")
            return body.decode("utf-8")

    def fetch(self, url: str, release: ReleaseEntity, artist: str) -> ReviewDocument:
        canonical = review_url(url)
        if not canonical:
            raise ValueError("not a Pitchfork album review")
        return parse_review(self._read(canonical), canonical, release, artist)
