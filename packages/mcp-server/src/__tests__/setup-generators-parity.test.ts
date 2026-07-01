// Drift guard: the packaged TS generators must match the canonical browser
// generators (integrations/setup-page/lib/setup-generators.js) and the tick
// wrapper bodies must match integrations/scheduler/*, byte for byte. If either
// diverges, this fails — so the packaged copy can never silently drift.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import {
  buildLaunchdPlist,
  buildSystemdService,
  buildSystemdTimer,
  buildCronLine,
  buildTaskSchedulerCmd,
  WRAPPER_SH,
  WRAPPER_CMD,
  type SchedulerOpts,
} from "../setup/generators.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", ".."); // src/__tests__ -> repo root
const require = createRequire(import.meta.url);
const canonical = require(join(repoRoot, "integrations", "setup-page", "lib", "setup-generators.js"));

const OPT_CASES: Partial<SchedulerOpts>[] = [
  { wrapperPathUnix: "/home/me/.config/founders-os/foundersos-tick.sh", logPath: "/tmp/t.log", cadence: "hourly" },
  { wrapperPathUnix: "/home/me/.config/founders-os/foundersos-tick.sh", logPath: "/tmp/t.log", cadence: "daily", dailyHour: 6 },
  { wrapperPathWin: "C:\\x\\foundersos-tick.cmd", cadence: "daily", dailyHour: 9 },
];

describe("packaged generators match the canonical JS", () => {
  for (const opts of OPT_CASES) {
    it(`launchd matches for ${JSON.stringify(opts)}`, () => {
      expect(buildLaunchdPlist(opts)).toBe(canonical.buildLaunchdPlist(opts));
    });
    it(`systemd service+timer match for ${JSON.stringify(opts)}`, () => {
      expect(buildSystemdService(opts)).toBe(canonical.buildSystemdService(opts));
      expect(buildSystemdTimer(opts)).toBe(canonical.buildSystemdTimer(opts));
    });
    it(`cron matches for ${JSON.stringify(opts)}`, () => {
      expect(buildCronLine(opts)).toBe(canonical.buildCronLine(opts));
    });
    it(`task scheduler matches for ${JSON.stringify(opts)}`, () => {
      expect(buildTaskSchedulerCmd(opts)).toBe(canonical.buildTaskSchedulerCmd(opts));
    });
  }
});

describe("packaged wrapper bodies match the canonical scheduler files", () => {
  it("foundersos-tick.sh", () => {
    const disk = readFileSync(join(repoRoot, "integrations", "scheduler", "foundersos-tick.sh"), "utf-8");
    expect(WRAPPER_SH).toBe(disk);
  });
  it("foundersos-tick.cmd", () => {
    const disk = readFileSync(join(repoRoot, "integrations", "scheduler", "foundersos-tick.cmd"), "utf-8");
    expect(WRAPPER_CMD).toBe(disk);
  });
});
