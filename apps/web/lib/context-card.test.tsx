import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { featuredContext } from "@linerfy/domain/fixtures";
import { MusicContextCard } from "@linerfy/ui";

it("puts direct reviews before community and background, without repeating a single document title", () => {
  const source = featuredContext.sources[0]!;
  const html = renderToStaticMarkup(
    <MusicContextCard
      context={{
        ...featuredContext,
        sourceSummaries: [],
        consensusBlocks: [],
        sources: ["wikipedia", "critiquebrainz", "pitchfork"].map((id) => ({
          ...source,
          id,
          providerId: id,
          role:
            id === "wikipedia"
              ? ("background" as const)
              : id === "critiquebrainz"
                ? ("community" as const)
                : ("review" as const),
          publication: id,
          title: `redundant-${id}`,
          author: `author-${id}`,
        })),
      }}
    />,
  );
  expect(html.indexOf('footnote-publication">pitchfork')).toBeLessThan(
    html.indexOf('footnote-publication">critiquebrainz'),
  );
  expect(html.indexOf('footnote-publication">critiquebrainz')).toBeLessThan(
    html.indexOf('footnote-publication">wikipedia'),
  );
  expect(html).not.toContain("redundant-");
  expect(html).toContain("author-pitchfork");
  expect(html.match(/去原文/g)).toHaveLength(3);
});

it("numbers cited sources first, then uncited ones by review, community, background", () => {
  const source = featuredContext.sources[0]!;
  const block = featuredContext.consensusBlocks[0]!;
  const roles = {
    wikipedia: "background",
    critiquebrainz: "community",
    allmusic: "review",
    pitchfork: "review",
  } as const;
  const html = renderToStaticMarkup(
    <MusicContextCard
      context={{
        ...featuredContext,
        sourceSummaries: [],
        consensusBlocks: [
          {
            ...block,
            claims: [
              {
                id: "cited",
                text: "引用了社区来源",
                sourceIds: ["critiquebrainz"],
              },
            ],
          },
        ],
        sources: (Object.keys(roles) as (keyof typeof roles)[]).map((id) => ({
          ...source,
          id,
          providerId: id,
          role: roles[id],
          publication: id,
        })),
      }}
    />,
  );
  const position = (id: string) => html.indexOf(`footnote-publication">${id}`);
  expect(position("critiquebrainz")).toBeLessThan(position("allmusic"));
  expect(position("allmusic")).toBeLessThan(position("pitchfork"));
  expect(position("pitchfork")).toBeLessThan(position("wikipedia"));
});

it("keeps summaries and original links without excerpt or license panels", () => {
  const html = renderToStaticMarkup(
    <MusicContextCard context={featuredContext} />,
  );
  expect(html).not.toContain("许可与署名");
  expect(html).not.toContain("<details");
  for (const excerpt of featuredContext.excerpts) {
    expect(html).not.toContain(excerpt.text);
  }
  for (const source of featuredContext.sources) {
    expect(html).toContain(source.url);
  }
  expect(html).toContain("去原文");
});

it("renders both license pools from the same provider without duplicate provider cards", () => {
  const original = featuredContext.sourceSummaries[0]!;
  const first = {
    ...original,
    claims: [
      {
        id: "one",
        text: "第一许可池内容",
        sourceIds: [featuredContext.sources[0]!.id],
      },
    ],
  };
  const second = {
    ...first,
    license: {
      id: "CC BY-SA 4.0",
      url: "https://creativecommons.org/licenses/by-sa/4.0/",
    },
    claims: [{ ...first.claims[0]!, id: "two", text: "第二许可池内容" }],
  };
  const html = renderToStaticMarkup(
    <MusicContextCard
      context={{
        ...featuredContext,
        sources: [featuredContext.sources[0]!],
        sourceSummaries: [first, second],
        consensusBlocks: [],
      }}
    />,
  );
  expect(html).toContain("第一许可池内容");
  expect(html).toContain("第二许可池内容");
  expect(html.match(/provider-card/g)).toHaveLength(1);
});
