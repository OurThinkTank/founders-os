// ============================================================
// Founders OS — Action Risk Classifier (governance runtime)
// ============================================================
// Pure (no DB, no env) security-critical classifier. It assigns a
// risk tier to a PROPOSED ACTION whose params have ALREADY BEEN
// RESOLVED to their real runtime values (a real recipient, amount,
// message body, or URL — not a {{placeholder}}). This is the
// classification half of the governance gate: preview_action resolves
// the templated action server-side, then hands the resolved action
// here to obtain { tier, outcome inputs, blocking issues, reasons }.
//
// WHY THIS IS NET-NEW (and not the Playbook Exchange classifier):
//   The Exchange classifier in ./share.ts (classifyStep) inspects a
//   TEMPLATED playbook step at import time, where the dangerous signal
//   is a sensitive {{placeholder}} that *would* resolve to private
//   data later. This classifier inspects the action AFTER resolution,
//   where the dangerous signal is the resolved literal itself: an
//   actual email address, an actual secret-looking token, an actual
//   currency amount, or a residual placeholder that never resolved.
//   The tier vocabulary is shared deliberately (read / native_create /
//   external_write / destructive / exfiltration) so both halves speak
//   the same language; when the Exchange branch lands on the same
//   base, the shared primitives (tiers, SSRF guard, secret patterns)
//   should be lifted into one module consumed by both. Until then this
//   file is the single definition for the RUNTIME gate and does not
//   import share.ts (which is not present on this branch).
//
// THREAT-MODEL ANCHORS:
//   - Founders OS cannot intercept a connector call (it is the
//     orchestration layer; the agent holds the connectors). So this
//     classifier does not "block" — it informs the policy which tiers
//     to WITHHOLD + record. Prevention is out of scope by design; see
//     the governance docs. What it must never do is mislabel an
//     exfiltrating or destructive action as benign.
//   - The subtle danger is EXFILTRATION, not the obvious delete: an
//     external action that carries the founder's private data
//     (a contact email, a stored secret, a financial figure) out to a
//     third party looks helpful and never trips a "delete" check.
//     Classify data-movement, not just deletion verbs.
//   - Every URL in the resolved params goes through the same SSRF
//     guard the RSS fetcher uses (validateFeedUrl). Non-http(s)
//     schemes and private/reserved hosts are rejected regardless of
//     tier. Do not write a second URL validator.
// ============================================================

import { validateFeedUrl } from "../rss/fetcher.js";

// ── Risk tiers ────────────────────────────────────────────
// Identical vocabulary to the Exchange classifier so policy, audit,
// and UI speak one language across import-time and runtime.

export type RiskTier =
  | "read"
  | "native_create"
  | "external_write"
  | "destructive"
  | "exfiltration";

const TIER_ORDER: Record<RiskTier, number> = {
  read: 0,
  native_create: 1,
  external_write: 2,
  destructive: 3,
  exfiltration: 4,
};

/** Tiers rendered in bold red and always held for human approval. */
export const RED_TIERS: ReadonlySet<RiskTier> = new Set<RiskTier>([
  "destructive",
  "exfiltration",
]);

export function maxTier(a: RiskTier, b: RiskTier): RiskTier {
  return TIER_ORDER[a] >= TIER_ORDER[b] ? a : b;
}

// ── Proposed action shape ──────────────────────────────────

/**
 * A proposed action handed to the classifier with params already
 * resolved to runtime values.
 *
 *   - kind "native":   stays inside Founders OS (creates a task/row).
 *                      Never reaches a connector, so private data in
 *                      its fields is not exfiltration — it just lands
 *                      in a local row.
 *   - kind "external": dispatched by the agent to a connector
 *                      (Slack, Stripe, GitHub, ...). This is where
 *                      data can leave the building.
 */
export interface ProposedAction {
  kind: "native" | "external";
  /** Connector id for external actions, e.g. "slack" | "stripe". */
  connector?: string | null;
  /** Connector verb, e.g. "send_message" | "create_charge" | "delete_customer". */
  action?: string | null;
  /** Resolved parameters (real values, not placeholders). */
  params?: Record<string, unknown> | null;
  /** Optional human-readable one-liner; included in scanned text. */
  summary?: string | null;
}

// ── Verb dictionaries (matched per-token, case-insensitive) ──
// Kept in lockstep with the Exchange classifier's dictionaries so a
// verb judged destructive at import time is judged destructive at
// runtime. "merge"/"force" deliberately excluded to avoid red fatigue.

const DESTRUCTIVE_VERBS = new Set([
  "delete", "remove", "destroy", "purge", "drop", "wipe", "erase",
  "revoke", "uninstall", "deactivate", "disable", "archive", "truncate",
  "ban", "kick", "terminate", "cancel", "unsubscribe", "unlink",
  "reset", "overwrite", "clear", "flush", "expire", "deprovision",
  "teardown", "prune", "evict", "rotate", "replace", "reformat",
  "format", "rollback", "revert", "rewrite", "refund", "chargeback",
]);

const READ_VERBS = new Set([
  "get", "list", "read", "fetch", "search", "view", "find", "query",
  "show", "describe", "lookup", "preview", "summarize",
]);

function tokens(s: string | null | undefined): string[] {
  return (s ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function hasVerb(action: string | null | undefined, set: Set<string>): boolean {
  return tokens(action).some((t) => set.has(t));
}

// ── Sensitive-data detection (the exfiltration signal) ─────
// Over RESOLVED values we look for two things:
//   (1) residual sensitive placeholders that never resolved — a
//       template bug or an attempt to smuggle private data; same
//       patterns the Exchange classifier uses at import time, kept
//       here as defense in depth.
//   (2) actual sensitive literals: a real email address, a
//       secret-looking token, or a currency amount.

const SENSITIVE_PLACEHOLDER_PATTERNS: RegExp[] = [
  /\{\{\s*memory\s*:/i,                                   // {{memory:stripe_key}}
  /\{\{[^}]*\bemail\b[^}]*\}\}/i,                          // {{contact.primary.email}}
  /\{\{[^}]*\b(ssn|secret|token|password|api[_-]?key|key)\b[^}]*\}\}/i,
];

export function findSensitivePlaceholders(text: string): string[] {
  const hits = new Set<string>();
  for (const re of SENSITIVE_PLACEHOLDER_PATTERNS) {
    const m = text.match(new RegExp(re, "gi"));
    if (m) for (const x of m) hits.add(x.trim());
  }
  return Array.from(hits);
}

/** Literal email addresses appearing in a resolved value. */
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

export function findEmails(text: string): string[] {
  return Array.from(new Set(text.match(EMAIL_RE) ?? []));
}

/**
 * Currency-like amounts: a symbol-prefixed figure ($1,200.00, €50),
 * or a bare figure tagged with a currency code (1200 USD). Deliberately
 * conservative on bare numbers to avoid flagging every "5" — a number
 * only counts as financial when it carries a symbol or currency code.
 */
const CURRENCY_PATTERNS: RegExp[] = [
  /[$£€¥]\s?\d[\d,]*(?:\.\d{1,2})?/g,
  /\b\d[\d,]*(?:\.\d{1,2})?\s?(?:usd|eur|gbp|cad|aud|jpy)\b/gi,
];

export function findFinancialValues(text: string): string[] {
  const hits = new Set<string>();
  for (const re of CURRENCY_PATTERNS) {
    const m = text.match(new RegExp(re));
    if (m) for (const x of m) hits.add(x.trim());
  }
  return Array.from(hits);
}

// ── Hard-coded / resolved secret scanning ──────────────────
// Same patterns the Exchange classifier uses; here they fire on a
// RESOLVED value (e.g. {{memory:api_key}} resolved to a real sk-...).

const SECRET_PATTERNS: { label: string; re: RegExp }[] = [
  { label: "openai_key", re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { label: "aws_access_key_id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "github_token", re: /\bghp_[A-Za-z0-9]{30,}\b/ },
  { label: "slack_token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { label: "private_key_block", re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { label: "bearer_token", re: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/ },
];

export function scanSecrets(text: string): string[] {
  const found = new Set<string>();
  for (const { label, re } of SECRET_PATTERNS) {
    if (re.test(text)) found.add(label);
  }
  return Array.from(found);
}

// ── URL extraction + SSRF guard (reuses validateFeedUrl) ───

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]+/gi;

export function extractUrls(text: string): string[] {
  return Array.from(new Set(text.match(URL_RE) ?? []));
}

/**
 * URLs that are malformed, use a non-http(s) scheme, or resolve to a
 * private/reserved address. validateFeedUrl throws on all three, so a
 * throw here means "block". One validator, reused — never a second.
 */
export function findBlockedUrls(text: string): string[] {
  const blocked: string[] = [];
  for (const url of extractUrls(text)) {
    try {
      validateFeedUrl(url);
    } catch {
      blocked.push(url);
    }
  }
  return blocked;
}

/**
 * Bare private/reserved hosts that appear OUTSIDE a full URL — e.g. a
 * connector param { host: "169.254.169.254" }. The URL scanner only
 * sees full URLs; without this an SSRF target split across fields
 * would slip through. Literal-string check; DNS-rebinding (a public
 * domain that resolves to a private address) is a documented residual.
 */
const PRIVATE_HOST_PATTERNS: RegExp[] = [
  /\b10(?:\.\d{1,3}){3}\b/,
  /\b192\.168(?:\.\d{1,3}){2}\b/,
  /\b172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}\b/,
  /\b127(?:\.\d{1,3}){3}\b/,
  /\b169\.254(?:\.\d{1,3}){2}\b/,
  /\b0\.0\.0\.0\b/,
  /metadata\.google\.internal/i,
];

export function findBlockedHosts(text: string): string[] {
  const hits = new Set<string>();
  for (const re of PRIVATE_HOST_PATTERNS) {
    const m = text.match(new RegExp(re, "gi"));
    if (m) for (const x of m) hits.add(x);
  }
  return Array.from(hits);
}

// ── Classification result ──────────────────────────────────

export interface ActionBlock {
  code: "private_url" | "private_host";
  detail: string;
}

export interface ActionAssessment {
  tier: RiskTier;
  destructive: boolean;
  exfiltration: boolean;
  /** Sensitive signals found in the resolved action (for the reasons + UI). */
  sensitive_placeholders: string[];
  emails: string[];
  financial_values: string[];
  secrets_found: string[];
  /** SSRF blocks. When non-empty, preview_action must refuse the action. */
  blocks: ActionBlock[];
  /** Plain-language reasons, safe to surface to a human. */
  reasons: string[];
}

/**
 * Flatten an action into one scannable string. Resolved params are
 * JSON-stringified so a sensitive value nested anywhere in the params
 * is still seen by the detectors.
 */
function actionText(action: ProposedAction): string {
  return [
    action.summary ?? "",
    action.action ?? "",
    action.connector ?? "",
    action.params ? JSON.stringify(action.params) : "",
  ].join("\n");
}

/**
 * Classify a proposed action with resolved params.
 *
 * Tiering:
 *   native            -> read (if a read verb) else native_create
 *   external + read   -> read
 *   external + destructive verb -> destructive
 *   external (other)  -> external_write
 *   external carrying sensitive data -> escalated to exfiltration
 *
 * SSRF: any blocked URL/host is recorded in `blocks` regardless of
 * tier. The caller (preview_action) refuses to issue a token when
 * `blocks` is non-empty.
 */
export function classifyAction(action: ProposedAction): ActionAssessment {
  const text = actionText(action);

  const blockedUrls = findBlockedUrls(text);
  const blockedHosts = findBlockedHosts(text).filter(
    (h) => !blockedUrls.some((u) => u.includes(h))
  );
  const secrets = scanSecrets(text);
  const reasons: string[] = [];

  let tier: RiskTier;
  let destructive = false;
  let exfiltration = false;

  // Sensitive-data signals only matter for EXTERNAL actions: a native
  // task that contains an email just stores it locally.
  let sensitivePlaceholders: string[] = [];
  let emails: string[] = [];
  let financial: string[] = [];

  if (action.kind === "native") {
    const isRead = hasVerb(action.action, READ_VERBS);
    tier = isRead ? "read" : "native_create";
    reasons.push(
      isRead
        ? "Reads data inside Founders OS."
        : "Creates a task or row inside Founders OS."
    );
  } else {
    const isDestructive = hasVerb(action.action, DESTRUCTIVE_VERBS);
    const isRead = hasVerb(action.action, READ_VERBS) && !isDestructive;

    if (isDestructive) {
      tier = "destructive";
      destructive = true;
      reasons.push(
        `Destructive action "${action.action ?? "?"}" on ${action.connector ?? "a connector"}: may delete or irreversibly change data.`
      );
    } else if (isRead) {
      tier = "read";
      reasons.push(`Reads from ${action.connector ?? "a connector"}.`);
    } else {
      tier = "external_write";
      reasons.push(
        `Creates or changes data in ${action.connector ?? "a connector"} via "${action.action ?? "?"}".`
      );
    }

    sensitivePlaceholders = findSensitivePlaceholders(text);
    emails = findEmails(text);
    financial = findFinancialValues(text);

    // Exfiltration overrides everything below it. An external action
    // carrying the founder's private data out is the worst case.
    const exfilSignals: string[] = [];
    if (sensitivePlaceholders.length > 0) {
      exfilSignals.push(`unresolved private placeholders (${sensitivePlaceholders.join(", ")})`);
    }
    if (secrets.length > 0) {
      exfilSignals.push(`a secret-looking value (${secrets.join(", ")})`);
    }
    if (emails.length > 0) {
      exfilSignals.push(`a contact email address (${emails.join(", ")})`);
    }
    if (financial.length > 0) {
      exfilSignals.push(`a financial figure (${financial.join(", ")})`);
    }
    if (exfilSignals.length > 0) {
      tier = maxTier(tier, "exfiltration");
      exfiltration = true;
      reasons.push(
        `Sends private data to an external tool: ${exfilSignals.join("; ")}.`
      );
    }
  }

  const blocks: ActionBlock[] = [];
  for (const u of blockedUrls) {
    blocks.push({
      code: "private_url",
      detail: `Targets a malformed, non-http(s), or private/reserved URL (possible SSRF): ${u}.`,
    });
  }
  for (const h of blockedHosts) {
    blocks.push({
      code: "private_host",
      detail: `References a private/reserved host (possible SSRF): ${h}.`,
    });
  }
  if (blocks.length > 0) {
    reasons.push(
      `Refusing to proceed: ${blocks.map((b) => b.detail).join(" ")}`
    );
  }

  return {
    tier,
    destructive,
    exfiltration,
    sensitive_placeholders: sensitivePlaceholders,
    emails,
    financial_values: financial,
    secrets_found: secrets,
    blocks,
    reasons,
  };
}

/**
 * Stable hash input for an action: the action_type plus its resolved
 * params, key-sorted so equal actions hash equally regardless of key
 * order. preview_action binds this hash into the signed token and
 * stores it on the pending_approvals row; execute_action recomputes it
 * from the echoed action and refuses if it does not match — so an
 * approval cannot be replayed against a different action.
 */
export function canonicalActionString(action: ProposedAction): string {
  return canonicalize({
    kind: action.kind,
    connector: action.connector ?? null,
    action: action.action ?? null,
    params: action.params ?? null,
  });
}

const MAX_CANON_DEPTH = 100;

function canonicalize(value: unknown, depth = 0): string {
  if (depth > MAX_CANON_DEPTH) {
    throw new Error("Action structure is nested too deeply to process.");
  }
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalize(v, depth + 1)).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k], depth + 1)).join(",") + "}";
}
