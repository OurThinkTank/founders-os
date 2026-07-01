// ============================================================
// Founders OS — Governance Confirm Token
// ============================================================
// A short-lived, signed proof that a specific action was previewed
// (and, for held tiers, approved by a human). preview_action mints
// one; execute_action verifies it before recording an action as
// cleared-to-run. The token is HMAC-signed with a server-held secret
// the AGENT NEVER SEES, so the agent cannot forge one.
//
// HONEST SCOPE (read governance docs before marketing copy):
//   The token is NOT the security boundary. Founders OS cannot
//   intercept a connector call, so an agent could skip the gate
//   entirely. The token's jobs are narrow and real:
//     1. Bind a cleared action to the exact resolved params it was
//        classified on (action_hash), so an approval cannot be
//        replayed against a *different* action.
//     2. Bound the execute window in time (exp), so a leaked token
//        is not valid forever.
//   The durable record of intent + approval lives in pending_approvals
//   and audit_log; the token is the per-attempt proof, not the ledger.
//
// SECRET SOURCING (decision — see spec docs):
//   FOUNDERS_OS_SIGNING_SECRET if set (lets operators rotate / separate
//   it), else derived from SUPABASE_SECRET_KEY with domain separation.
//   Both are server-side only. We do NOT invent a random per-process
//   secret because tokens must verify across the separate preview and
//   execute invocations of a scheduled run (different processes).
// ============================================================

import { createHmac, timingSafeEqual } from "node:crypto";
import type { RiskTier } from "../playbooks/risk.js";

const DOMAIN = "founders-os/governance/confirm/v1";

/** Per-tier execute-window TTL in seconds. Red tiers get the shortest window. */
const TTL_BY_TIER: Record<RiskTier, number> = {
  read: 30 * 60,
  native_create: 30 * 60,
  external_write: 30 * 60,
  destructive: 10 * 60,
  exfiltration: 10 * 60,
};

export function ttlForTier(tier: RiskTier): number {
  return TTL_BY_TIER[tier];
}

export interface TokenPayload {
  /** Unique id of the pending_approvals row this token authorizes. */
  jti: string;
  /** Hash of (action_type + resolved params) — binds the token to one action. */
  action_hash: string;
  tier: RiskTier;
  /** Issued-at, epoch seconds. */
  iat: number;
  /** Expiry, epoch seconds. */
  exp: number;
}

/**
 * Resolve the HMAC key. Server-side only; never exposed to the agent.
 * Throws if neither source is configured, because silently signing with
 * an empty key would make every token trivially forgeable.
 */
function signingKey(): string {
  const explicit = process.env.FOUNDERS_OS_SIGNING_SECRET;
  if (explicit && explicit.trim().length > 0) return explicit;
  const supa = process.env.SUPABASE_SECRET_KEY;
  if (supa && supa.trim().length > 0) return DOMAIN + "\n" + supa;
  throw new Error(
    "No signing secret available: set FOUNDERS_OS_SIGNING_SECRET or SUPABASE_SECRET_KEY."
  );
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function hmac(data: string): string {
  return createHmac("sha256", signingKey()).update(DOMAIN + "\n" + data).digest("base64url");
}

/**
 * Sign a payload into a `<body>.<sig>` token. `iat`/`exp` are taken
 * from the payload so the caller controls the window (and so reissue
 * can mint a fresh window for the same jti + hash).
 */
export function signToken(payload: TokenPayload): string {
  const body = b64url(JSON.stringify(payload));
  return body + "." + hmac(body);
}

/**
 * Mint a token now for the given binding. Used both by preview_action
 * (first issue) and approve_action (reissue after a human approves, so
 * the daily clock's next tick executes inside a fresh window even
 * though the original preview token has long expired).
 */
export function issueToken(
  jti: string,
  action_hash: string,
  tier: RiskTier,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): { token: string; payload: TokenPayload } {
  const payload: TokenPayload = {
    jti,
    action_hash,
    tier,
    iat: nowSeconds,
    exp: nowSeconds + ttlForTier(tier),
  };
  return { token: signToken(payload), payload };
}

export type VerifyResult =
  | { valid: true; payload: TokenPayload }
  | { valid: false; reason: "malformed" | "bad_signature" | "expired" };

/**
 * Verify signature first (constant-time), then expiry. A tampered body
 * fails the signature check; an authentic but stale token fails on exp.
 */
export function verifyToken(
  token: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): VerifyResult {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return { valid: false, reason: "malformed" };
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = hmac(body);
  // Constant-time compare; mismatched lengths are an automatic fail.
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return { valid: false, reason: "bad_signature" };
  }

  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { valid: false, reason: "malformed" };
  }
  if (
    typeof payload?.jti !== "string" ||
    typeof payload?.action_hash !== "string" ||
    typeof payload?.exp !== "number"
  ) {
    return { valid: false, reason: "malformed" };
  }
  if (nowSeconds >= payload.exp) return { valid: false, reason: "expired" };

  return { valid: true, payload };
}
