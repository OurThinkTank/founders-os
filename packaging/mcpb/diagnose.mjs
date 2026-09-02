#!/usr/bin/env node
// ============================================================
// Founders OS - Smithery release diagnostics
// ============================================================
//   SMITHERY_API_KEY=... node packaging/mcpb/diagnose.mjs
//
// Prints the real reason a release did or did not populate tools,
// straight from Smithery's pipeline logs. Use this INSTEAD of
// theorising about what the platform might be doing.
//
// Release status values, from the API spec:
//   QUEUED, WORKING, SUCCESS, FAILURE, FAILURE_SCAN,
//   AUTH_REQUIRED, CANCELLED, INTERNAL_ERROR
//
// FAILURE_SCAN is the one that matters here. It means Smithery
// launched the bundle to enumerate capabilities and that step
// failed, which is exactly the state that leaves tools null while
// everything else about the listing looks healthy.
// ============================================================

const API = "https://api.smithery.ai";
const REGISTRY = "https://registry.smithery.ai";
const NAME = process.argv[2] || "ourthinktank/founders-os";
const key = process.env.SMITHERY_API_KEY;

if (!key) {
  console.error("ERROR: SMITHERY_API_KEY is not set.");
  console.error("Mint one with `smithery auth token` or from the dashboard, then:");
  console.error(`  SMITHERY_API_KEY=... node packaging/mcpb/diagnose.mjs ${NAME}`);
  process.exit(1);
}

const enc = encodeURIComponent(NAME);
const auth = { Authorization: `Bearer ${key}` };

async function get(url, opts = {}) {
  try {
    const res = await fetch(url, opts);
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    // Network failure, not an API error. Report it plainly rather than
    // dumping an undici stack trace.
    return { ok: false, status: 0, body: `network error: ${err?.cause?.code ?? err.message}` };
  }
}

// ── 1. What the public registry currently shows ─────────────
const reg = await get(`${REGISTRY}/servers/${enc}`);
if (reg.ok) {
  const c = reg.body.connections?.[0] ?? {};
  console.log("=== public registry record ===");
  console.log("  tools      :", reg.body.tools ? `${reg.body.tools.length} listed` : "null  <-- the problem");
  console.log("  resources  :", reg.body.resources ? reg.body.resources.length : "null");
  console.log("  prompts    :", reg.body.prompts ? reg.body.prompts.length : "null");
  console.log("  connection :", c.type, "| runtime:", c.runtime);
  console.log("  bundleUrl  :", c.bundleUrl);
  console.log("  required   :", JSON.stringify(c.configSchema?.required ?? []));
} else {
  console.log("registry lookup failed:", reg.status, reg.body);
}

// ── 2. Release history ──────────────────────────────────────
console.log("\n=== releases ===");
const list = await get(`${API}/servers/${enc}/releases`, { headers: auth });
if (!list.ok) {
  console.error("  failed:", list.status, JSON.stringify(list.body).slice(0, 300));
  console.error("  (a 401/403 means the API key lacks access to this namespace)");
  process.exit(1);
}

const releases = Array.isArray(list.body) ? list.body : list.body.releases ?? [];
if (!releases.length) {
  console.log("  none found");
  process.exit(0);
}

for (const r of releases.slice(0, 5)) {
  console.log(`  ${r.status?.padEnd(14) ?? "?"} ${r.type ?? "?"}  ${r.createdAt ?? ""}  ${r.id}`);
}

// ── 3. Pipeline logs for the most recent release ────────────
// Logs are only returned when fetching a SINGLE release.
const latest = releases[0];
console.log(`\n=== pipeline logs for ${latest.id} (${latest.status}) ===`);
const detail = await get(`${API}/servers/${enc}/releases/${latest.id}`, { headers: auth });
if (!detail.ok) {
  console.error("  failed:", detail.status, JSON.stringify(detail.body).slice(0, 300));
  process.exit(1);
}

const logs = detail.body.logs ?? [];
if (!logs.length) {
  console.log("  (no log entries returned)");
} else {
  for (const l of logs) {
    const line = typeof l === "string" ? l : (l.message ?? JSON.stringify(l));
    console.log("  " + line);
  }
}

console.log("\n=== read this as ===");
console.log("  SUCCESS + tools null  -> capabilities came from the payload serverCard,");
console.log("                           and ours did not carry one. Use publish.mjs.");
console.log("  FAILURE_SCAN          -> Smithery launched the bundle and the scan failed.");
console.log("                           The logs above say why. Fix that, not the manifest.");
console.log("  AUTH_REQUIRED         -> it wanted credentials to complete the scan.");
