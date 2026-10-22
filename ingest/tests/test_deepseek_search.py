"""DeepSeek Search adapter: request shape, candidate filtering and failures."""

from __future__ import annotations

import io
import json
import urllib.error

import pytest

from linerfy_ingest import deepseek_search, worker
from linerfy_ingest.deepseek_search import DeepSeekSearchAdapter, pitchfork_query


class _Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _capture(monkeypatch, payload):
    seen = {}

    def urlopen(request, timeout):
        seen["request"], seen["timeout"] = request, timeout
        return _Response(json.dumps(payload).encode())

    monkeypatch.setattr(deepseek_search.urllib.request, "urlopen", urlopen)
    return seen


def test_request_uses_bearer_key_and_site_query(monkeypatch):
    seen = _capture(monkeypatch, {"results": []})
    assert DeepSeekSearchAdapter("sk-test").pitchfork_candidates("Hovvdy", "Hovvdy") == ()

    request = seen["request"]
    assert request.full_url == "https://api.deepseek.com/v1/tools/search"
    assert request.get_method() == "POST"
    assert request.get_header("Authorization") == "Bearer sk-test"
    assert json.loads(request.data) == {
        "query": 'site:pitchfork.com "Hovvdy" "Hovvdy" review',
        "count": 5,
    }
    assert seen["timeout"] == 10


def test_only_album_review_urls_survive_deduplicated_and_capped(monkeypatch):
    _capture(
        monkeypatch,
        {
            "results": [
                {"url": "https://pitchfork.com/news/hovvdy-announce-album/"},
                {"url": "https://example.com/reviews/albums/hovvdy-hovvdy/"},
                {"url": "https://pitchfork.com/reviews/tracks/hovvdy-song/"},
                {"url": "https://pitchfork.com/reviews/albums/hovvdy-big-world/#1"},
                {"url": "https://www.pitchfork.com/reviews/albums/hovvdy-big-world"},
                {"url": "https://pitchfork.com/reviews/albums/hovvdy-hovvdy/"},
                {"url": "https://pitchfork.com/reviews/albums/hovvdy-true-love/"},
                {"title": "no url"},
            ]
        },
    )
    assert DeepSeekSearchAdapter("sk-test").pitchfork_candidates("Hovvdy", "Hovvdy") == (
        "https://pitchfork.com/reviews/albums/hovvdy-big-world/",
        "https://pitchfork.com/reviews/albums/hovvdy-hovvdy/",
    )


def test_rate_limit_raises(monkeypatch):
    def urlopen(request, timeout):
        raise urllib.error.HTTPError(request.full_url, 429, "Too Many Requests", {}, None)

    monkeypatch.setattr(deepseek_search.urllib.request, "urlopen", urlopen)
    with pytest.raises(urllib.error.HTTPError):
        DeepSeekSearchAdapter("sk-test").pitchfork_candidates("Hovvdy", "Hovvdy")


def test_query_stays_within_the_api_limit():
    assert pitchfork_query('Some "Quoted" Artist', "Album") == (
        'site:pitchfork.com "Some Quoted Artist" "Album" review'
    )
    long_query = pitchfork_query("A" * 80, "B" * 40)
    assert long_query == f'site:pitchfork.com "{"B" * 40}" review'
    assert len(pitchfork_query("A" * 200, "B" * 200)) == 128


@pytest.mark.parametrize("key", ["", "sk-test"])
def test_worker_enables_search_only_with_its_own_key(monkeypatch, key):
    monkeypatch.setenv("DEEPSEEK_SEARCH_API_KEY", key)
    monkeypatch.setenv("MODEL_API_KEY", "sk-model")
    monkeypatch.setattr(worker, "build_handlers", lambda deps: deps)
    search = worker.build_worker_handlers().search
    if key:
        assert isinstance(search, DeepSeekSearchAdapter)
        assert search.api_key == key
    else:
        assert search is None
