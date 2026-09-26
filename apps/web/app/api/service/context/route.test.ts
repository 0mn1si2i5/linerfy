import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  handleContextRequest: vi.fn(),
}));

vi.mock("../../../../lib/context-service", () => ({
  handleContextRequest: mocks.handleContextRequest,
}));

import { POST } from "./route";

beforeEach(() => {
  vi.stubEnv("LINERFY_POX_SERVICE_TOKEN", "pox-secret");
  mocks.handleContextRequest.mockResolvedValue(
    NextResponse.json({ status: "queued", stage: "resolve_entity" }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

function request(authorization?: string) {
  return new NextRequest("https://example.com/api/service/context", {
    method: "POST",
    headers: authorization ? { authorization } : {},
    body: JSON.stringify({
      provider: "spotify",
      artist: "Tame Impala",
      album: "Currents",
      title: "Let It Happen",
    }),
  });
}

it("rejects missing and incorrect service credentials before task handling", async () => {
  expect((await POST(request())).status).toBe(401);
  expect((await POST(request("Bearer wrong"))).status).toBe(401);
  expect(mocks.handleContextRequest).not.toHaveBeenCalled();
});

it("fails closed when the service token is not configured", async () => {
  vi.stubEnv("LINERFY_POX_SERVICE_TOKEN", "");

  expect((await POST(request("Bearer pox-secret"))).status).toBe(401);
  expect(mocks.handleContextRequest).not.toHaveBeenCalled();
});

it("delegates an authorized request to the shared context handler", async () => {
  const input = request("Bearer pox-secret");
  const response = await POST(input);

  expect(response.status).toBe(200);
  expect(mocks.handleContextRequest).toHaveBeenCalledOnce();
  expect(mocks.handleContextRequest).toHaveBeenCalledWith(input);
  expect(await response.json()).toEqual({
    status: "queued",
    stage: "resolve_entity",
  });
});
