// ============================================================
// Diagnostic — semver precedence + channel-aware update check
// ============================================================
// Guards the version comparator behind get_version's updateAvailable
// signal. The bug this replaces: a plain `latest !== current` string
// check flagged a prerelease that is AHEAD of the stable `latest` tag
// (e.g. running 1.3.0-rc.2 while latest is 1.0.0) as an available
// "update", implying a downgrade.
// ============================================================

import { describe, it, expect } from "vitest";
import { parseSemver, compareSemver, isPrerelease } from "../tools/diagnostic.js";

describe("compareSemver — core precedence", () => {
  it("orders by major, then minor, then patch", () => {
    expect(compareSemver("2.0.0", "1.9.9")).toBe(1);
    expect(compareSemver("1.2.0", "1.1.9")).toBe(1);
    expect(compareSemver("1.1.2", "1.1.1")).toBe(1);
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
    expect(compareSemver("1.0.0", "2.0.0")).toBe(-1);
  });

  it("ignores a leading v and build metadata", () => {
    expect(compareSemver("v1.2.3", "1.2.3")).toBe(0);
    expect(compareSemver("1.2.3+build.9", "1.2.3+build.1")).toBe(0);
  });
});

describe("compareSemver — prerelease precedence (semver §11)", () => {
  it("a prerelease has lower precedence than its normal version", () => {
    expect(compareSemver("1.3.0-rc.2", "1.3.0")).toBe(-1);
    expect(compareSemver("1.3.0", "1.3.0-rc.2")).toBe(1);
  });

  it("compares numeric prerelease identifiers numerically", () => {
    expect(compareSemver("1.3.0-rc.2", "1.3.0-rc.1")).toBe(1);
    expect(compareSemver("1.3.0-rc.10", "1.3.0-rc.2")).toBe(1); // not string order
  });

  it("numeric identifiers rank below alphanumeric; more identifiers win", () => {
    expect(compareSemver("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
    expect(compareSemver("1.0.0-alpha.1", "1.0.0-alpha.beta")).toBe(-1);
    expect(compareSemver("1.0.0-1", "1.0.0-alpha")).toBe(-1);
  });
});

describe("compareSemver — the reported bug", () => {
  it("a prerelease AHEAD of stable latest is not 'behind' it", () => {
    // current = 1.3.0-rc.2, stable latest = 1.0.0 -> current is greater.
    expect(compareSemver("1.0.0", "1.3.0-rc.2")).toBe(-1); // latest < current
    expect(compareSemver("1.3.0-rc.2", "1.0.0")).toBe(1);
  });

  it("a newer prerelease on the same channel IS an update", () => {
    expect(compareSemver("1.3.0-rc.3", "1.3.0-rc.2")).toBe(1);
  });
});

describe("compareSemver — unparseable input", () => {
  it("returns null when either side is not X.Y.Z", () => {
    expect(compareSemver("latest", "1.0.0")).toBeNull();
    expect(compareSemver("1.0", "1.0.0")).toBeNull();
    expect(compareSemver("1.0.0", "not-a-version")).toBeNull();
  });
});

describe("parseSemver / isPrerelease", () => {
  it("splits core and prerelease identifiers", () => {
    expect(parseSemver("1.3.0-rc.2")).toEqual({ nums: [1, 3, 0], pre: ["rc", "2"] });
    expect(parseSemver("1.3.0")).toEqual({ nums: [1, 3, 0], pre: [] });
  });

  it("detects prerelease builds", () => {
    expect(isPrerelease("1.3.0-rc.2")).toBe(true);
    expect(isPrerelease("1.3.0")).toBe(false);
    expect(isPrerelease("garbage")).toBe(false);
  });
});
