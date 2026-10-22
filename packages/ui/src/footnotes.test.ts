import type { ReviewSource } from "@linerfy/domain";
import { describe, expect, it } from "vitest";

import { footnoteNumbers, numberSources } from "./footnotes";

function source(id: string): ReviewSource {
  return {
    id,
    providerId: id.split("-")[0]!,
    role: "review",
    publication: id,
    title: `${id} review`,
    url: `https://example.com/${id}`,
  };
}

const a = source("a-1");
const b = source("b-1");
const c = source("c-1");
const d = source("d-1");

describe("numberSources", () => {
  it("numbers sources by first citation", () => {
    const { entries } = numberSources(
      [a, b, c],
      [{ sourceIds: ["c-1"] }, { sourceIds: ["a-1", "c-1"] }],
    );
    expect(entries.map((entry) => [entry.number, entry.source.id])).toEqual([
      [1, "c-1"],
      [2, "a-1"],
      [3, "b-1"],
    ]);
  });

  it("puts uncited sources last in their original order", () => {
    const { entries } = numberSources([a, b, c, d], [{ sourceIds: ["c-1"] }]);
    expect(entries.map((entry) => entry.source.id)).toEqual([
      "c-1",
      "a-1",
      "b-1",
      "d-1",
    ]);
  });

  it("skips cited ids that are not in sources", () => {
    const { entries, numbers } = numberSources(
      [a, b],
      [{ sourceIds: ["missing", "b-1"] }],
    );
    expect(entries.map((entry) => entry.source.id)).toEqual(["b-1", "a-1"]);
    expect(numbers.has("missing")).toBe(false);
    expect(footnoteNumbers(["missing", "b-1"], numbers)).toEqual([1]);
  });

  it("gives a source the same number across license pools", () => {
    const poolOne = [{ sourceIds: ["b-1"] }];
    const poolTwo = [{ sourceIds: ["a-1", "b-1"] }];
    const { numbers } = numberSources([a, b], [...poolOne, ...poolTwo]);
    expect(footnoteNumbers(poolOne[0]!.sourceIds, numbers)).toEqual([1]);
    expect(footnoteNumbers(poolTwo[0]!.sourceIds, numbers)).toEqual([1, 2]);
  });

  it("returns an empty list when there are no sources", () => {
    expect(numberSources([], [{ sourceIds: ["a-1"] }]).entries).toEqual([]);
  });
});

describe("footnoteNumbers", () => {
  it("dedupes and sorts", () => {
    const numbers = new Map([
      ["a-1", 2],
      ["b-1", 1],
    ]);
    expect(footnoteNumbers(["a-1", "b-1", "a-1"], numbers)).toEqual([1, 2]);
  });
});
