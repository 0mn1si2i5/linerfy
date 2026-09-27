import type {
  ReviewSource,
  SourceSummary,
  MusicContext,
} from "@linerfy/domain";
import type { ReactNode } from "react";

/**
 * A source's editorial tier, keyed on its stable provider slug — never the
 * document slug, and never the publication display name. Wikipedia "Critical
 * reception" is 背景资料 (background, not a review site) and CritiqueBrainz is
 * 社区评论 (community reviews, not media criticism). Unknown providers are
 * treated as media and show their score instead.
 */
export function sourceTierLabel(providerId: string): string | null {
  if (providerId === "wikipedia") return "背景资料";
  if (providerId === "critiquebrainz") return "社区评论";
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
  const tierOrder = (slug: string) =>
    slug === "wikipedia" ? 2 : slug === "critiquebrainz" ? 1 : 0;
  const providerCards = providerSlugs
    .sort((a, b) => tierOrder(a) - tierOrder(b))
    .map((slug) => {
      const entry = bySlug.get(slug)!;
      const first = entry.documents[0];
      return {
        slug,
        publication:
          first?.publication ?? entry.summaries[0]?.source.publication ?? slug,
        tier: sourceTierLabel(slug),
        score: entry.documents.length === 1 ? first?.score : undefined,
        documents: entry.documents,
        summaries: entry.summaries,
      };
    });

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
            <ul className="genre-list" aria-label="Genres">
              {context.genres.map((genre) => (
                <li key={genre.name}>{genre.name}</li>
              ))}
            </ul>
          </div>
        </header>
      ) : context.genres.length ? (
        <ul className="genre-list context-genres" aria-label="Genres">
          {context.genres.map((genre) => (
            <li key={genre.name}>{genre.name}</li>
          ))}
        </ul>
      ) : null}

      {context.ratings.length ? (
        <ul className="rating-list" aria-label="评分">
          {context.ratings.map((rating) => (
            <li className="rating-item" key={rating.provider}>
              <span className="rating-provider">
                {ratingProviderLabel(rating.provider)}
              </span>
              <span className="rating-value">
                {rating.value}/{rating.scale}
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

      {context.consensusBlocks
        .filter((block) => block.claims.length > 0)
        .map((block) => (
          <section
            aria-label="综合归纳"
            className="consensus-block"
            key={block.licensePool}
          >
            <ul className="claim-list">
              {block.claims.map((claim) => {
                const claimSources = context.sources.filter((source) =>
                  claim.sourceIds.includes(source.id),
                );
                return (
                  <li className="claim-item" key={claim.id}>
                    <p className="claim-text">{claim.text}</p>
                    <p className="claim-sources">
                      来源：
                      {claimSources
                        .map((source) => source.publication)
                        .join("、")}
                    </p>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}

      {providerCards.length ? (
        <section aria-label="来源" className="source-summaries">
          <div className="source-summary-grid">
            {providerCards.map((card) => (
              <article className="source-summary provider-card" key={card.slug}>
                <div className="source-meta">
                  <strong>{card.publication}</strong>
                  {card.tier ? (
                    <span className="source-tier">{card.tier}</span>
                  ) : null}
                  {card.score ? (
                    <span className="source-score">
                      {card.score.value}/{card.score.scale}
                    </span>
                  ) : null}
                </div>

                {card.summaries.map((summary) => (
                  <section key={summary.license.id}>
                    <ul className="claim-list">
                      {summary.claims.map((claim) => (
                        <li className="claim-item" key={claim.id}>
                          <p className="claim-text">{claim.text}</p>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}

                {card.documents.map((source) => {
                  return (
                    <div className="provider-doc" key={source.id}>
                      <div className="provider-doc-heading">
                        {card.documents.length > 1 ? (
                          <h3>{source.title}</h3>
                        ) : source.author ? (
                          <span className="source-tier">{source.author}</span>
                        ) : null}
                        {card.documents.length > 1 && source.score ? (
                          <span className="source-score">
                            {source.score.value}/{source.score.scale}
                          </span>
                        ) : null}
                      </div>
                      <SourceLink href={source.url}>去原文</SourceLink>
                    </div>
                  );
                })}
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </article>
  );
}
