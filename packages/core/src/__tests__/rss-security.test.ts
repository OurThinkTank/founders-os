// ============================================================
// Tests for src/tools/rss/fetcher.ts - validateFeedUrl (SSRF guard)
// ============================================================
import { describe, it, expect } from "vitest";
import { validateFeedUrl } from "../tools/rss/fetcher.js";

describe("validateFeedUrl — SSRF protection", () => {
  // ── Valid URLs should pass silently ─────────────────────────────────────

  it("TC-RSS01: accepts a standard https URL", () => {
    expect(() => validateFeedUrl("https://feeds.example.com/rss")).not.toThrow();
  });

  it("TC-RSS02: accepts a standard http URL", () => {
    expect(() => validateFeedUrl("http://blog.example.org/feed.xml")).not.toThrow();
  });

  it("TC-RSS03: accepts a URL with a path and query string", () => {
    expect(() =>
      validateFeedUrl("https://example.com/feed?format=rss&page=1")
    ).not.toThrow();
  });

  // ── Blocked protocols ────────────────────────────────────────────────────

  it("TC-RSS04: rejects file:// protocol", () => {
    expect(() => validateFeedUrl("file:///etc/passwd")).toThrow(/http or https/i);
  });

  it("TC-RSS05: rejects ftp:// protocol", () => {
    expect(() => validateFeedUrl("ftp://example.com/feed")).toThrow(/http or https/i);
  });

  it("TC-RSS06: rejects javascript: protocol", () => {
    expect(() => validateFeedUrl("javascript:alert(1)")).toThrow();
  });

  // ── Blocked private / reserved hostnames ────────────────────────────────

  it("TC-RSS07: rejects localhost", () => {
    expect(() => validateFeedUrl("http://localhost/feed")).toThrow(
      /private|reserved/i
    );
  });

  it("TC-RSS08: rejects 127.0.0.1 loopback", () => {
    expect(() => validateFeedUrl("http://127.0.0.1/feed")).toThrow(
      /private|reserved/i
    );
  });

  it("TC-RSS09: rejects 10.x.x.x RFC-1918 range", () => {
    expect(() => validateFeedUrl("http://10.0.0.1/internal")).toThrow(
      /private|reserved/i
    );
  });

  it("TC-RSS10: rejects 192.168.x.x RFC-1918 range", () => {
    expect(() => validateFeedUrl("http://192.168.1.1/feed")).toThrow(
      /private|reserved/i
    );
  });

  it("TC-RSS11: rejects 172.16.x.x RFC-1918 range", () => {
    expect(() => validateFeedUrl("http://172.16.0.1/feed")).toThrow(
      /private|reserved/i
    );
  });

  it("TC-RSS12: rejects 169.254.x.x link-local / AWS metadata", () => {
    expect(() =>
      validateFeedUrl("http://169.254.169.254/latest/meta-data/")
    ).toThrow(/private|reserved/i);
  });

  it("TC-RSS13: rejects GCP metadata endpoint", () => {
    expect(() =>
      validateFeedUrl("http://metadata.google.internal/computeMetadata/v1/")
    ).toThrow(/private|reserved/i);
  });

  // ── Blocked IPv6 private ranges (SSRF bypass vectors) ──────────────────
  // These were previously unblocked. The validator now explicitly covers
  // IPv4-mapped IPv6, unique-local (fc00::/7), and link-local (fe80::/10).

  it("TC-RSS16: rejects IPv4-mapped IPv6 loopback [::ffff:127.0.0.1]", () => {
    // Node normalises this to [::ffff:7f00:1]; the pattern covers [::ffff:*
    expect(() =>
      validateFeedUrl("http://[::ffff:127.0.0.1]/feed")
    ).toThrow(/private|reserved/i);
  });

  it("TC-RSS17: rejects IPv4-mapped IPv6 in hex form [::ffff:7f00:1]", () => {
    expect(() =>
      validateFeedUrl("http://[::ffff:7f00:1]/feed")
    ).toThrow(/private|reserved/i);
  });

  it("TC-RSS18: rejects IPv6 unique-local address [fc00::1]", () => {
    expect(() =>
      validateFeedUrl("http://[fc00::1]/feed")
    ).toThrow(/private|reserved/i);
  });

  it("TC-RSS19: rejects IPv6 unique-local fd00:: range (AWS ECS metadata variant)", () => {
    expect(() =>
      validateFeedUrl("http://[fd00:ec2::254]/feed")
    ).toThrow(/private|reserved/i);
  });

  it("TC-RSS20: rejects IPv6 link-local address [fe80::1]", () => {
    expect(() =>
      validateFeedUrl("http://[fe80::1]%eth0/feed")
    ).toThrow();
  });

  it("TC-RSS21: accepts a public IPv6 address (not private)", () => {
    // 2001:db8:: is the documentation range; used here to verify public IPv6 passes
    expect(() =>
      validateFeedUrl("https://[2001:db8::1]/rss")
    ).not.toThrow();
  });

  // ── Alternative IP encoding (Node normalises before we check) ───────────

  it("TC-RSS22: decimal-encoded 127.0.0.1 (http://2130706433/) is blocked after normalisation", () => {
    // Node's URL parser expands 2130706433 to 127.0.0.1 before we see it
    expect(() =>
      validateFeedUrl("http://2130706433/feed")
    ).toThrow(/private|reserved/i);
  });

  it("TC-RSS23: hex-encoded loopback (http://0x7f.0.0.1/) is blocked after normalisation", () => {
    expect(() =>
      validateFeedUrl("http://0x7f.0.0.1/feed")
    ).toThrow(/private|reserved/i);
  });

  it("TC-RSS24: short-form loopback (http://127.1/) is blocked after normalisation", () => {
    // Node expands 127.1 to 127.0.0.1
    expect(() =>
      validateFeedUrl("http://127.1/feed")
    ).toThrow(/private|reserved/i);
  });

  // ── Malformed URLs ───────────────────────────────────────────────────────

  it("TC-RSS25: rejects a completely invalid URL string", () => {
    expect(() => validateFeedUrl("not-a-url")).toThrow(/invalid/i);
  });

  it("TC-RSS26: rejects an empty string", () => {
    expect(() => validateFeedUrl("")).toThrow();
  });
});
