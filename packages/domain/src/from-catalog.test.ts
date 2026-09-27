import { describe, expect, it } from "vitest";

import { assembleMusicContext, type CatalogRows } from "./from-catalog";

it("allows a metadata-only partial context without fabricated review documents", () => {
  const context = assembleMusicContext({
    ...catalog,
    genres: [],
    genre_sources: [],
    review_documents: [],
    review_excerpts: [],
    summary_runs: [],
    claims: [],
    claim_sources: [],
  });
  expect(context.sources).toEqual([]);
  expect(context.sourceSummaries).toEqual([]);
});

const catalog: CatalogRows = {
  artists: [{ id: "a1", slug: "lana-del-rey", name: "Lana Del Rey" }],
  releases: [
    {
      id: "r1",
      slug: "norman-fucking-rockwell",
      artist_id: "a1",
      title: "Norman Fucking Rockwell!",
      release_date: "2019-01-01",
      artwork_url: "https://example.com/art.jpg",
    },
  ],
  genres: [
    { id: "g1", release_id: "r1", name: "Singer-Songwriter" },
    { id: "g2", release_id: "r1", name: "Psychedelic Pop" },
  ],
  genre_sources: [
    { genre_id: "g1", document_id: "d1" },
    { genre_id: "g2", document_id: "d2" },
  ],
  release_ratings: [],
  review_sources: [
    {
      id: "s1",
      slug: "pitchfork",
      publication: "Pitchfork",
      homepage_url: "https://pitchfork.com",
    },
    {
      id: "s2",
      slug: "guardian",
      publication: "The Guardian",
      homepage_url: "https://www.theguardian.com",
    },
  ],
  review_documents: [
    {
      id: "d1",
      slug: "pitchfork-nfr",
      release_id: "r1",
      source_id: "s1",
      source_url:
        "https://pitchfork.com/reviews/albums/lana-del-rey-norman-fucking-rockwell/",
      title: "Norman Fucking Rockwell!",
      author: "Jenn Pelly",
      published_at: "2019-09-03",
      score: 9.4,
      score_scale: 10,
      status: "published",
    },
    {
      id: "d2",
      slug: "guardian-nfr",
      release_id: "r1",
      source_id: "s2",
      source_url:
        "https://www.theguardian.com/music/2019/aug/30/lana-del-rey-norman-fucking-rockwell-review",
      title: "Norman Fucking Rockwell! review",
      author: "Alexis Petridis",
      published_at: "2019-08-30",
      score: 4,
      score_scale: 5,
      status: "published",
    },
  ],
  review_excerpts: [
    {
      id: "e1",
      document_id: "d1",
      excerpt:
        "The review treats the album as a major statement built from patient songwriting and a sharply observed American mythology.",
      is_paraphrase: true,
    },
    {
      id: "e2",
      document_id: "d2",
      excerpt:
        "The review emphasizes how classic songwriting craft and an unstable cultural backdrop strengthen one another.",
      is_paraphrase: true,
    },
  ],
  summary_runs: [
    {
      id: "sr1",
      release_id: "r1",
      model: "fixture-editorial-v1",
      locale: "zh-CN",
      corpus_hash: "fixture:nfr:pitchfork",
      generated_at: "2026-09-02T00:00:00Z",
      status: "published",
      summary_kind: "source",
      license_pool: "proprietary",
      license_url: "https://pitchfork.com/contact",
      source_id: "pitchfork",
      attribution: "Pitchfork — proprietary",
      ai_modified: true,
      skipped_reason: null,
    },
    {
      id: "sr2",
      release_id: "r1",
      model: "fixture-editorial-v1",
      locale: "zh-CN",
      corpus_hash: "fixture:nfr:guardian",
      generated_at: "2026-09-02T00:00:00Z",
      status: "published",
      summary_kind: "source",
      license_pool: "proprietary",
      license_url: "https://www.theguardian.com/help/terms-of-service",
      source_id: "guardian",
      attribution: "The Guardian — proprietary",
      ai_modified: true,
      skipped_reason: null,
    },
    {
      id: "sr3",
      release_id: "r1",
      model: "fixture-editorial-v1",
      locale: "zh-CN",
      corpus_hash: "fixture:nfr:v1",
      generated_at: "2026-09-02T00:00:00Z",
      status: "published",
      summary_kind: "consensus",
      license_pool: "proprietary",
      license_url: "https://pitchfork.com/contact",
      source_id: null,
      attribution: "Pitchfork、The Guardian — proprietary",
      ai_modified: true,
      skipped_reason: null,
    },
  ],
  claims: [
    {
      id: "c1",
      summary_run_id: "sr1",
      claim_order: 0,
      claim_text:
        "Pitchfork 把这张专辑视为 Lana Del Rey 最完整的表达，称赞其精细的写作与松弛的制作。",
    },
    {
      id: "c2",
      summary_run_id: "sr2",
      claim_order: 0,
      claim_text:
        "The Guardian 认为经典的创作功底与不稳定的文化背景相互成就，使这张专辑更显分量。",
    },
    {
      id: "c3",
      summary_run_id: "sr3",
      claim_order: 0,
      claim_text:
        "评论者普遍认为，这张专辑把精细的写作、松弛的制作与美国流行文化的衰败感结合成了 Lana Del Rey 最完整的表达之一。",
    },
  ],
  claim_sources: [
    { claim_id: "c1", document_id: "d1" },
    { claim_id: "c2", document_id: "d2" },
    { claim_id: "c3", document_id: "d1" },
    { claim_id: "c3", document_id: "d2" },
  ],
  recordings: [],
};

// A second album whose rows are deliberately interleaved with the first's in
// the mixed-catalog test below.
const secondAlbum: CatalogRows = {
  artists: [{ id: "a2", slug: "second-artist", name: "Second Artist" }],
  releases: [
    {
      id: "r2",
      slug: "album-b",
      artist_id: "a2",
      title: "Album B",
      release_date: "2020-01-01",
      artwork_url: null,
    },
  ],
  genres: [{ id: "g3", release_id: "r2", name: "Electronic" }],
  genre_sources: [{ genre_id: "g3", document_id: "d3" }],
  release_ratings: [],
  review_sources: [
    {
      id: "s3",
      slug: "source-b",
      publication: "Source B",
      homepage_url: "https://b.example.com",
    },
  ],
  review_documents: [
    {
      id: "d3",
      slug: "doc-b",
      release_id: "r2",
      source_id: "s3",
      source_url: "https://b.example.com/review",
      title: "Album B review",
      author: "B Author",
      published_at: "2020-02-01",
      score: 7,
      score_scale: 10,
      status: "published",
    },
  ],
  review_excerpts: [
    {
      id: "e3",
      document_id: "d3",
      excerpt: "A second album's excerpt.",
      is_paraphrase: false,
    },
  ],
  summary_runs: [
    {
      id: "srb",
      release_id: "r2",
      model: "m",
      locale: "en",
      corpus_hash: "b:v1",
      generated_at: "2026-01-01T00:00:00Z",
      status: "published",
      summary_kind: "source",
      license_pool: "cc-by-sa-4.0",
      license_url: "https://creativecommons.org/licenses/by-sa/4.0/",
      source_id: "source-b",
      attribution: "Source B — CC BY-SA 4.0",
      ai_modified: true,
      skipped_reason: null,
    },
  ],
  claims: [
    {
      id: "cb",
      summary_run_id: "srb",
      claim_order: 0,
      claim_text: "A second album's claim.",
    },
  ],
  claim_sources: [{ claim_id: "cb", document_id: "d3" }],
  recordings: [{ id: "rec2", release_id: "r2", title: "Track B" }],
};

function mergeRows(...rows: CatalogRows[]): CatalogRows {
  return {
    artists: rows.flatMap((r) => r.artists),
    releases: rows.flatMap((r) => r.releases),
    genres: rows.flatMap((r) => r.genres),
    genre_sources: rows.flatMap((r) => r.genre_sources),
    release_ratings: rows.flatMap((r) => r.release_ratings),
    review_sources: rows.flatMap((r) => r.review_sources),
    review_documents: rows.flatMap((r) => r.review_documents),
    review_excerpts: rows.flatMap((r) => r.review_excerpts),
    summary_runs: rows.flatMap((r) => r.summary_runs),
    claims: rows.flatMap((r) => r.claims),
    claim_sources: rows.flatMap((r) => r.claim_sources),
    recordings: rows.flatMap((r) => r.recordings),
  };
}

describe("assembleMusicContext", () => {
  it("reassembles a valid public context from catalog rows", () => {
    const context = assembleMusicContext(catalog);

    expect(context.scope).toBe("album");
    expect(context.release.id).toBe("norman-fucking-rockwell");
    expect(context.artist.id).toBe("lana-del-rey");
    expect(context.release.year).toBe(2019);
    expect(context.sources).toHaveLength(2);
    expect(context.sources[0]?.publication).toBe("Pitchfork");
    expect(context.sources[0]?.providerId).toBe("pitchfork");
    expect(context.sources[0]?.role).toBe("review");
    expect(context.sources[0]?.id).toBe("pitchfork-nfr");
    expect(context.genres.map((g) => g.name)).toEqual([
      "Singer-Songwriter",
      "Psychedelic Pop",
    ]);
    expect(context.sourceSummaries.map((s) => s.source.id)).toEqual([
      "pitchfork",
      "guardian",
    ]);
    expect(context.consensusBlocks).toHaveLength(1);
    expect(context.consensusBlocks[0]?.licensePool).toBe("proprietary");
    expect(context.consensusBlocks[0]?.sourceIds).toEqual([
      "pitchfork",
      "guardian",
    ]);
    expect(context.consensusBlocks[0]?.claims[0]?.sourceIds).toContain(
      "pitchfork-nfr",
    );
  });

  it("omits the year when the release date is unknown", () => {
    const withoutDate: CatalogRows = {
      ...catalog,
      releases: [{ ...catalog.releases[0]!, release_date: null }],
    };

    const context = assembleMusicContext(withoutDate);

    expect(context.release.year).toBeUndefined();
  });

  it("orders direct reviews before community summaries", () => {
    const communitySource = {
      ...catalog.review_sources[1]!,
      slug: "critiquebrainz",
      publication: "CritiqueBrainz",
    };
    const [pitchforkRun, guardianRun, consensusRun] = catalog.summary_runs;
    const context = assembleMusicContext({
      ...catalog,
      review_sources: [catalog.review_sources[0]!, communitySource],
      summary_runs: [
        { ...guardianRun!, source_id: "critiquebrainz" },
        pitchforkRun!,
        consensusRun!,
      ],
    });

    expect(context.sourceSummaries.map((summary) => summary.source.id)).toEqual(
      ["pitchfork", "critiquebrainz"],
    );
    expect(
      context.sourceSummaries.map((summary) => summary.source.role),
    ).toEqual(["review", "community"]);
  });

  it("maps provider rating snapshots and omits unknown vote counts", () => {
    const withRatings: CatalogRows = {
      ...catalog,
      release_ratings: [
        {
          id: "rt1",
          release_id: "r1",
          provider: "musicbrainz",
          value: 4.2,
          scale: 5,
          vote_count: 87,
          source_url: "https://musicbrainz.org/release-group/x",
        },
        {
          id: "rt2",
          release_id: "r1",
          provider: "critiquebrainz",
          value: 4.0,
          scale: 5,
          vote_count: null,
          source_url: null,
        },
      ],
    };

    const context = assembleMusicContext(withRatings);

    expect(context.ratings).toEqual([
      {
        provider: "musicbrainz",
        value: 4.2,
        scale: 5,
        voteCount: 87,
        sourceUrl: "https://musicbrainz.org/release-group/x",
      },
      { provider: "critiquebrainz", value: 4.0, scale: 5 },
    ]);
  });

  it("excludes non-published documents", () => {
    const withDraft: CatalogRows = {
      ...catalog,
      review_documents: [
        ...catalog.review_documents,
        {
          id: "d4",
          slug: "draft-doc",
          release_id: "r1",
          source_id: "s1",
          source_url: "https://example.com/draft",
          title: "Draft",
          author: null,
          published_at: null,
          score: null,
          score_scale: null,
          status: "draft",
        },
      ],
    };

    expect(assembleMusicContext(withDraft).sources).toHaveLength(2);
  });

  it("never leaks a second album's excerpt, genre, claim, or citation", () => {
    const mixed = mergeRows(catalog, secondAlbum);
    const context = assembleMusicContext(mixed);

    expect(context.release.id).toBe("norman-fucking-rockwell");
    expect(context.sources.map((s) => s.id)).not.toContain("doc-b");
    expect(context.excerpts.map((e) => e.text)).not.toContain(
      "A second album's excerpt.",
    );
    expect(context.genres.map((g) => g.name)).not.toContain("Electronic");
    const allClaims = [
      ...context.sourceSummaries.flatMap((s) => s.claims),
      ...context.consensusBlocks.flatMap((b) => b.claims),
    ];
    expect(allClaims.map((c) => c.text)).not.toContain(
      "A second album's claim.",
    );
    expect(context.recordings.map((r) => r.id)).not.toContain("rec2");
  });

  it("keeps background links but excludes them from review summaries", () => {
    // A second source in a different license pool must survive alongside the
    // first; the old `.find()` would have silently dropped one pool.
    const twoPools: CatalogRows = {
      ...catalog,
      review_sources: [
        ...catalog.review_sources,
        {
          id: "s4",
          slug: "wikipedia",
          publication: "Wikipedia",
          homepage_url: "https://en.wikipedia.org",
        },
      ],
      review_documents: [
        ...catalog.review_documents,
        {
          id: "d5",
          slug: "wikipedia-nfr",
          release_id: "r1",
          source_id: "s4",
          source_url: "https://en.wikipedia.org/wiki/Norman_Fucking_Rockwell!",
          title: "Norman Fucking Rockwell!",
          author: null,
          published_at: null,
          score: null,
          score_scale: null,
          status: "published",
        },
      ],
      summary_runs: [
        ...catalog.summary_runs,
        {
          id: "sr4",
          release_id: "r1",
          model: "m",
          locale: "zh-CN",
          corpus_hash: "wiki",
          generated_at: "2026-09-02T00:00:00Z",
          status: "published",
          summary_kind: "source",
          license_pool: "cc-by-sa-4.0",
          license_url: "https://creativecommons.org/licenses/by-sa/4.0/",
          source_id: "wikipedia",
          attribution: "Wikipedia — CC BY-SA 4.0",
          ai_modified: true,
          skipped_reason: null,
        },
        {
          id: "sr5",
          release_id: "r1",
          model: "m",
          locale: "zh-CN",
          corpus_hash: "wiki-consensus",
          generated_at: "2026-09-02T00:00:00Z",
          status: "published",
          summary_kind: "consensus",
          license_pool: "cc-by-sa-4.0",
          license_url: "https://creativecommons.org/licenses/by-sa/4.0/",
          source_id: null,
          attribution: "Wikipedia — CC BY-SA 4.0",
          ai_modified: true,
          skipped_reason: "insufficient-sources",
        },
      ],
      claims: [
        ...catalog.claims,
        {
          id: "c4",
          summary_run_id: "sr4",
          claim_order: 0,
          claim_text: "Wikipedia 概括了专辑的背景。",
        },
      ],
      claim_sources: [
        ...catalog.claim_sources,
        { claim_id: "c4", document_id: "d5" },
      ],
    };

    const context = assembleMusicContext(twoPools);

    expect(context.sourceSummaries.map((s) => s.source.id)).toEqual([
      "pitchfork",
      "guardian",
    ]);
    // The Wikipedia source is keyed by its provider slug, not its document
    // slug — the exact failure the providerId contract guards against.
    const wikipedia = context.sources.find((s) => s.providerId === "wikipedia");
    expect(wikipedia?.id).toBe("wikipedia-nfr");
    expect(wikipedia?.providerId).toBe("wikipedia");
    expect(wikipedia?.role).toBe("background");
    expect(context.consensusBlocks.map((b) => b.licensePool)).toEqual([
      "proprietary",
      "cc-by-sa-4.0",
    ]);
    const skipped = context.consensusBlocks.find(
      (b) => b.licensePool === "cc-by-sa-4.0",
    );
    expect(skipped?.skippedReason).toBe("insufficient-sources");
    expect(skipped?.claims).toHaveLength(0);
    expect(skipped?.sourceIds).toEqual([]);
  });

  it("returns only published summary generations", () => {
    // A candidate (in-flight regeneration) and a superseded (old published)
    // generation for the same scopes must never reach the public read path;
    // only the one current published generation per scope is returned.
    const withNonPublished: CatalogRows = {
      ...catalog,
      summary_runs: [
        ...catalog.summary_runs,
        {
          id: "sr-candidate",
          release_id: "r1",
          model: "m",
          locale: "zh-CN",
          corpus_hash: "newer",
          generated_at: "2026-09-03T00:00:00Z",
          status: "candidate",
          summary_kind: "source",
          license_pool: "proprietary",
          license_url: "https://pitchfork.com/contact",
          source_id: "pitchfork",
          attribution: "Pitchfork — proprietary",
          ai_modified: true,
          skipped_reason: null,
          scope: "source::pitchfork",
          published_at: null,
        },
        {
          id: "sr-superseded",
          release_id: "r1",
          model: "m",
          locale: "zh-CN",
          corpus_hash: "older",
          generated_at: "2026-09-01T00:00:00Z",
          status: "superseded",
          summary_kind: "consensus",
          license_pool: "proprietary",
          license_url: "https://pitchfork.com/contact",
          source_id: null,
          attribution: "Pitchfork、The Guardian — proprietary",
          ai_modified: true,
          skipped_reason: null,
          scope: "consensus::proprietary",
          published_at: "2026-09-01T00:00:00Z",
        },
      ],
    };

    const context = assembleMusicContext(withNonPublished);

    expect(context.sourceSummaries.map((s) => s.source.id)).toEqual([
      "pitchfork",
      "guardian",
    ]);
    expect(context.consensusBlocks).toHaveLength(1);
    expect(context.consensusBlocks[0]?.licensePool).toBe("proprietary");
  });
});
