// ============================================================
// Founders OS — Trigger dedup + connector spec (pure) tests
// ============================================================
// dedup is the difference between a watcher and an alarm everyone mutes,
// so it is tested directly: same situation no re-fire, worsening
// re-fires, changed match set re-fires, and source-independence (SQL
// rows vs reported rows produce the same fingerprint).
// ============================================================

import { describe, it, expect } from "vitest";
import { fingerprint, changed } from "../tools/triggers/dedup.js";
import { daysBucket } from "../tools/triggers/conditions.js";
import { buildConnectorCheck } from "../tools/triggers/connector.js";

describe("dedup.fingerprint", () => {
  it("is stable regardless of row order", () => {
    expect(fingerprint(["b", "a", "c"], "s")).toBe(fingerprint(["a", "b", "c"], "s"));
  });

  it("changes when the state field changes (worsening situation)", () => {
    expect(fingerprint(["a"], "b1")).not.toBe(fingerprint(["a"], "b2"));
  });

  it("changes when the row set changes", () => {
    expect(fingerprint(["a"], "s")).not.toBe(fingerprint(["a", "b"], "s"));
  });

  it("empty match set is distinct from any non-empty set (so re-matching re-fires)", () => {
    const empty = fingerprint([], "");
    expect(empty).not.toBe(fingerprint(["a"], ""));
  });

  it("is source-independent: SQL-derived ids and reported ids hash identically", () => {
    const fromSql = fingerprint(["inv_1", "inv_2"], "b3");
    const fromAgent = fingerprint(["inv_2", "inv_1"], "b3");
    expect(fromSql).toBe(fromAgent);
  });
});

describe("dedup.changed", () => {
  it("first-ever evaluation (null last_state) is a change", () => {
    expect(changed(null, fingerprint(["a"], "s"))).toBe(true);
  });
  it("same fingerprint is not a change", () => {
    const fp = fingerprint(["a"], "s");
    expect(changed(fp, fp)).toBe(false);
  });
  it("different fingerprint is a change", () => {
    expect(changed(fingerprint(["a"], "s"), fingerprint(["a"], "s2"))).toBe(true);
  });
});

describe("conditions.daysBucket boundaries", () => {
  it("crosses buckets as age grows", () => {
    expect(daysBucket(0)).toBe("b0");
    expect(daysBucket(2)).toBe("b0");
    expect(daysBucket(3)).toBe("b1");
    expect(daysBucket(7)).toBe("b2");
    expect(daysBucket(14)).toBe("b3");
    expect(daysBucket(30)).toBe("b4");
    expect(daysBucket(60)).toBe("b5");
  });
});

describe("connector.buildConnectorCheck", () => {
  it("builds an overdue_invoice check naming the connector and the report shape", () => {
    const c = buildConnectorCheck({
      id: "11111111-1111-1111-1111-111111111111",
      name: "Acme unpaid invoices",
      condition_type: "overdue_invoice",
      connector: "stripe",
      params: { days: 5 },
    });
    expect(c.connector).toBe("stripe");
    expect(c.query_spec.kind).toBe("unpaid_invoices_past_due");
    expect(c.query_spec.days).toBe(5);
    expect(c.instructions).toContain("report_trigger_observation");
  });

  it("builds a feed_keyword_match check against the internal feed reader", () => {
    const c = buildConnectorCheck({
      id: "22222222-2222-2222-2222-222222222222",
      name: "PR keywords",
      condition_type: "feed_keyword_match",
      connector: null,
      params: { keywords: ["acquisition", "lawsuit"] },
    });
    expect(c.connector).toBe("founders-os:feeds");
    expect(c.query_spec.keywords).toEqual(["acquisition", "lawsuit"]);
    expect(c.instructions).toContain("get_feed_items");
  });

  it("is connector-agnostic: uses whatever billing tool the user configured", () => {
    const c = buildConnectorCheck({
      id: "33333333-3333-3333-3333-333333333333",
      name: "Chargebee unpaid",
      condition_type: "overdue_invoice",
      connector: "chargebee", // not Stripe; Founders OS assumes no vendor
      params: { days: 2 },
    });
    expect(c.connector).toBe("chargebee");
    expect(c.instructions).toContain("chargebee");
  });

  it("refuses an overdue_invoice watch with no connector set (no vendor default)", () => {
    expect(() =>
      buildConnectorCheck({
        id: "44444444-4444-4444-4444-444444444444",
        name: "No tool",
        condition_type: "overdue_invoice",
        connector: null,
        params: { days: 1 },
      })
    ).toThrow(/no connector set/i);
  });

  it("throws on a condition_type with no connector builder", () => {
    expect(() =>
      buildConnectorCheck({
        id: "x", name: "bad", condition_type: "stuck_task", connector: "stripe", params: {},
      })
    ).toThrow(/no connector check builder/i);
  });
});
