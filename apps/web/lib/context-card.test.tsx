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
          publication: id,
          title: `redundant-${id}`,
          author: `author-${id}`,
        })),
      }}
    />,
  );
  expect(html.indexOf("<strong>pitchfork")).toBeLessThan(
    html.indexOf("<strong>critiquebrainz"),
  );
  expect(html.indexOf("<strong>critiquebrainz")).toBeLessThan(
    html.indexOf("<strong>wikipedia"),
  );
  expect(html).not.toContain("redundant-");
  expect(html).toContain("author-pitchfork");
  expect(html.match(/去原文/g)).toHaveLength(3);
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
