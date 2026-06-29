// ============================================================
// Founders OS — Governance policy tests (pure logic)
// ============================================================
// resolveOutcome and validateTierOutcomes are the rules the whole gate
// hangs on, so they are tested directly: the red-tier floor, dry-run
// hold-all, the pause kill switch, and set_policy refusing to lower a
// red tier.
// ============================================================

import { describe, it, expect } from "vitest";
import {
  resolveOutcome,
  validateTierOutcomes,
  DEFAULT_TIER_OUTCOMES,
  type GuardrailPolicy,
} from "../tools/governance/policy.js";

function policy(overrides: Partial<GuardrailPolicy> = {}): GuardrailPolicy {
  return {
    company_id: "default",
    tier_outcomes: { ...DEFAULT_TIER_OUTCOMES },
    dry_run: false,
    paused: false,
    ...overrides,
  };
}

describe("resolveOutcome — normal mapping", () => {
  it("maps each tier to its default outcome", () => {
    const p = policy();
    expect(resolveOutcome(p, "read")).toBe("allow");
    expect(resolveOutcome(p, "native_create")).toBe("allow_with_log");
    expect(resolveOutcome(p, "external_write")).toBe("hold_for_approval");
    expect(resolveOutcome(p, "destructive")).toBe("hold_for_approval");
    expect(resolveOutcome(p, "exfiltration")).toBe("hold_for_approval");
  });
});

describe("resolveOutcome — red-tier floor (read-time defense)", () => {
  it("forces hold even if a row tried to lower a red tier", () => {
    const p = policy({
      tier_outcomes: {
        ...DEFAULT_TIER_OUTCOMES,
        destructive: "allow" as never,
        exfiltration: "allow_with_log" as never,
      },
    });
    expect(resolveOutcome(p, "destructive")).toBe("hold_for_approval");
    expect(resolveOutcome(p, "exfiltration")).toBe("hold_for_approval");
  });
});

describe("resolveOutcome — dry_run forces hold-all", () => {
  it("holds even the normally-allowed tiers", () => {
    const p = policy({ dry_run: true });
    expect(resolveOutcome(p, "read")).toBe("hold_for_approval");
    expect(resolveOutcome(p, "native_create")).toBe("hold_for_approval");
    expect(resolveOutcome(p, "external_write")).toBe("hold_for_approval");
  });
});

describe("resolveOutcome — paused kill switch wins over everything", () => {
  it("returns paused for every tier, even read, and even under dry_run", () => {
    const p = policy({ paused: true, dry_run: true });
    expect(resolveOutcome(p, "read")).toBe("paused");
    expect(resolveOutcome(p, "destructive")).toBe("paused");
  });
});

describe("validateTierOutcomes — write-time guard", () => {
  it("accepts lowering a non-red tier", () => {
    const out = validateTierOutcomes({ external_write: "allow_with_log" });
    expect(out.external_write).toBe("allow_with_log");
    // unspecified tiers keep defaults
    expect(out.read).toBe("allow");
  });

  it("refuses to lower destructive below hold_for_approval", () => {
    expect(() => validateTierOutcomes({ destructive: "allow" })).toThrow(
      /cannot be lowered/i
    );
  });

  it("refuses to lower exfiltration", () => {
    expect(() => validateTierOutcomes({ exfiltration: "allow_with_log" })).toThrow(
      /cannot be lowered/i
    );
  });

  it("allows setting a red tier explicitly to hold_for_approval", () => {
    const out = validateTierOutcomes({ destructive: "hold_for_approval" });
    expect(out.destructive).toBe("hold_for_approval");
  });

  it("rejects an unknown tier and an unknown outcome", () => {
    expect(() => validateTierOutcomes({ bogus_tier: "allow" })).toThrow(/Unknown risk tier/i);
    expect(() => validateTierOutcomes({ read: "yolo" })).toThrow(/Invalid outcome/i);
  });
});
