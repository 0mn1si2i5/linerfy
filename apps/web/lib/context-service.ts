import { NextResponse, type NextRequest } from "next/server";

import { getContextBySlug } from "./catalog";
import {
  legacyRequestFingerprint,
  nowPlayingRequestSchema,
  releaseSlug,
  requestFingerprint,
  toIngestPayload,
} from "./request";
import { serviceClient } from "./supabase";

// Shared content-task entry point. Authentication stays in each route so a
// service credential can never be interpreted as a user session (or vice versa).
export async function handleContextRequest(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = nowPlayingRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid now-playing request", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const slug = releaseSlug(parsed.data.artist, parsed.data.album);
  const fingerprint = requestFingerprint(parsed.data);
  const supabase = serviceClient();

  // `ready` is determined by the job's state, never by the mere presence of
  // catalog rows: an in-progress job with partial data must stay `partial` so
  // the client keeps polling until it actually finishes.
  let { data: job, error: jobError } = await supabase
    .from("enrichment_jobs")
    .select("id, state, stage, resolution_status, source_errors, payload")
    .eq("entity_id", fingerprint)
    .maybeSingle();
  if (!job && !jobError) {
    const legacy = await supabase
      .from("enrichment_jobs")
      .select("id, state, stage, resolution_status, source_errors, payload")
      .eq("entity_id", legacyRequestFingerprint(parsed.data))
      .maybeSingle();
    jobError = legacy.error;
    // Verify the tuple too: legacy delimiter collisions must not join albums.
    if (legacy.data) {
      const old = nowPlayingRequestSchema.safeParse(legacy.data.payload);
      if (old.success && requestFingerprint(old.data) === fingerprint)
        job = legacy.data;
    }
  }
  if (jobError) {
    return NextResponse.json({ error: "query failed" }, { status: 500 });
  }

  // Surface the operator-controlled model-generation pause so an in-progress
  // request can say "服务暂停" instead of appearing to spin.
  const { data: pausedFlag } = await supabase
    .from("service_flags")
    .select("value")
    .eq("key", "model_generation_paused")
    .maybeSingle();
  const paused = pausedFlag?.value === "true";

  if (
    job &&
    parsed.data.retry &&
    (job.state === "failed" || job.source_errors?.length)
  ) {
    const { data: restarted, error } = await supabase.rpc("retry_enrichment", {
      job_id: job.id,
    });
    if (error)
      return NextResponse.json({ error: "retry failed" }, { status: 500 });
    if (restarted) {
      await supabase.rpc("wake_worker");
      const content = await getContextBySlug(slug);
      return NextResponse.json(
        content.status === "ok"
          ? {
              status: "partial",
              stage: "fetch_sources",
              context: content.context,
              paused,
            }
          : { status: "queued", stage: "fetch_sources", paused },
      );
    }
  }

  if (!job) {
    // No job: either the release was already completed (cached) or it has never
    // been enqueued.
    const existing = await getContextBySlug(slug);
    if (existing.status === "ok") {
      return NextResponse.json({ status: "ready", context: existing.context });
    }
    if (existing.status === "query-failed" || existing.status === "invalid") {
      return NextResponse.json(
        { error: "context read failed" },
        { status: 500 },
      );
    }

    const { error: insertError } = await supabase
      .from("enrichment_jobs")
      .upsert(
        {
          entity_id: fingerprint,
          entity_kind: "release",
          payload: toIngestPayload(parsed.data),
          stage: "resolve_entity",
          state: "queued",
        },
        { onConflict: "entity_kind,entity_id", ignoreDuplicates: true },
      );
    if (insertError) {
      return NextResponse.json({ error: "queue failed" }, { status: 500 });
    }

    // Wake the Python worker immediately after a first insert. pg_net queues
    // the request asynchronously, so this never waits on the worker's response,
    // and a failure here is non-fatal: the one-minute cron still recovers.
    try {
      await supabase.rpc("wake_worker");
    } catch {
      // Ignore - the cron compensates for a missed wake.
    }

    return NextResponse.json({
      status: "queued",
      stage: "resolve_entity",
      paused,
    });
  }

  if (job.state === "ready") {
    const result = await getContextBySlug(slug);
    if (result.status === "ok") {
      return NextResponse.json(
        job.source_errors?.length
          ? {
              status: "failed",
              stage: "fetch_sources",
              context: result.context,
            }
          : { status: "ready", context: result.context },
      );
    }
    // The job is marked ready but its context cannot be assembled - surface a
    // real failure rather than a bare `ready` the client would misread as
    // carrying a context.
    return NextResponse.json({ status: "failed", stage: job.stage });
  }

  // An entity that matched more than one release is a distinct, recoverable
  // state - never collapse it into `unavailable`.
  if (job.state === "unavailable" && job.resolution_status === "ambiguous") {
    return NextResponse.json({ status: "ambiguous" });
  }

  if (job.state === "unavailable" || job.state === "failed") {
    // A failed job can still carry whatever was published before the failure
    // (e.g. one source failed after another was summarized); surface that
    // content rather than discarding it. Unavailable jobs have no content.
    if (job.state === "failed") {
      const result = await getContextBySlug(slug);
      if (result.status === "ok") {
        return NextResponse.json({
          status: "failed",
          stage: job.stage,
          context: result.context,
        });
      }
    }
    return NextResponse.json({ status: job.state, stage: job.stage });
  }

  // In-progress (queued/running): surface whatever partial context is already
  // safe to publish while the client keeps polling.
  const result = await getContextBySlug(slug);
  if (result.status === "ok") {
    return NextResponse.json({
      status: "partial",
      stage: job.stage,
      context: result.context,
      paused,
    });
  }

  return NextResponse.json({ status: job.state, stage: job.stage, paused });
}
