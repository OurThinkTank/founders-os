// ============================================================
// Tests for Playbook sharing: portable format, canonical hashing,
// the import confirm-token handshake, and the security-critical
// risk classifier (destructive / exfiltration / SSRF / secrets).
// No DB required — share.ts is pure.
// ============================================================
import { describe, it, expect } from "vitest";
import {
  classifyStep,
  assessPlaybook,
  buildPortablePlaybook,
  buildExportDocument,
  parseImportDocument,
  contentHash,
  deriveConfirmToken,
  findSensitivePlaceholders,
  scanSecrets,
  findBlockedUrls,
  findBlockedHosts,
  buildPreviewRender,
  MAX_DOCUMENT_BYTES,
  PLAYBOOK_FORMAT,
  PLAYBOOK_FORMAT_VERSION,
  type PortablePlaybook,
  type PortableStep,
} from "../tools/playbooks/share.js";

const nativeStep = (over: Partial<PortableStep> = {}): PortableStep => ({
  order_index: 0,
  type: "native_task",
  title: "Kickoff call with {{customer.name}}",
  ...over,
});

const externalStep = (over: Partial<PortableStep> = {}): PortableStep => ({
  order_index: 1,
  type: "external_action",
  title: "Do a thing",
  connector: "github",
  action: "create_repo",
  params: { name: "{{customer.slug}}-web", private: true },
  ...over,
});

// ── classifyStep: tiers ───────────────────────────────────

describe("classifyStep - risk tiers", () => {
  it("SH01: native_task is native_create", () => {
    expect(classifyStep(nativeStep()).tier).toBe("native_create");
  });

  it("SH02: external read action is read tier", () => {
    const s = classifyStep(externalStep({ action: "list_repos", params: {} }));
    expect(s.tier).toBe("read");
  });

  it("SH03: external create action is external_write", () => {
    const s = classifyStep(externalStep({ action: "create_repo", params: { name: "x" } }));
    expect(s.tier).toBe("external_write");
    expect(s.destructive).toBe(false);
  });

  it("SH04: destructive verb is destructive tier", () => {
    const s = classifyStep(externalStep({ action: "delete_repo", params: { name: "x" } }));
    expect(s.tier).toBe("destructive");
    expect(s.destructive).toBe(true);
  });

  it("SH05: archive/remove/purge all classify destructive", () => {
    for (const action of ["archive_channel", "remove_member", "purge_data", "revoke_token"]) {
      expect(classifyStep(externalStep({ action })).tier).toBe("destructive");
    }
  });
});

// ── classifyStep: exfiltration (the subtle one) ────────────

describe("classifyStep - exfiltration", () => {
  it("SH06: external action templating {{memory:*}} is exfiltration, not just write", () => {
    const s = classifyStep(
      externalStep({
        action: "send_email",
        params: { to: "ext@x.com", body: "Key is {{memory:stripe_key}}" },
      })
    );
    expect(s.tier).toBe("exfiltration");
    expect(s.exfiltration).toBe(true);
    expect(s.sensitive_placeholders.length).toBeGreaterThan(0);
  });

  it("SH07: a contact email placeholder in an external action is exfiltration", () => {
    const s = classifyStep(
      externalStep({ action: "post_message", params: { text: "{{contact.primary.email}}" } })
    );
    expect(s.tier).toBe("exfiltration");
  });

  it("SH08: a sensitive placeholder in a NATIVE task is NOT exfiltration (stays in Founders OS)", () => {
    const s = classifyStep(
      nativeStep({ title: "Note key {{memory:stripe_key}}", type: "native_task" })
    );
    expect(s.tier).toBe("native_create");
    expect(s.exfiltration).toBe(false);
  });

  it("SH09: a benign external_write with a non-sensitive placeholder stays external_write", () => {
    const s = classifyStep(
      externalStep({ action: "create_repo", params: { name: "{{customer.slug}}-web" } })
    );
    expect(s.tier).toBe("external_write");
  });
});

// ── SSRF + secrets ─────────────────────────────────────────

describe("URL + secret scanning", () => {
  it("SH10: private/metadata URLs are flagged blocked", () => {
    expect(findBlockedUrls("ping http://169.254.169.254/latest/meta-data").length).toBe(1);
    expect(findBlockedUrls("see http://localhost:8080/x").length).toBe(1);
    expect(findBlockedUrls("call http://192.168.1.1/admin").length).toBe(1);
  });

  it("SH11: public URLs are not blocked", () => {
    expect(findBlockedUrls("https://api.github.com/repos").length).toBe(0);
  });

  it("SH12: secret patterns are detected", () => {
    expect(scanSecrets("token sk-ABCDEFGHIJKLMNOPQRSTUVWX")).toContain("openai_key");
    expect(scanSecrets("AKIAIOSFODNN7EXAMPLE")).toContain("aws_access_key_id");
    expect(scanSecrets("-----BEGIN PRIVATE KEY-----")).toContain("private_key_block");
  });

  it("SH13: sensitive placeholders detected across forms", () => {
    expect(findSensitivePlaceholders("{{memory:foo}}").length).toBe(1);
    expect(findSensitivePlaceholders("{{contact.primary.email}}").length).toBe(1);
    expect(findSensitivePlaceholders("{{customer.name}}").length).toBe(0);
  });
});

// ── assessPlaybook: blocking + severity ────────────────────

describe("assessPlaybook", () => {
  const pb = (steps: PortableStep[]): PortablePlaybook => ({
    name: "P",
    slug: "p",
    description: null,
    steps,
  });

  it("SH14: max_severity is the highest step tier", () => {
    const a = assessPlaybook(pb([nativeStep(), externalStep({ action: "delete_repo" })]));
    expect(a.max_severity).toBe("destructive");
  });

  it("SH15: private URL produces a blocking issue", () => {
    const a = assessPlaybook(
      pb([externalStep({ action: "post", params: { url: "http://127.0.0.1/x" } })])
    );
    expect(a.blocking_issues.some((b) => b.code === "private_url")).toBe(true);
  });

  it("SH16: embedded secret produces a blocking issue", () => {
    const a = assessPlaybook(
      pb([nativeStep({ description: "key sk-ABCDEFGHIJKLMNOPQRSTUVWX" })])
    );
    expect(a.blocking_issues.some((b) => b.code === "embedded_secret")).toBe(true);
  });

  it("SH17: red_flag_steps includes destructive and exfiltration steps", () => {
    const a = assessPlaybook(
      pb([
        nativeStep(),
        externalStep({ action: "delete_repo" }),
        externalStep({ order_index: 2, action: "send_email", params: { body: "{{memory:k}}" } }),
      ])
    );
    expect(a.red_flag_steps.length).toBe(2);
  });

  it("SH18: a clean playbook has no blocking issues and read/native severity", () => {
    const a = assessPlaybook(pb([nativeStep(), externalStep({ action: "create_repo", params: { name: "x" } })]));
    expect(a.blocking_issues).toHaveLength(0);
    expect(a.max_severity).toBe("external_write");
  });
});

// ── Export: id stripping + placeholder preservation ────────

describe("buildPortablePlaybook / buildExportDocument", () => {
  it("SH19: strips ids/company_id and preserves placeholders", () => {
    const portable = buildPortablePlaybook(
      { name: "New Web", slug: "new-web", description: "desc" },
      [
        {
          order_index: 0,
          type: "external_action",
          title: "Repo for {{customer.name}}",
          description: null,
          assignee: "@me",
          due_offset: 2,
          priority: "high",
          connector: "github",
          action: "create_repo",
          params: { name: "{{customer.slug}}-web" },
          fallback_task: "do it by hand",
        },
      ]
    );
    const json = JSON.stringify(portable);
    expect(json).not.toContain("company_id");
    expect(json).not.toContain('"id"');
    expect(json).toContain("{{customer.name}}");
    expect(json).toContain("{{customer.slug}}-web");
    // assignee column maps to assigned_to in the portable shape
    expect(portable.steps[0].assigned_to).toBe("@me");
  });

  it("SH20: export document carries the correct format identity and a content hash", () => {
    const doc = buildExportDocument({ name: "P", slug: "p", description: null }, []);
    expect(doc.format).toBe(PLAYBOOK_FORMAT);
    expect(doc.format_version).toBe(PLAYBOOK_FORMAT_VERSION);
    expect(doc.provenance.content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

// ── Hashing + confirm token ────────────────────────────────

describe("contentHash + deriveConfirmToken", () => {
  const a: PortablePlaybook = {
    name: "P",
    slug: "p",
    description: null,
    steps: [externalStep()],
  };

  it("SH21: hash is stable regardless of key order", () => {
    const reordered: PortablePlaybook = {
      steps: [externalStep()],
      slug: "p",
      description: null,
      name: "P",
    } as PortablePlaybook;
    expect(contentHash(a)).toBe(contentHash(reordered));
  });

  it("SH22: hash changes when a value changes", () => {
    const b: PortablePlaybook = { ...a, name: "Different" };
    expect(contentHash(a)).not.toBe(contentHash(b));
  });

  it("SH23: confirm token is derived from but not equal to the hash", () => {
    const h = contentHash(a);
    const token = deriveConfirmToken(h);
    expect(token).not.toBe(h);
    expect(token).toBe(deriveConfirmToken(h)); // deterministic
  });
});

// ── Import parsing: trust boundary ─────────────────────────

describe("parseImportDocument", () => {
  const goodDoc = {
    format: PLAYBOOK_FORMAT,
    format_version: "1.0",
    playbook: {
      name: "P",
      slug: "p",
      steps: [{ order_index: 0, type: "native_task", title: "t" }],
    },
  };

  it("SH24: accepts a valid document (string or object)", () => {
    expect(parseImportDocument(goodDoc).playbook.name).toBe("P");
    expect(parseImportDocument(JSON.stringify(goodDoc)).playbook.slug).toBe("p");
  });

  it("SH25: rejects a non-playbook document", () => {
    expect(() => parseImportDocument({ format: "something/else", format_version: "1.0", playbook: {} } as never)).toThrow();
  });

  it("SH26: rejects invalid JSON string", () => {
    expect(() => parseImportDocument("{not json")).toThrow(/valid JSON/);
  });

  it("SH27: rejects an incompatible major format version", () => {
    expect(() =>
      parseImportDocument({ ...goodDoc, format_version: "2.0" })
    ).toThrow(/format_version/);
  });

  it("SH28: strips smuggled ids / company_id from the document", () => {
    const malicious = {
      ...goodDoc,
      playbook: {
        name: "P",
        slug: "p",
        company_id: "victim-tenant",
        id: "11111111-1111-1111-1111-111111111111",
        steps: [
          {
            order_index: 0,
            type: "native_task",
            title: "t",
            id: "step-id",
            playbook_id: "pb-id",
          },
        ],
      },
    };
    const parsed = parseImportDocument(malicious as never);
    const json = JSON.stringify(parsed.playbook);
    expect(json).not.toContain("victim-tenant");
    expect(json).not.toContain("playbook_id");
    expect(json).not.toContain("step-id");
  });

  it("SH29: round-trips an exported document through import", () => {
    const doc = buildExportDocument(
      { name: "Round Trip", slug: "round-trip", description: "d" },
      [
        {
          order_index: 0,
          type: "external_action",
          title: "Create {{customer.slug}} repo",
          description: null,
          assignee: null,
          due_offset: null,
          priority: "medium",
          connector: "github",
          action: "create_repo",
          params: { name: "{{customer.slug}}" },
          fallback_task: null,
        },
      ]
    );
    const parsed = parseImportDocument(JSON.stringify(doc));
    expect(parsed.playbook.name).toBe("Round Trip");
    expect(parsed.playbook.steps[0].params).toEqual({ name: "{{customer.slug}}" });
    // The hash of the parsed playbook matches what export recorded.
    expect(contentHash(parsed.playbook)).toBe(doc.provenance.content_hash);
  });
});

// ── Security regression: hardening from the pressure-test pass ──

describe("regression - SSRF encoded/numeric hosts are normalized + caught", () => {
  it("SH30: decimal/hex/octal-encoded loopback URLs are blocked (WHATWG normalization)", () => {
    expect(findBlockedUrls("http://2130706433/x").length).toBe(1); // 127.0.0.1
    expect(findBlockedUrls("http://0x7f000001/x").length).toBe(1);
    expect(findBlockedUrls("http://0177.0.0.1/x").length).toBe(1);
  });

  it("SH31: a bare private host in a non-URL param field is now flagged", () => {
    const s = classifyStep(
      externalStep({ action: "post", params: { host: "169.254.169.254", path: "/latest/meta-data" } })
    );
    expect(s.blocked_hosts.length).toBeGreaterThan(0);
  });

  it("SH32: bare private hosts produce a private_host blocking issue", () => {
    const a = assessPlaybook({
      name: "P",
      slug: "p",
      description: null,
      steps: [externalStep({ action: "post", params: { target: "10.0.0.5" } })],
    });
    expect(a.blocking_issues.some((b) => b.code === "private_host")).toBe(true);
  });

  it("SH33: findBlockedHosts ignores public IP-like values", () => {
    expect(findBlockedHosts("call 8.8.8.8 and 172.15.0.1 and 172.32.0.1")).toHaveLength(0);
  });
});

describe("regression - expanded destructive verbs", () => {
  for (const action of ["reset_account", "overwrite_config", "clear_all", "flush_cache", "deprovision_env", "teardown_stack", "rollback_release"]) {
    it(`SH34 (${action}): classified destructive`, () => {
      const s = classifyStep(externalStep({ action, params: {} }));
      expect(s.tier).toBe("destructive");
      expect(s.destructive).toBe(true);
    });
  }

  it("SH35: common benign verbs (merge) are NOT flagged destructive", () => {
    expect(classifyStep(externalStep({ action: "merge_pull_request", params: {} })).tier).toBe("external_write");
  });
});

describe("regression - DoS guards", () => {
  it("SH36: object input cannot bypass the size cap", () => {
    const big = "A".repeat(MAX_DOCUMENT_BYTES + 1024);
    const doc = {
      format: PLAYBOOK_FORMAT,
      format_version: "1.0",
      playbook: { name: "n", slug: "s", steps: [{ order_index: 0, type: "native_task", title: big }] },
    };
    expect(() => parseImportDocument(doc as never)).toThrow(/too large/);
  });

  it("SH37: deeply nested params throw a clean error instead of overflowing the stack", () => {
    let obj: Record<string, unknown> = {};
    let cur = obj;
    for (let i = 0; i < 20000; i++) {
      const n = {};
      cur.a = n;
      cur = n as Record<string, unknown>;
    }
    const pb: PortablePlaybook = {
      name: "n",
      slug: "s",
      description: null,
      steps: [externalStep({ params: obj })],
    };
    expect(() => contentHash(pb)).toThrow(/nested too deeply/);
  });
});

describe("regression - preview render neutralizes untrusted text", () => {
  it("SH38: markdown/link control chars in a step title are stripped from the fallback", () => {
    const a = assessPlaybook({
      name: "P",
      slug: "p",
      description: null,
      steps: [externalStep({ action: "delete_repo", title: "[pwn](http://evil.test) `code` ![x](http://track)" })],
    });
    const md = buildPreviewRender(a).tier_3?.markdown ?? "";
    expect(md).not.toContain("](http://evil.test)");
    expect(md).not.toContain("![x]");
  });

  it("SH39: render carries an untrusted-data guardrail", () => {
    const a = assessPlaybook({ name: "P", slug: "p", description: null, steps: [nativeStep()] });
    const r = buildPreviewRender(a);
    expect((r.do_not ?? []).some((d) => /untrusted/i.test(d))).toBe(true);
  });
});
