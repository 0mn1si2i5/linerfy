import { describe, expect, it } from "vitest";

import { isPoxServiceAuthorized } from "./service-auth";

describe("isPoxServiceAuthorized", () => {
  it("accepts the configured bearer token", () => {
    expect(isPoxServiceAuthorized("Bearer pox-secret", "pox-secret")).toBe(
      true,
    );
  });

  it("rejects missing and non-bearer credentials", () => {
    expect(isPoxServiceAuthorized(null, "pox-secret")).toBe(false);
    expect(isPoxServiceAuthorized("Basic pox-secret", "pox-secret")).toBe(
      false,
    );
  });

  it("rejects an incorrect token and an unconfigured service", () => {
    expect(isPoxServiceAuthorized("Bearer wrong", "pox-secret")).toBe(false);
    expect(isPoxServiceAuthorized("Bearer pox-secret", "")).toBe(false);
  });
});
