import type {
  ReviewSource,
  SourceSummary,
  MusicContext,
} from "@linerfy/domain";
import type { ReactNode } from "react";
import { footnoteNumbers, numberSources } from "./footnotes";

/**
 * A source's editorial tier, keyed on its stable provider slug — never the
 * document slug, and never the publication display name. The catalog boundary
 * assigns the role so consumers do not need their own provider allowlist.
 */
export function sourceRoleLabel(role: ReviewSource["role"]): string | null {
  if (role === "background") return "背景资料";
  if (role === "community") return "社区评论";
  return null;
}

export function ratingProviderLabel(provider: string): string {
  if (provider === "musicbrainz") return "MusicBrainz";
  if (provider === "critiquebrainz") return "CritiqueBrainz";
  return provider;
}

export function LinerfyMark() {
  return (
    <span className="linerfy-mark" aria-label="Linerfy">
      <span aria-hidden="true">L</span>
    </span>
  );
}

export function SourceLink({
  children,
  href,
}: {
  children: ReactNode;
  href: string;
}) {
  return (
    <a className="source-link" href={href} rel="noreferrer" target="_blank">
      {children}
      <span aria-hidden="true">↗</span>
    </a>
  );
}

function FootnoteRef({
  ids,
  numbers,
}: {
  ids: readonly string[];
  numbers: ReadonlyMap<string, number>;
}) {
  const found = footnoteNumbers(ids, numbers);
  if (!found.length) return null;
  return <sup className="footnote-ref">{found.join(",")}</sup>;
}

export function MusicContextCard({
  context,
  showReleaseHeader = true,
}: {
  context: MusicContext;
  showReleaseHeader?: boolean;
}) {
  // Merge one provider's document links and source summaries into a single
  // card. Keyed on the stable provider slug: a document's `providerId` and a
  // source summary's `source.id` are the same source identity, used at their
  // respective call sites (see the domain schema comments). License pools stay
  // separate — cross-source consensus blocks render above and are never folded
  // into a provider card.
  const providerSlugs: string[] = [];
  const bySlug = new Map<
    string,
    { documents: ReviewSource[]; summaries: SourceSummary[] }
  >();
  for (const source of context.sources) {
    if (!bySlug.has(source.providerId)) {
      bySlug.set(source.providerId, { documents: [], summaries: [] });
      providerSlugs.push(source.providerId);
    }
    bySlug.get(source.providerId)!.documents.push(source);
  }
  for (const summary of context.sourceSummaries) {
    const entry = bySlug.get(summary.source.id);
    if (entry) {
      entry.summaries.push(summary);
    } else {
      bySlug.set(summary.source.id, { documents: [], summaries: [summary] });
      providerSlugs.push(summary.source.id);
    }
  }
  const roleFor = (slug: string): ReviewSource["role"] =>
    bySlug.get(slug)?.documents[0]?.role ??
    bySlug.get(slug)?.summaries[0]?.source.role ??
    "review";
  const roleRank = (role: ReviewSource["role"]) =>
    role === "review" ? 0 : role === "community" ? 1 : 2;
  const providerCards = providerSlugs
    .sort((a, b) => roleRank(roleFor(a)) - roleRank(roleFor(b)))
    .map((slug) => {
      const entry = bySlug.get(slug)!;
      const first = entry.documents[0];
      return {
        slug,
        publication:
          first?.publication ?? entry.summaries[0]?.source.publication ?? slug,
        role: roleFor(slug),
        score: entry.documents.length === 1 ? first?.score : undefined,
        documents: entry.documents,
        summaries: entry.summaries,
      };
    });

  const visibleBlocks = context.consensusBlocks.filter(
    (block) => block.claims.length > 0,
  );
  const footnotes = numberSources(
    [...context.sources].sort((a, b) => roleRank(a.role) - roleRank(b.role)),
    visibleBlocks.flatMap((block) => block.claims),
  );
  // Background sources carry no summary, so they appear only in the footnotes.
  const summaryCards = providerCards.filter(
    (card) => card.summaries.length > 0,
  );
  const genreLine = context.genres.map((genre) => genre.name).join(" · ");

  return (
    <article className="context-card">
      {showReleaseHeader ? (
        <header className="release-header">
          {context.release.artworkUrl ? (
            // Remote fixture art intentionally uses a plain img so the shared package has no Next.js dependency.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              alt={`${context.release.title} album artwork`}
              className="release-artwork"
              height="168"
              src={context.release.artworkUrl}
              width="168"
            />
          ) : null}
          <div>
            <h2>{context.release.title}</h2>
            <p className="artist-name">
              {context.artist.name}
              {context.release.year ? ` · ${context.release.year}` : ""}
            </p>
          </div>
        </header>
      ) : null}

      {context.ratings.length ? (
        <ul className="rating-list" aria-label="评分">
          {context.ratings.map((rating) => (
            <li className="rating-item" key={rating.provider}>
              <span className="rating-value">{rating.value}</span>
              <span className="rating-scale">/{rating.scale}</span>
              <span className="rating-provider">
                {ratingProviderLabel(rating.provider)}
              </span>
              {rating.voteCount !== undefined && rating.voteCount < 5 ? (
                <span className="rating-note">样本较少</span>
              ) : rating.voteCount !== undefined ? (
                <span className="rating-note">{rating.voteCount} 票</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {genreLine ? (
        <p className="genre-line" aria-label="Genres">
          {genreLine}
        </p>
      ) : null}

      {visibleBlocks.length ? (
        <section className="consensus" aria-label="综合归纳">
          <h2 className="section-heading">乐评</h2>
          {visibleBlocks.map((block) => (
            <ol className="claim-list" key={block.licensePool}>
              {block.claims.map((claim) => (
                <li className="claim-item" key={claim.id}>
                  {claim.text}
                  <FootnoteRef
                    ids={claim.sourceIds}
                    numbers={footnotes.numbers}
                  />
                </li>
              ))}
            </ol>
          ))}
        </section>
      ) : null}

      {summaryCards.length ? (
        <section className="provider-list" aria-label="各家怎么说">
          <h2 className="section-heading">各家怎么说</h2>
          {summaryCards.map((card) => (
            <article className="provider-card" key={card.slug}>
              <h3 className="provider-heading">
                {card.publication}
                <FootnoteRef
                  ids={card.documents.map((source) => source.id)}
                  numbers={footnotes.numbers}
                />
                {sourceRoleLabel(card.role) ? (
                  <span className="source-tier">
                    {sourceRoleLabel(card.role)}
                  </span>
                ) : null}
                {card.score ? (
                  <span className="source-score">
                    {card.score.value}/{card.score.scale}
                  </span>
                ) : null}
              </h3>
              {card.summaries.map((summary) => (
                <ul className="summary-claims" key={summary.license.id}>
                  {summary.claims.map((claim) => (
                    <li key={claim.id}>{claim.text}</li>
                  ))}
                </ul>
              ))}
            </article>
          ))}
        </section>
      ) : null}

      {footnotes.entries.length ? (
        <section className="footnotes" aria-label="来源">
          <h2 className="section-heading">来源</h2>
          <ol className="footnote-list">
            {footnotes.entries.map(({ number, source }) => (
              <li className="footnote" key={source.id}>
                <span className="footnote-number">{number}</span>
                <span className="footnote-body">
                  <span className="footnote-publication">
                    {source.publication}
                  </span>
                  {sourceRoleLabel(source.role) ? (
                    <span className="footnote-detail">
                      {sourceRoleLabel(source.role)}
                    </span>
                  ) : null}
                  {source.author ? (
                    <span className="footnote-detail">{source.author}</span>
                  ) : null}
                  {source.publishedAt ? (
                    <span className="footnote-detail">
                      {source.publishedAt.slice(0, 10)}
                    </span>
                  ) : null}
                  {source.score ? (
                    <span className="footnote-detail">
                      {source.score.value}/{source.score.scale}
                    </span>
                  ) : null}
                </span>
                <SourceLink href={source.url}>去原文</SourceLink>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </article>
  );
}
