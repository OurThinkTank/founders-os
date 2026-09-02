#!/usr/bin/env node
// ============================================================
// Founders OS - Smithery publisher
// ============================================================
//   node packaging/mcpb/publish.mjs 1.7.1 [--dry-run]
//
// Publishes the built bundle to Smithery WITH a populated tools
// list, which `smithery mcp publish` cannot do.
//
// WHY THIS SCRIPT EXISTS
//
// Smithery never runs your bundle. It reads capabilities from a
// `serverCard` in the multipart publish PAYLOAD, and the CLI builds
// that card from the bundle manifest:
//
//   serverCard: {
//     serverInfo: { name: manifest.name, version: manifest.version },
//     ...(manifest.tools ? { tools: manifest.tools } : {}),
//   }
//
// So tools reach the registry only if the manifest declares them.
// But the two schemas are incompatible (smithery-ai/cli#787), which
// we confirmed by testing both shapes:
//
//   manifest.tools with name + description  -> mcpb validate PASSES,
//       registry REJECTS (its Tool requires ["name","inputSchema"])
//   manifest.tools with inputSchema         -> registry would accept,
//       mcpb validate FAILS (unrecognized key)
//
// No manifest satisfies both, so the CLI path cannot ever populate
// tools for a bundle like ours. This script bypasses it: the bundle
// keeps a clean, spec-valid manifest with no `tools` key (which is
// what Claude Desktop wants), and we send a proper serverCard
// straight to the API instead.
//
// The tools are enumerated by actually booting the staged server and
// calling tools/list, so the listing can never drift from reality.
// That only works because the server boots without credentials
// (runbook P9) - it is load-bearing here, not just a UX nicety.
// ============================================================

import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const QUALIFIED_NAME = "ourthinktank/founders-os";
const API = "https://api.smithery.ai";
const MAX_BUNDLE_BYTES = 25 * 1024 * 1024; // the CLI enforces this too

const version = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
if (!version) {
  console.error("usage: node packaging/mcpb/publish.mjs <version> [--dry-run]");
  process.exit(2);
}

const staged = join(REPO_ROOT, "build/mcpb");
const bundlePath = join(REPO_ROOT, `build/founders-os-${version}.mcpb`);

/**
 * Convert MCPB user_config into the JSON Schema the registry stores.
 *
 * A faithful port of the CLI's own transform, so the configSchema we send
 * is byte-identical to what `smithery mcp publish` would have sent. That
 * matters: the Configuration UX score is already perfect and this must not
 * regress it. Smithery adds `x-order` server-side; we do not send it.
 */
function toConfigSchema(userConfig) {
  const schema = { type: "object", properties: {}, required: [] };
  const required = [];

  for (const [key, opt] of Object.entries(userConfig)) {
    const parts = key.split(".");
    if (parts.length === 0) continue;

    let node = schema;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      node.properties ??= {};
      node.properties[seg] ??= { type: "object", properties: {} };
      node = node.properties[seg];
    }

    const leaf = parts[parts.length - 1];
    node.properties ??= {};

    // directory and file both surface as plain strings in the registry.
    const type = opt.type === "directory" || opt.type === "file" ? "string" : opt.type;
    const meta = {
      ...(opt.title ? { title: opt.title } : {}),
      ...(opt.description ? { description: opt.description } : {}),
      ...(opt.default !== undefined ? { default: opt.default } : {}),
    };
    node.properties[leaf] = opt.multiple
      ? { type: "array", items: { type }, ...meta }
      : { type, ...meta };

    if (opt.required && parts.length === 1) required.push(leaf);
  }

  if (required.length > 0) schema.required = required;
  return schema;
}

/** Boot the staged server with no configuration and return its tools/list. */
function enumerateTools(serverEntry, cwd) {
  return new Promise((resolvePromise, reject) => {
    // Strip every var the server reads, so this mirrors a clean machine and
    // proves the listing does not depend on the publisher's own credentials.
    const env = { ...process.env };
    for (const k of Object.keys(env)) {
      if (/^(SUPABASE_|FOUNDERS_OS_|EMBEDDING_|OPENAI_|AWS_|OLLAMA_)/.test(k)) delete env[k];
    }

    const child = spawn("node", [serverEntry], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let stderr = "";
    let settled = false;

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch {}
      fn(arg);
    };

    child.stdout.on("data", (d) => {
      out += d;
      for (const line of out.split("\n")) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 2 && msg.result?.tools) finish(resolvePromise, msg.result.tools);
      }
    });
    child.stderr.on("data", (d) => (stderr += d));
    child.on("exit", (code) =>
      finish(reject, new Error(`server exited (${code}) before listing tools:\n${stderr.slice(0, 500)}`))
    );

    const send = (m) => { try { child.stdin.write(JSON.stringify(m) + "\n"); } catch {} };
    send({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: {
        protocolVersion: "2024-11-05", capabilities: {},
        clientInfo: { name: "founders-os-publisher", version: "1.0.0" },
      },
    });
    setTimeout(() => {
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    }, 800);

    setTimeout(() => finish(reject, new Error("timed out waiting for tools/list")), 20_000);
  });
}

// ── Build the payload ───────────────────────────────────────
const manifest = JSON.parse(readFileSync(join(staged, "manifest.json"), "utf8"));

if (manifest.version !== version) {
  console.error(`ERROR: staged manifest is ${manifest.version}, expected ${version}.`);
  console.error(`Run: ./packaging/mcpb/build.sh ${version}`);
  process.exit(1);
}

const size = statSync(bundlePath).size;
if (size > MAX_BUNDLE_BYTES) {
  console.error(`ERROR: bundle is ${(size / 1024 / 1024).toFixed(1)} MB, over Smithery's 25 MB limit.`);
  process.exit(1);
}

console.log(`==> Enumerating tools from the staged server (no credentials)`);
const rawTools = await enumerateTools(join(staged, "server/index.js"), staged);

// The registry's Tool requires name + inputSchema. Send only fields it
// declares, so an SDK addition cannot fail the upload on an unknown key.
const tools = rawTools.map((t) => ({
  name: t.name,
  ...(t.title ? { title: t.title } : {}),
  ...(t.description ? { description: t.description } : {}),
  inputSchema: t.inputSchema ?? { type: "object" },
  ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
  ...(t.annotations ? { annotations: t.annotations } : {}),
}));

// Pre-flight against the registry's ServerCard schema, so a bad payload fails
// here with a precise message instead of as an opaque 400 after the upload.
// Constraints below are read from Smithery's OpenAPI spec: the Tool object is
// additionalProperties:false, requires ["name","inputSchema"], and its
// inputSchema.type is a const "object". annotations is also closed.
const TOOL_KEYS = new Set([
  "name", "title", "icons", "description",
  "inputSchema", "outputSchema", "annotations", "execution", "_meta",
]);
const ANNOTATION_KEYS = new Set([
  "title", "readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint",
]);

const problems = [];
for (const t of tools) {
  for (const k of Object.keys(t)) {
    if (!TOOL_KEYS.has(k)) problems.push(`${t.name}: unexpected key "${k}"`);
  }
  if (!t.name) problems.push("a tool is missing the required 'name'");
  if (!t.inputSchema) problems.push(`${t.name}: missing required 'inputSchema'`);
  else if (t.inputSchema.type !== "object") {
    problems.push(`${t.name}: inputSchema.type is "${t.inputSchema.type}", must be "object"`);
  }
  for (const k of Object.keys(t.annotations ?? {})) {
    if (!ANNOTATION_KEYS.has(k)) problems.push(`${t.name}: annotations.${k} is not an allowed key`);
  }
}
if (problems.length) {
  console.error(`\nERROR: ${problems.length} payload problems the registry would reject:`);
  for (const p of problems.slice(0, 20)) console.error("  " + p);
  if (problems.length > 20) console.error(`  ...and ${problems.length - 20} more`);
  process.exit(1);
}

const payload = {
  type: "stdio",
  runtime: "node",
  configSchema: toConfigSchema(manifest.user_config ?? {}),
  serverCard: {
    serverInfo: {
      name: manifest.name,
      version: manifest.version,
      ...(manifest.display_name ? { title: manifest.display_name } : {}),
      ...(manifest.description ? { description: manifest.description } : {}),
      ...(manifest.homepage ? { websiteUrl: manifest.homepage } : {}),
    },
    tools,
  },
};

console.log(`    tools enumerated : ${tools.length}`);
console.log(`    config fields    : ${Object.keys(payload.configSchema.properties).length}`);
console.log(`    required fields  : ${JSON.stringify(payload.configSchema.required ?? [])}`);
console.log(`    bundle           : ${(size / 1024 / 1024).toFixed(1)} MB`);

if (dryRun) {
  console.log("\n--dry-run: payload built, nothing uploaded.");
  console.log(JSON.stringify({ ...payload, serverCard: { ...payload.serverCard, tools: `[${tools.length} tools]` } }, null, 2));
  process.exit(0);
}

const apiKey = process.env.SMITHERY_API_KEY;
if (!apiKey) {
  console.error("\nERROR: SMITHERY_API_KEY is not set.");
  console.error("Mint one at https://smithery.ai (or `smithery auth token`), then:");
  console.error(`  SMITHERY_API_KEY=... node packaging/mcpb/publish.mjs ${version}`);
  process.exit(1);
}

const form = new FormData();
form.append("payload", JSON.stringify(payload));
form.append(
  "bundle",
  new Blob([readFileSync(bundlePath)], { type: "application/zip" }),
  `founders-os-${version}.mcpb`
);

const url = `${API}/servers/${encodeURIComponent(QUALIFIED_NAME)}/releases`;
console.log(`\n==> PUT ${url}`);
const res = await fetch(url, {
  method: "PUT",
  headers: { Authorization: `Bearer ${apiKey}` },
  body: form,
});

const text = await res.text();
if (!res.ok) {
  console.error(`ERROR ${res.status}: ${text}`);
  process.exit(1);
}
console.log(text);
console.log(`\n==> Published. Verify tools are populated:`);
console.log(`  curl -s https://registry.smithery.ai/servers/${QUALIFIED_NAME} | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log('tools:',(JSON.parse(s).tools||[]).length))"`);
