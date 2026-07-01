// ============================================================
// Founders OS — Governance token tests
// ============================================================
// Asserts real signing behavior: round-trip, expiry, tamper rejection,
// per-tier TTL, and the reissue-binds-same-jti+hash property the
// approval flow depends on. A signing secret is set in beforeAll so the
// HMAC key is deterministic for the run.
// ============================================================

import { describe, it, expect, beforeAll } from "vitest";
import {
  signToken,
  verifyToken,
  issueToken,
  ttlForTier,
  type TokenPayload,
} from "../tools/governance/token.js";

beforeAll(() => {
  process.env.FOUNDERS_OS_SIGNING_SECRET = "test-signing-secret-deterministic";
});

const NOW = 1_750_000_000;

function basePayload(overrides: Partial<TokenPayload> = {}): TokenPayload {
  return {
    jti: "00000000-0000-0000-0000-000000000001",
    action_hash: "hash-abc",
    tier: "external_write",
    iat: NOW,
    exp: NOW + 600,
    ...overrides,
  };
}

describe("token sign/verify round-trip", () => {
  it("verifies a freshly signed token", () => {
    const token = signToken(basePayload());
    const r = verifyToken(token, NOW + 1);
    expect(r.valid).toBe(true);
    if (r.valid) {
      expect(r.payload.jti).toBe("00000000-0000-0000-0000-000000000001");
      expect(r.payload.action_hash).toBe("hash-abc");
    }
  });
});

describe("token expiry", () => {
  it("rejects a token at/after exp", () => {
    const token = signToken(basePayload({ exp: NOW + 600 }));
    const r = verifyToken(token, NOW + 600);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe("expired");
  });

  it("accepts a token before exp", () => {
    const token = signToken(basePayload({ exp: NOW + 600 }));
    expect(verifyToken(token, NOW + 599).valid).toBe(true);
  });
});

describe("token tamper rejection", () => {
  it("rejects a token whose body was altered (signature mismatch)", () => {
    const token = signToken(basePayload());
    const [body, sig] = token.split(".");
    // Flip the payload to a different action_hash but keep the old sig.
    const forgedBody = Buffer.from(
      JSON.stringify(basePayload({ action_hash: "hash-EVIL" }))
    ).toString("base64url");
    const forged = forgedBody + "." + sig;
    expect(forged).not.toBe(token);
    const r = verifyToken(forged, NOW + 1);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe("bad_signature");
  });

  it("rejects a malformed token", () => {
    expect(verifyToken("not-a-token", NOW).valid).toBe(false);
    expect(verifyToken("", NOW).valid).toBe(false);
  });

  it("does not verify under a different signing secret", () => {
    const token = signToken(basePayload());
    process.env.FOUNDERS_OS_SIGNING_SECRET = "a-completely-different-secret";
    const r = verifyToken(token, NOW + 1);
    process.env.FOUNDERS_OS_SIGNING_SECRET = "test-signing-secret-deterministic";
    expect(r.valid).toBe(false);
  });
});

describe("TTL by tier", () => {
  it("gives red tiers a shorter window than external_write", () => {
    expect(ttlForTier("destructive")).toBeLessThan(ttlForTier("external_write"));
    expect(ttlForTier("exfiltration")).toBeLessThan(ttlForTier("external_write"));
    expect(ttlForTier("destructive")).toBe(600);
    expect(ttlForTier("external_write")).toBe(1800);
  });

  it("issueToken sets exp = iat + tier TTL", () => {
    const { payload } = issueToken("jti-1", "hash-1", "destructive", NOW);
    expect(payload.exp - payload.iat).toBe(ttlForTier("destructive"));
  });
});

describe("reissue binds same jti + action_hash, fresh window", () => {
  it("a reissued token carries the same binding but a later expiry", () => {
    const first = issueToken("jti-9", "hash-9", "exfiltration", NOW);
    // Original token has expired by the time a human approves hours later.
    expect(verifyToken(first.token, NOW + first.payload.exp).valid).toBe(false);

    const laterNow = NOW + 5 * 3600; // 5 hours after preview
    const reissued = issueToken("jti-9", "hash-9", "exfiltration", laterNow);

    expect(reissued.payload.jti).toBe(first.payload.jti);
    expect(reissued.payload.action_hash).toBe(first.payload.action_hash);
    expect(reissued.payload.exp).toBeGreaterThan(first.payload.exp);

    const r = verifyToken(reissued.token, laterNow + 1);
    expect(r.valid).toBe(true);
  });
});
