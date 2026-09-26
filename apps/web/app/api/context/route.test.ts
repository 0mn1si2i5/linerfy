import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { featuredContext } from "@linerfy/domain/fixtures";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  catalog: vi.fn(),
  client: vi.fn(),
  rpc: vi.fn(),
  job: null as Record<string, unknown> | null,
  paused: false,
}));
vi.mock("../../../lib/auth", () => ({
  bearerToken: (v: string | null) => v,
  resolveAuthState: mocks.auth,
}));
vi.mock("../../../lib/catalog", () => ({ getContextBySlug: mocks.catalog }));
vi.mock("../../../lib/supabase", () => ({ serviceClient: mocks.client }));
import { POST } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.job = {
    id: "job-1",
    state: "failed",
    stage: "fetch_sources",
    source_errors: [],
  };
  mocks.paused = false;
  mocks.auth.mockResolvedValue({ status: "authenticated" });
  mocks.catalog.mockResolvedValue({ status: "ok", context: featuredContext });
  mocks.rpc.mockResolvedValue({ data: true, error: null });
  mocks.client.mockReturnValue({
    rpc: mocks.rpc,
    from: (table: string) => {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({
          data:
            table === "enrichment_jobs"
              ? mocks.job
              : table === "service_flags"
                ? { value: mocks.paused ? "true" : "false" }
                : null,
          error: null,
        }),
      };
      return query;
    },
  });
});
function request(retry = false, auth = true) {
  return new NextRequest("https://example.com/api/context", {
    method: "POST",
    headers: auth ? { authorization: "Bearer test-token" } : {},
    body: JSON.stringify({
      provider: "spotify",
      artist: "Tame Impala",
      album: "Currents",
      title: "Let It Happen",
      retry,
    }),
  });
}
it("does not mutate the queue for unauthenticated retries", async () => {
  expect((await POST(request(true, false))).status).toBe(401);
  expect(mocks.rpc).not.toHaveBeenCalled();
});
it("retries a failed job through the guarded RPC and keeps its content", async () => {
  const response = await POST(request(true));
  expect(mocks.rpc).toHaveBeenCalledWith("retry_enrichment", {
    job_id: "job-1",
  });
  expect(await response.json()).toMatchObject({
    status: "partial",
    context: featuredContext,
  });
});
it("ordinary polling never restarts a terminal job", async () => {
  expect(await (await POST(request())).json()).toMatchObject({
    status: "failed",
    context: featuredContext,
  });
  expect(mocks.rpc).not.toHaveBeenCalled();
});
it("shows a source failure without discarding successful content", async () => {
  mocks.job = {
    ...mocks.job,
    state: "ready",
    source_errors: ["wikipedia:TimeoutError"],
  };
  expect(await (await POST(request())).json()).toMatchObject({
    status: "failed",
    context: featuredContext,
  });
});

it("rejects invalid now-playing data before accessing Supabase", async () => {
  const invalid = new NextRequest("https://example.com/api/context", {
    method: "POST",
    headers: { authorization: "Bearer test-token" },
    body: JSON.stringify({
      provider: "youtube",
      artist: "Tame Impala",
      album: "Currents",
      title: "Let It Happen",
    }),
  });

  const response = await POST(invalid);

  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: "invalid now-playing request",
  });
  expect(mocks.client).not.toHaveBeenCalled();
});

it("preserves the global pause state on partial responses", async () => {
  mocks.job = {
    id: "job-1",
    state: "running",
    stage: "build_source_summaries",
    source_errors: [],
  };
  mocks.paused = true;

  expect(await (await POST(request())).json()).toMatchObject({
    status: "partial",
    stage: "build_source_summaries",
    context: featuredContext,
    paused: true,
  });
});
