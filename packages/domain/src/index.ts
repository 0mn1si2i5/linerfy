import { z } from "zod";

export const artistSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});

export const releaseSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  artistId: z.string().min(1),
  // Unknown release years are omitted, never guessed from the current date.
  year: z.number().int().min(1900).max(2100).optional(),
  artworkUrl: z.url().optional(),
});

export const recordingSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  releaseId: z.string().min(1),
  providerIds: z.record(z.string(), z.string().min(1)).default({}),
});

export const reviewSourceSchema = z.object({
  // Document identity: a stable slug per stored review document (e.g.
  // `wikipedia-<release-id>-reception`). Never a provider identifier.
  id: z.string().min(1),
  // Source identity: the stable provider slug (e.g. `wikipedia`), filled from
  // `review_sources.slug` at the catalog boundary. The UI keys tier labels on
  // this, never on `id` or the publication display name.
  providerId: z.string().min(1),
  // Consumers can distinguish direct criticism, community opinion and
  // secondary background without hard-coding provider ids.
  role: z.enum(["review", "community", "background"]),
  publication: z.string().min(1),
  author: z.string().min(1).optional(),
  title: z.string().min(1),
  url: z.url(),
  publishedAt: z.iso.date().optional(),
  score: z
    .object({
      value: z.number().nonnegative(),
      scale: z.number().positive(),
    })
    .optional(),
});

export const reviewExcerptSchema = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1),
  text: z.string().min(1).max(500),
  kind: z.enum(["quotation", "paraphrase"]),
});

export const genreSchema = z.object({
  name: z.string().min(1),
  // Metadata authorities such as MusicBrainz may supply a tag without a
  // review-document citation. Generated claims still require citations.
  sourceIds: z.array(z.string().min(1)).default([]),
});

// A release-level rating snapshot from one provider (MusicBrainz community
// rating, CritiqueBrainz official average). `voteCount` is omitted when the
// provider does not report a population count (never written as 0).
export const ratingSchema = z.object({
  provider: z.string().min(1),
  value: z.number().nonnegative(),
  scale: z.number().positive(),
  voteCount: z.number().int().nonnegative().optional(),
  sourceUrl: z.url().optional(),
});

export const citedClaimSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  sourceIds: z.array(z.string().min(1)).min(1),
});

// A license id + canonical url. The id is the compatibility pool key (e.g.
// "CC BY-SA 4.0"); the url is the human-readable license or rights page.
export const licenseSchema = z.object({
  id: z.string().min(1),
  url: z.string().min(1),
});

// One publication's AI-generated summary. Every claim cites stored review
// documents (the `sources` array), and the summary is tied to the source's
// license so incompatible licenses are never mixed into one run.
export const sourceSummarySchema = z.object({
  source: z.object({
    id: z.string().min(1),
    publication: z.string().min(1),
    role: z.enum(["review", "community"]),
  }),
  license: licenseSchema,
  attribution: z.string(),
  aiModified: z.boolean(),
  claims: z.array(citedClaimSchema).min(1),
});

// A cross-source consensus block for one license pool. `sourceIds` are the
// publication ids pooled together; a block that was legitimately not generated
// (fewer than two distinct sources) carries an empty `claims` array and a
// `skippedReason` instead.
export const consensusBlockSchema = z.object({
  licensePool: z.string().min(1),
  license: licenseSchema,
  sourceIds: z.array(z.string().min(1)),
  attribution: z.string(),
  aiModified: z.boolean(),
  claims: z.array(citedClaimSchema),
  skippedReason: z.string().min(1).optional(),
});

export const musicContextSchema = z
  .object({
    // A track may lead to this context, but Linerfy resolves and caches it at
    // release level. Only claim text that names a recording is track-specific.
    scope: z.literal("album"),
    artist: artistSchema,
    release: releaseSchema,
    recordings: z.array(recordingSchema),
    genres: z.array(genreSchema),
    ratings: z.array(ratingSchema),
    sources: z.array(reviewSourceSchema),
    excerpts: z.array(reviewExcerptSchema),
    sourceSummaries: z.array(sourceSummarySchema),
    consensusBlocks: z.array(consensusBlockSchema),
  })
  .superRefine((context, refinement) => {
    const sourceIds = new Set(context.sources.map((source) => source.id));
    const citedIds = [
      ...context.sourceSummaries.flatMap((summary) =>
        summary.claims.flatMap((claim) => claim.sourceIds),
      ),
      ...context.consensusBlocks.flatMap((block) =>
        block.claims.flatMap((claim) => claim.sourceIds),
      ),
      ...context.genres.flatMap((genre) => genre.sourceIds),
      ...context.excerpts.map((excerpt) => excerpt.sourceId),
    ];

    if (citedIds.some((sourceId) => !sourceIds.has(sourceId))) {
      refinement.addIssue({
        code: "custom",
        message: "Every cited claim must reference a source in this context",
      });
    }

    if (context.release.artistId !== context.artist.id) {
      refinement.addIssue({
        code: "custom",
        message: "Release artistId must match the context artist",
      });
    }

    if (
      context.recordings.some(
        (recording) => recording.releaseId !== context.release.id,
      )
    ) {
      refinement.addIssue({
        code: "custom",
        message: "Every recording must belong to the context release",
      });
    }
  });

/**
 * The POST /api/context response the desktop consumes. It is a discriminated
 * union over `status` so the client can validate the shape at runtime (never
 * with a blind TypeScript cast): `ready` always carries a valid `context`, and
 * the terminal states distinguish `ambiguous` (entity matched more than one
 * release) from `unavailable` (no match) and `failed`.
 */
export const contextApiResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready"), context: musicContextSchema }),
  z.object({
    status: z.literal("partial"),
    stage: z.string().optional(),
    context: musicContextSchema,
    paused: z.boolean().optional(),
  }),
  z.object({
    status: z.literal("queued"),
    stage: z.string().optional(),
    paused: z.boolean().optional(),
  }),
  z.object({
    status: z.literal("running"),
    stage: z.string().optional(),
    paused: z.boolean().optional(),
  }),
  z.object({ status: z.literal("unavailable") }),
  z.object({ status: z.literal("ambiguous") }),
  // A failed job may still carry whatever was published before the failure; the
  // client shows it instead of discarding already-delivered content.
  z.object({
    status: z.literal("failed"),
    stage: z.string().optional(),
    context: musicContextSchema.optional(),
  }),
]);

export type Artist = z.infer<typeof artistSchema>;
export type Release = z.infer<typeof releaseSchema>;
export type Recording = z.infer<typeof recordingSchema>;
export type ReviewSource = z.infer<typeof reviewSourceSchema>;
export type ReviewExcerpt = z.infer<typeof reviewExcerptSchema>;
export type Genre = z.infer<typeof genreSchema>;
export type Rating = z.infer<typeof ratingSchema>;
export type CitedClaim = z.infer<typeof citedClaimSchema>;
export type License = z.infer<typeof licenseSchema>;
export type SourceSummary = z.infer<typeof sourceSummarySchema>;
export type ConsensusBlock = z.infer<typeof consensusBlockSchema>;
export type MusicContext = z.infer<typeof musicContextSchema>;
export type ContextApiResponse = z.infer<typeof contextApiResponseSchema>;
