// Tests for the shared setup-page generators. Dependency-free: run with
//   node --test integrations/setup-page/lib/setup-generators.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const gen = require("./setup-generators.js");

const ENV = {
  SUPABASE_URL: "https://abc.supabase.co",
  SUPABASE_SECRET_KEY: "sb_secret_xyz",
  FOUNDERS_OS_COMPANY_ID: "ourthinktank",
  EMBEDDING_PROVIDER: "openai",
  OPENAI_API_KEY: "sk-test",
};

test("buildMcpJson nests the env and pins @latest when asked", () => {
  const cfg = gen.buildMcpJson(ENV, { useLatest: true });
  const srv = cfg.mcpServers["founders-os"];
  assert.equal(srv.command, "npx");
  assert.deepEqual(srv.args, ["-y", "@ourthinktank/founders-os@latest"]);
  assert.equal(srv.env.SUPABASE_URL, "https://abc.supabase.co");
  // No useLatest -> bare spec.
  assert.deepEqual(gen.buildMcpJson(ENV, {}).mcpServers["founders-os"].args, ["-y", "@ourthinktank/founders-os"]);
});

test("sqlForDimension substitutes every vector(1024)", () => {
  const out = gen.sqlForDimension("a vector(1024) b vector(1024)", 1536);
  assert.equal(out, "a vector(1536) b vector(1536)");
});

test("buildEnvFile emits KEY=value lines for the creds, skips empties", () => {
  const out = gen.buildEnvFile(ENV);
  assert.match(out, /^SUPABASE_URL=https:\/\/abc\.supabase\.co$/m);
  assert.match(out, /^SUPABASE_SECRET_KEY=sb_secret_xyz$/m);
  assert.match(out, /^FOUNDERS_OS_COMPANY_ID=ourthinktank$/m);
  assert.doesNotMatch(out, /FOUNDERS_OS_USER_ID=/); // not provided -> omitted
});

test("launchd plist points at the wrapper, not the bare CLI, and carries no secrets", () => {
  const plist = gen.buildLaunchdPlist({ wrapperPathUnix: "/Users/me/.local/bin/foundersos-tick.sh" });
  assert.match(plist, /<string>\/Users\/me\/\.local\/bin\/foundersos-tick\.sh<\/string>/);
  assert.doesNotMatch(plist, /founders-os-tick<\/string>\s*<string>detect/); // not the bare detect command
  assert.doesNotMatch(plist, /sb_secret/); // env file holds creds, not the unit
  assert.match(plist, /<key>Minute<\/key><integer>0<\/integer>/); // hourly default
});

test("systemd units: oneshot service runs the wrapper; timer cadence maps", () => {
  assert.match(gen.buildSystemdService({ wrapperPathUnix: "/opt/tick.sh" }), /ExecStart=\/opt\/tick\.sh/);
  assert.match(gen.buildSystemdService({}), /Type=oneshot/);
  assert.match(gen.buildSystemdTimer({}), /OnCalendar=hourly/);
  assert.match(gen.buildSystemdTimer({ cadence: "daily", dailyHour: 6 }), /OnCalendar=\*-\*-\* 06:00:00/);
});

test("cron + Task Scheduler point at the wrapper with the right cadence", () => {
  assert.match(gen.buildCronLine({ wrapperPathUnix: "~/.local/bin/foundersos-tick.sh" }), /^0 \* \* \* \* ~\/\.local\/bin\/foundersos-tick\.sh /);
  assert.match(gen.buildCronLine({ cadence: "daily", dailyHour: 6 }), /^0 6 \* \* \* /);
  const win = gen.buildTaskSchedulerCmd({ wrapperPathWin: "C:\\\\tools\\\\foundersos-tick.cmd" });
  assert.match(win, /schtasks \/Create .* \/TR "C:\\\\tools\\\\foundersos-tick\.cmd" \/SC HOURLY/);
  assert.match(gen.buildTaskSchedulerCmd({ cadence: "daily", dailyHour: 6 }), /\/SC DAILY \/ST 06:00/);
});

test("buildSchedulerBundle returns all six artifacts", () => {
  const b = gen.buildSchedulerBundle(ENV, {});
  for (const k of ["envFile", "launchd", "systemdService", "systemdTimer", "cron", "taskScheduler"]) {
    assert.ok(typeof b[k] === "string" && b[k].length > 0, `${k} present`);
  }
  assert.match(b.envFile, /SUPABASE_SECRET_KEY=sb_secret_xyz/);
});
