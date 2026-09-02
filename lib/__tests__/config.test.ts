import { describe, it, expect } from "vitest";
import { isZaloEnabled, ensurePairingCode } from "../config.ts";
import type { ZaloConfig } from "../types.ts";

describe("isZaloEnabled", () => {
  it("returns false when no token", () => {
    expect(isZaloEnabled({})).toBe(false);
  });

  it("returns true when token and no explicit enabled", () => {
    expect(isZaloEnabled({ zaloToken: "token123" })).toBe(true);
  });

  it("respects explicit zaloEnabled", () => {
    expect(isZaloEnabled({ zaloToken: "token", zaloEnabled: false })).toBe(false);
    expect(isZaloEnabled({ zaloToken: "token", zaloEnabled: true })).toBe(true);
  });
});

describe("ensurePairingCode", () => {
  it("generates a 6-digit code when unpaired", () => {
    const result = ensurePairingCode({ zaloToken: "token" });
    expect(result.pairingCode).toMatch(/^\d{6}$/);
  });

  it("clears pairing code when already paired", () => {
    const result = ensurePairingCode({ zaloToken: "token", allowedUserId: "user1", pairingCode: "123456" });
    expect(result.pairingCode).toBeUndefined();
  });

  it("preserves existing pairing code", () => {
    const result = ensurePairingCode({ zaloToken: "token", pairingCode: "654321" });
    expect(result.pairingCode).toBe("654321");
  });
});
