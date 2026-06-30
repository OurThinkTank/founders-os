// ============================================================
// Founders OS — Action Risk Classifier tests
// ============================================================
// Security-critical. These tests assert real classification behavior
// over RESOLVED action params, not just that the function returns. The
// exfiltration cases lead because mislabeling an exfiltrating action as
// benign is the worst failure this classifier can have.
// ============================================================

import { describe, it, expect } from "vitest";
import {
  classifyAction,
  canonicalActionString,
  maxTier,
  RED_TIERS,
  findEmails,
  findFinancialValues,
  findSensitivePlaceholders,
  findBlockedUrls,
  findBlockedHosts,
  type ProposedAction,
} from "../tools/playbooks/risk.js";

describe("risk classifier — exfiltration (leading)", () => {
  it("flags an external message carrying a real contact email as exfiltration", () => {
    const a: ProposedAction = {
      kind: "external",
      connector: "slack",
      action: "send_message",
      params: { channel: "#general", text: "Intro: reach Jane at jane.doe@acme.com" },
    };
    const r = classifyAction(a);
    expect(r.tier).toBe("exfiltration");
    expect(r.exfiltration).toBe(true);
    expect(r.emails).toContain("jane.doe@acme.com");
    expect(RED_TIERS.has(r.tier)).toBe(true);
  });

  it("flags a resolved secret value sent outbound as exfiltration", () => {
    const a: ProposedAction = {
      kind: "external",
      connector: "slack",
      action: "send_message",
      // {{memory:openai_key}} resolved to a real key before classify.
      params: { text: "here is the key sk-ABCDEF0123456789ABCDEF" },
    };
    const r = classifyAction(a);
    expect(r.tier).toBe("exfiltration");
    expect(r.secrets_found).toContain("openai_key");
  });

  it("flags a financial figure sent to an external tool as exfiltration", () => {
    const a: ProposedAction = {
      kind: "external",
      connector: "slack",
      action: "post_update",
      params: { text: "MRR hit $42,500.00 this month" },
    };
    const r = classifyAction(a);
    expect(r.tier).toBe("exfiltration");
    expect(r.financial_values.length).toBeGreaterThan(0);
  });

  it("flags an UNRESOLVED sensitive placeholder (defense in depth) as exfiltration", () => {
    const a: ProposedAction = {
      kind: "external",
      connector: "http",
      action: "post_webhook",
      params: { body: "secret={{memory:stripe_key}}" },
    };
    const r = classifyAction(a);
    expect(r.tier).toBe("exfiltration");
    expect(r.sensitive_placeholders.length).toBeGreaterThan(0);
  });

  it("does NOT treat a contact email in a NATIVE task as exfiltration", () => {
    const a: ProposedAction = {
      kind: "native",
      action: "create_task",
      params: { title: "Follow up with jane.doe@acme.com" },
    };
    const r = classifyAction(a);
    expect(r.exfiltration).toBe(false);
    expect(r.tier).toBe("native_create");
  });
});

describe("risk classifier — summary is display-only, not classified (review M4)", () => {
  it("a descriptive summary over benign params does NOT escalate to exfiltration", () => {
    // The unattended model authors this summary for its own action. The
    // prose mentions an email and a dollar figure, but the resolved params
    // carry neither. Before M4 the flattened summary tripped the email +
    // financial detectors and manufactured a red-tier exfiltration hold.
    const a: ProposedAction = {
      kind: "external",
      connector: "slack",
      action: "send_message",
      params: { channel: "#sales", text: "Renewal reminder sent." },
      summary: "Email the client jane.doe@acme.com about the $4,000 renewal",
    };
    const r = classifyAction(a);
    expect(r.tier).toBe("external_write");
    expect(r.exfiltration).toBe(false);
    expect(r.emails).toHaveLength(0);
    expect(r.financial_values).toHaveLength(0);
  });

  it("real sensitive data in PARAMS still escalates even with a bland summary", () => {
    // The fix narrows the scan to structured fields; it must not weaken
    // detection when the sensitive value is actually in the params.
    const a: ProposedAction = {
      kind: "external",
      connector: "slack",
      action: "send_message",
      params: { text: "reach jane.doe@acme.com" },
      summary: "Posting a routine note",
    };
    const r = classifyAction(a);
    expect(r.tier).toBe("exfiltration");
    expect(r.emails).toContain("jane.doe@acme.com");
  });

  it("an SSRF host mentioned only in the summary does NOT block the action", () => {
    const a: ProposedAction = {
      kind: "external",
      connector: "http",
      action: "post_webhook",
      params: { url: "https://hooks.example.com/abc", body: "ok" },
      summary: "Calls the internal service at 169.254.169.254 (per the runbook)",
    };
    const r = classifyAction(a);
    expect(r.blocks).toHaveLength(0);
  });
});

describe("risk classifier — tiers", () => {
  it("external read verb -> read", () => {
    const r = classifyAction({ kind: "external", connector: "stripe", action: "list_invoices" });
    expect(r.tier).toBe("read");
  });

  it("external write (non-destructive, no sensitive data) -> external_write", () => {
    const r = classifyAction({
      kind: "external",
      connector: "github",
      action: "create_issue",
      params: { title: "Bug", body: "Steps to reproduce" },
    });
    expect(r.tier).toBe("external_write");
    expect(r.exfiltration).toBe(false);
  });

  it("external destructive verb -> destructive", () => {
    const r = classifyAction({ kind: "external", connector: "stripe", action: "refund_charge" });
    expect(r.tier).toBe("destructive");
    expect(r.destructive).toBe(true);
    expect(RED_TIERS.has(r.tier)).toBe(true);
  });

  it("native create -> native_create", () => {
    const r = classifyAction({ kind: "native", action: "create_task", params: { title: "x" } });
    expect(r.tier).toBe("native_create");
  });

  it("native read -> read", () => {
    const r = classifyAction({ kind: "native", action: "list_tasks" });
    expect(r.tier).toBe("read");
  });

  it("native SOFT delete (reversible) stays native_create", () => {
    for (const action of ["remove_task", "delete_trigger", "remove_customer", "archive_project"]) {
      const r = classifyAction({ kind: "native", action, params: { id: "x" } });
      expect(r.tier, action).toBe("native_create");
      expect(r.destructive, action).toBe(false);
    }
  });

  it("native HARD purge (irreversible) -> destructive, held by the red floor", () => {
    for (const action of ["purge_item", "purge_items", "destroy_record", "truncate_table"]) {
      const r = classifyAction({ kind: "native", action, params: { id: "x" } });
      expect(r.tier, action).toBe("destructive");
      expect(r.destructive, action).toBe(true);
      expect(RED_TIERS.has(r.tier), action).toBe(true);
    }
  });

  it("destructive + sensitive data escalates to exfiltration (the worst signal wins)", () => {
    const r = classifyAction({
      kind: "external",
      connector: "slack",
      action: "delete_message",
      params: { note: "removing jane.doe@acme.com from the channel" },
    });
    expect(r.tier).toBe("exfiltration");
    expect(r.destructive).toBe(true);
    expect(r.exfiltration).toBe(true);
  });
});

describe("risk classifier — SSRF / URL guard (rejected regardless of tier)", () => {
  it("blocks a private/reserved URL in resolved params", () => {
    const r = classifyAction({
      kind: "external",
      connector: "http",
      action: "post_webhook",
      params: { url: "http://169.254.169.254/latest/meta-data/" },
    });
    expect(r.blocks.length).toBeGreaterThan(0);
    expect(r.blocks.some((b) => b.code === "private_url")).toBe(true);
  });

  it("blocks a non-http(s) scheme", () => {
    const r = classifyAction({
      kind: "external",
      connector: "http",
      action: "fetch",
      params: { url: "file:///etc/passwd" },
    });
    expect(r.blocks.some((b) => b.code === "private_url")).toBe(true);
  });

  it("blocks a bare private host split into a separate field", () => {
    const r = classifyAction({
      kind: "external",
      connector: "http",
      action: "post",
      params: { host: "10.0.0.5", path: "/internal" },
    });
    expect(r.blocks.some((b) => b.code === "private_host")).toBe(true);
  });

  it("allows a public https URL", () => {
    const r = classifyAction({
      kind: "external",
      connector: "http",
      action: "post_webhook",
      params: { url: "https://hooks.example.com/abc" },
    });
    expect(r.blocks).toHaveLength(0);
  });
});

describe("risk classifier — detectors are precise", () => {
  it("findEmails finds only real-looking addresses", () => {
    expect(findEmails("a@b.com and not-an-email and c.d@e.co")).toEqual([
      "a@b.com",
      "c.d@e.co",
    ]);
  });

  it("findFinancialValues ignores a bare number but catches symbol/code amounts", () => {
    expect(findFinancialValues("there were 5 widgets")).toHaveLength(0);
    expect(findFinancialValues("paid $1,200.50 today").length).toBeGreaterThan(0);
    expect(findFinancialValues("owed 900 USD").length).toBeGreaterThan(0);
  });

  it("findSensitivePlaceholders catches memory/email/secret placeholders", () => {
    expect(findSensitivePlaceholders("{{memory:k}}").length).toBe(1);
    expect(findSensitivePlaceholders("{{contact.primary.email}}").length).toBe(1);
    expect(findSensitivePlaceholders("hello {{first_name}}")).toHaveLength(0);
  });

  it("findBlockedUrls / findBlockedHosts catch private targets, pass public ones", () => {
    expect(findBlockedUrls("see http://127.0.0.1:9000/x").length).toBe(1);
    expect(findBlockedUrls("see https://example.com/x")).toHaveLength(0);
    expect(findBlockedHosts("connect to 192.168.1.1 now").length).toBe(1);
  });
});

describe("risk classifier — helpers", () => {
  it("maxTier returns the higher-severity tier", () => {
    expect(maxTier("read", "destructive")).toBe("destructive");
    expect(maxTier("exfiltration", "external_write")).toBe("exfiltration");
    expect(maxTier("native_create", "read")).toBe("native_create");
  });
});

describe("canonicalActionString — replay binding", () => {
  it("is stable across key order", () => {
    const a: ProposedAction = {
      kind: "external",
      connector: "slack",
      action: "send_message",
      params: { channel: "#x", text: "hi" },
    };
    const b: ProposedAction = {
      kind: "external",
      action: "send_message",
      connector: "slack",
      params: { text: "hi", channel: "#x" },
    };
    expect(canonicalActionString(a)).toBe(canonicalActionString(b));
  });

  it("changes when any resolved value changes", () => {
    const base: ProposedAction = {
      kind: "external",
      connector: "slack",
      action: "send_message",
      params: { channel: "#x", text: "hi" },
    };
    const tampered: ProposedAction = {
      ...base,
      params: { channel: "#x", text: "different body" },
    };
    expect(canonicalActionString(base)).not.toBe(canonicalActionString(tampered));
  });
});
