"""Find Pitchfork album-review links that Wikipedia does not cite, via DeepSeek Search.

Search only proposes URLs. Every candidate still passes ``review_url()`` here and
``PitchforkAdapter.fetch()`` (the structured identity check) downstream.
"""

from __future__ import annotations

import json
import urllib.request

from .pitchfork import review_url

_MAX_QUERY_CHARS = 128
_MAX_CANDIDATES = 2


def _quoted(value: str) -> str:
    return '"' + " ".join(value.replace('"', " ").split()) + '"'


def pitchfork_query(artist: str, album: str) -> str:
    # A path in ``site:`` returned no results in testing; the host form does.
    query = f"site:pitchfork.com {_quoted(artist)} {_quoted(album)} review"
    if len(query) > _MAX_QUERY_CHARS:
        query = f"site:pitchfork.com {_quoted(album)} review"
    return query[:_MAX_QUERY_CHARS]


class DeepSeekSearchAdapter:
    def __init__(self, api_key: str, base_url: str = "https://api.deepseek.com", timeout=10):
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def _post(self, payload: dict) -> dict:
        request = urllib.request.Request(
            f"{self.base_url}/v1/tools/search",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        # urlopen raises HTTPError for 429 and other non-2xx statuses.
        with urllib.request.urlopen(request, timeout=self.timeout) as response:
            return json.loads(response.read().decode("utf-8"))

    def pitchfork_candidates(self, artist: str, album: str) -> tuple[str, ...]:
        payload = self._post({"query": pitchfork_query(artist, album), "count": 5})
        results = payload.get("results") or []
        urls = (
            review_url(item["url"])
            for item in results
            if isinstance(item, dict) and isinstance(item.get("url"), str)
        )
        return tuple(dict.fromkeys(url for url in urls if url))[:_MAX_CANDIDATES]
