import type { ReviewSource } from "@linerfy/domain";

export type Footnote = { number: number; source: ReviewSource };

export type Footnotes = {
  entries: Footnote[];
  numbers: ReadonlyMap<string, number>;
};

/**
 * Number sources for the footnote list: first by the order claims cite them,
 * then the uncited ones in their original order. Cited ids that are not in
 * `sources` get no number. Display only; the context data is not changed.
 */
export function numberSources(
  sources: readonly ReviewSource[],
  claims: readonly { sourceIds: readonly string[] }[],
): Footnotes {
  const byId = new Map(sources.map((source) => [source.id, source]));
  const ordered: ReviewSource[] = [];
  const seen = new Set<string>();
  const add = (source: ReviewSource | undefined) => {
    if (!source || seen.has(source.id)) return;
    seen.add(source.id);
    ordered.push(source);
  };
  for (const claim of claims) {
    for (const id of claim.sourceIds) add(byId.get(id));
  }
  for (const source of sources) add(source);

  const entries = ordered.map((source, index) => ({
    number: index + 1,
    source,
  }));
  return {
    entries,
    numbers: new Map(entries.map((entry) => [entry.source.id, entry.number])),
  };
}

/** The footnote numbers for a list of source ids: deduped, ascending. */
export function footnoteNumbers(
  ids: readonly string[],
  numbers: ReadonlyMap<string, number>,
): number[] {
  const found = new Set<number>();
  for (const id of ids) {
    const number = numbers.get(id);
    if (number !== undefined) found.add(number);
  }
  return [...found].sort((x, y) => x - y);
}
