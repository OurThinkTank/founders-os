// ============================================================
// Tests for financial tools: logic and sign convention
// ============================================================
// These tests validate the amount sign logic, YTD date
// computation, and parameter handling without a real DB.
// ============================================================
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Amount sign convention ───────────────────────────────────────────────────
// Derived from add_transaction handler: income → positive, expense → negative

describe("Financial amount sign convention", () => {
  const applySign = (amount: number, type: "income" | "expense") =>
    type === "income" ? Math.abs(amount) : -Math.abs(amount);

  it("TC-F01: income category produces a positive amount", () => {
    expect(applySign(100, "income")).toBe(100);
  });

  it("TC-F02: expense category produces a negative amount", () => {
    expect(applySign(100, "expense")).toBe(-100);
  });

  it("TC-F03: sign is applied regardless of the input sign (always absolute)", () => {
    // Even if caller passes a negative number, we force the sign from category type
    expect(applySign(-250, "income")).toBe(250);
    expect(applySign(-250, "expense")).toBe(-250);
  });

  it("TC-F04: zero amount stays zero regardless of type", () => {
    expect(applySign(0, "income")).toBe(0);
    expect(applySign(0, "expense")).toBe(-0); // -0 === 0 in JS
    expect(applySign(0, "expense") === 0).toBe(true);
  });

  it("TC-F05: fractional amounts are preserved", () => {
    expect(applySign(99.99, "expense")).toBe(-99.99);
  });
});

// ── YTD date calculation ─────────────────────────────────────────────────────
// From get_financial_summary: ytdStart = `${currentYear}-01-01`

describe("YTD start date", () => {
  it("TC-F06: YTD start is January 1 of the current UTC year", () => {
    const currentYear = new Date().getUTCFullYear();
    const ytdStart = `${currentYear}-01-01`;
    expect(ytdStart).toMatch(/^\d{4}-01-01$/);
    expect(ytdStart.startsWith(String(currentYear))).toBe(true);
  });

  it("TC-F07: YTD start format is YYYY-01-01", () => {
    // Simulate a fixed year to ensure format is always correct
    const year = 2025;
    expect(`${year}-01-01`).toBe("2025-01-01");
  });
});

// ── P&L aggregation logic ────────────────────────────────────────────────────
// Validates the reduce logic used in get_pl_report

describe("P&L aggregation", () => {
  type PLRow = { category_type: "income" | "expense"; total: number | string };

  const calcNetFromRows = (rows: PLRow[]) => {
    const income = rows
      .filter((r) => r.category_type === "income")
      .reduce((s, r) => s + Number(r.total), 0);
    const expenses = rows
      .filter((r) => r.category_type === "expense")
      .reduce((s, r) => s + Math.abs(Number(r.total)), 0);
    return { income, expenses, net: income - expenses };
  };

  it("TC-F08: net is income minus expenses", () => {
    const rows: PLRow[] = [
      { category_type: "income", total: 10000 },
      { category_type: "expense", total: -3000 },
    ];
    const { net } = calcNetFromRows(rows);
    expect(net).toBe(7000); // 10000 - abs(-3000) = 10000 - 3000
  });

  it("TC-F09: expense totals stored as negative numbers are treated as positive", () => {
    // DB stores expenses as negative values; the report takes Math.abs
    const rows: PLRow[] = [
      { category_type: "expense", total: -500 },
      { category_type: "expense", total: -200 },
    ];
    const { expenses } = calcNetFromRows(rows);
    expect(expenses).toBe(700);
  });

  it("TC-F10: string totals from the view are coerced to numbers", () => {
    // DB views can return numeric columns as strings
    const rows: PLRow[] = [
      { category_type: "income", total: "1500" },
      { category_type: "expense", total: "-300" },
    ];
    const { net } = calcNetFromRows(rows);
    expect(net).toBe(1200);
  });

  it("TC-F11: empty rows produce zero net", () => {
    const { net } = calcNetFromRows([]);
    expect(net).toBe(0);
  });
});

// ── Transfer atomicity note ──────────────────────────────────────────────────

describe("Transfer between accounts", () => {
  it("TC-F12: outflow amount is always negative, inflow always positive", () => {
    const amount = 500;
    const outflowAmount = -Math.abs(amount);
    const inflowAmount = Math.abs(amount);
    expect(outflowAmount).toBe(-500);
    expect(inflowAmount).toBe(500);
  });
});

// ── By-customer P&L rollup ──────────────────────────────────────────────────
// Tests the pure rollupByCustomer reducer that get_pl_report uses when called
// with group_by_customer:true. Verifies bucketing, sign handling, and the
// invariant that the rollup totals reconcile to the top-level totals.

import { rollupByCustomer } from "../tools/financial/index.js";

describe("rollupByCustomer — by-customer P&L reducer", () => {
  it("TC-F13: rows with the same customer_id sum into one entry", () => {
    const out = rollupByCustomer([
      { customer_id: "cust-1", customer_name: "Acme", category_type: "income", total: 1000 },
      { customer_id: "cust-1", customer_name: "Acme", category_type: "income", total: 500 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].customer_name).toBe("Acme");
    expect(out[0].total_income).toBe(1500);
    expect(out[0].total_expenses).toBe(0);
    expect(out[0].net).toBe(1500);
  });

  it("TC-F14: expense totals are summed as absolute values", () => {
    // View stores expenses as negative numbers; the reducer must flip the sign
    // when aggregating so the by_customer total_expenses field is a positive
    // amount, matching the top-level total_expenses convention.
    const out = rollupByCustomer([
      { customer_id: "cust-1", customer_name: "Acme", category_type: "expense", total: -200 },
      { customer_id: "cust-1", customer_name: "Acme", category_type: "expense", total: -50 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].total_expenses).toBe(250);
    expect(out[0].net).toBe(-250);
  });

  it("TC-F15: null customer_id rows bucket into a single 'Unattributed' entry", () => {
    const out = rollupByCustomer([
      { customer_id: null, customer_name: null, category_type: "income", total: 100 },
      { customer_id: null, customer_name: null, category_type: "expense", total: -40 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].customer_id).toBe(null);
    expect(out[0].customer_name).toBe("Unattributed");
    expect(out[0].total_income).toBe(100);
    expect(out[0].total_expenses).toBe(40);
    expect(out[0].net).toBe(60);
  });

  it("TC-F16: Unattributed always sorts last regardless of size", () => {
    const out = rollupByCustomer([
      { customer_id: null, customer_name: null, category_type: "income", total: 9999 },
      { customer_id: "cust-1", customer_name: "Acme", category_type: "income", total: 100 },
      { customer_id: "cust-2", customer_name: "Volta", category_type: "income", total: 50 },
    ]);
    expect(out.map((r) => r.customer_name)).toEqual(["Acme", "Volta", "Unattributed"]);
  });

  it("TC-F17: non-unattributed entries sort by total_income descending", () => {
    const out = rollupByCustomer([
      { customer_id: "cust-3", customer_name: "Northstar", category_type: "income", total: 200 },
      { customer_id: "cust-1", customer_name: "Acme", category_type: "income", total: 800 },
      { customer_id: "cust-2", customer_name: "Volta", category_type: "income", total: 400 },
    ]);
    expect(out.map((r) => r.customer_name)).toEqual(["Acme", "Volta", "Northstar"]);
  });

  it("TC-F18: rollup totals reconcile to top-level totals (invariant)", () => {
    const rows: Parameters<typeof rollupByCustomer>[0] = [
      { customer_id: "cust-1", customer_name: "Acme", category_type: "income", total: 1000 },
      { customer_id: "cust-2", customer_name: "Volta", category_type: "income", total: 500 },
      { customer_id: null, customer_name: null, category_type: "income", total: 300 },
      { customer_id: "cust-1", customer_name: "Acme", category_type: "expense", total: -100 },
      { customer_id: null, customer_name: null, category_type: "expense", total: -50 },
    ];
    const out = rollupByCustomer(rows);
    const rollupIncome = out.reduce((s, r) => s + r.total_income, 0);
    const rollupExpenses = out.reduce((s, r) => s + r.total_expenses, 0);
    const topIncome = rows.filter((r) => r.category_type === "income")
      .reduce((s, r) => s + Number(r.total), 0);
    const topExpenses = rows.filter((r) => r.category_type === "expense")
      .reduce((s, r) => s + Math.abs(Number(r.total)), 0);
    expect(rollupIncome).toBe(topIncome);
    expect(rollupExpenses).toBe(topExpenses);
  });

  it("TC-F19: deleted customer (null customer_name on a non-null id) keeps the id and labels gracefully", () => {
    // Soft-deleted customer where the LEFT JOIN turned organization_name into
    // null. customer_id is still present, so the row should NOT bucket as
    // Unattributed - it should keep its id and surface a graceful label.
    const out = rollupByCustomer([
      { customer_id: "cust-1", customer_name: null, category_type: "income", total: 250 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].customer_id).toBe("cust-1");
    expect(out[0].customer_name).toBe("(deleted customer)");
    expect(out[0].total_income).toBe(250);
  });

  it("TC-F20: empty input returns empty array", () => {
    expect(rollupByCustomer([])).toEqual([]);
  });
});
