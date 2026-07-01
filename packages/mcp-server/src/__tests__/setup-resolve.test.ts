// Tests for tick-bin resolution helpers. The spawn-based check is exercised
// against a command that is definitely present (node) and one that is not.

import { describe, it, expect } from "vitest";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { quoteArg, isNpxCachePath, localSelfInvocation, checkTickBinResolves } from "../setup/resolve.js";

describe("quoteArg", () => {
  it("quotes only when whitespace is present", () => {
    expect(quoteArg("founders-os-tick")).toBe("founders-os-tick");
    expect(quoteArg("/usr/bin/node")).toBe("/usr/bin/node");
    expect(quoteArg("C:\\Program Files\\node.exe")).toBe('"C:\\Program Files\\node.exe"');
  });
});

describe("isNpxCachePath", () => {
  it("detects an npx cache path (ephemeral)", () => {
    expect(isNpxCachePath("/home/u/.npm/_npx/abc123/node_modules/@ourthinktank/founders-os/dist/tick.js")).toBe(true);
    expect(isNpxCachePath("/opt/homebrew/lib/node_modules/@ourthinktank/founders-os/dist/tick.js")).toBe(false);
    expect(isNpxCachePath("/repo/founders-os/packages/mcp-server/dist/tick.js")).toBe(false);
  });
});

describe("localSelfInvocation", () => {
  it("returns a durable command for a real script, null for npx cache / missing", () => {
    const f = join(tmpdir(), `fos-self-${randomUUID()}.js`);
    writeFileSync(f, "// noop");
    try {
      expect(localSelfInvocation(f, "/usr/bin/node")).toBe(`/usr/bin/node ${f}`);
      expect(localSelfInvocation("/home/u/.npm/_npx/x/dist/tick.js", "/usr/bin/node")).toBeNull();
      expect(localSelfInvocation(join(tmpdir(), "does-not-exist.js"), "/usr/bin/node")).toBeNull();
      expect(localSelfInvocation("", "/usr/bin/node")).toBeNull();
    } finally {
      rmSync(f, { force: true });
    }
  });
});

describe("checkTickBinResolves", () => {
  it("resolves a present command and reads a version", () => {
    const r = checkTickBinResolves(process.execPath); // node --version
    expect(r.ok).toBe(true);
    expect(r.version).toBeTruthy();
  });

  it("reports a missing command as not resolved", () => {
    const r = checkTickBinResolves(`definitely-not-a-real-cmd-${randomUUID()}`);
    expect(r.ok).toBe(false);
  });
});
