// ============================================================
// Founders OS - Blank env vars behave as unset
// ============================================================
// Regression suite for the MCPB packaging bug (P3).
//
// MCPB install dialogs substitute `${user_config.x}` with an EMPTY
// STRING when the user leaves an optional field blank. Before
// utils/env.ts existed, several reads used `process.env.X ?? DEFAULT`,
// and `??` only falls back on undefined, so "" reached the validators
// and the server THREW DURING STARTUP. A user who installed the
// bundle and filled in only the two required Supabase fields got a
// server that would not boot.
//
// Every env var mapped in packaging/mcpb/manifest.template.json is
// covered here. If you add a user_config field to that manifest, add
// a case to this file.
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readEnv, readEnvInt } from "../utils/env.js";
import {
  getUserId,
  getCompanyId,
  isSoloMode,
  isPlaceholderIdentity,
  DEFAULT_USER_ID,
  DEFAULT_COMPANY_ID,
} from "../utils/identity.js";
// Note: this release line is proactive-agents-free, so there is no
// readPrincipalFromEnv / readAgentModelConfigFromEnv to cover here. If those
// ever land on this line, add blank-value cases for FOUNDERSOS_PRINCIPAL and
// FOUNDERSOS_AGENT_* alongside the rest.
import { readEmbeddingConfigFromEnv } from "../context.js";
import { getLocalTimezone } from "../tools/dates.js";

// Every var the MCPB manifest maps into the server environment, plus the
// agent vars that share the same read helpers.
const MANAGED = [
  "FOUNDERS_OS_USER_ID",
  "FOUNDERS_OS_COMPANY_ID",
  "FOUNDERS_OS_TIMEZONE",
  "EMBEDDING_PROVIDER",
  "EMBEDDING_MODEL",
  "EMBEDDING_DIM",
  "EMBEDDING_RATE_LIMIT",
  "EMBEDDING_RATE_WINDOW",
  "OPENAI_API_KEY",
  "AWS_DEFAULT_REGION",
  "OLLAMA_BASE_URL",
] as const;

/** Set every managed var to the given value, or delete when undefined. */
function setAll(value: string | undefined): void {
  for (const key of MANAGED) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("readEnv - blank is unset", () => {
  const KEY = "FOUNDERS_OS_TEST_VAR";
  afterEach(() => {
    delete process.env[KEY];
  });

  it("returns undefined when the var is absent", () => {
    expect(readEnv(KEY)).toBeUndefined();
  });

  it("returns undefined for an empty string", () => {
    process.env[KEY] = "";
    expect(readEnv(KEY)).toBeUndefined();
  });

  it("returns undefined for whitespace only", () => {
    process.env[KEY] = "   ";
    expect(readEnv(KEY)).toBeUndefined();
  });

  it("trims surrounding whitespace from a real value", () => {
    process.env[KEY] = "  acme-co  ";
    expect(readEnv(KEY)).toBe("acme-co");
  });

  it("preserves a value that is already clean", () => {
    process.env[KEY] = "acme-co";
    expect(readEnv(KEY)).toBe("acme-co");
  });

  it("does not treat \"0\" or \"false\" as blank", () => {
    process.env[KEY] = "0";
    expect(readEnv(KEY)).toBe("0");
    process.env[KEY] = "false";
    expect(readEnv(KEY)).toBe("false");
  });
});

describe("readEnvInt - blank is unset, garbage throws", () => {
  const KEY = "FOUNDERS_OS_TEST_INT";
  afterEach(() => {
    delete process.env[KEY];
  });

  it("returns undefined when absent, empty, or whitespace", () => {
    expect(readEnvInt(KEY)).toBeUndefined();
    process.env[KEY] = "";
    expect(readEnvInt(KEY)).toBeUndefined();
    process.env[KEY] = "  ";
    expect(readEnvInt(KEY)).toBeUndefined();
  });

  it("parses a positive integer", () => {
    process.env[KEY] = "1536";
    expect(readEnvInt(KEY)).toBe(1536);
  });

  it("throws a named error on a non-numeric value", () => {
    process.env[KEY] = "lots";
    expect(() => readEnvInt(KEY)).toThrow(/FOUNDERS_OS_TEST_INT/);
  });

  it("throws on zero and on a negative value", () => {
    process.env[KEY] = "0";
    expect(() => readEnvInt(KEY)).toThrow();
    process.env[KEY] = "-1";
    expect(() => readEnvInt(KEY)).toThrow();
  });
});

describe("blank env vars do not break startup (MCPB install with optional fields left empty)", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of MANAGED) saved[key] = process.env[key];
    setAll(undefined);
  });

  afterEach(() => {
    for (const key of MANAGED) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key] as string;
    }
  });

  it("identity falls back to the placeholders instead of throwing", () => {
    setAll("");
    // Before the fix this threw: "" failed the safe-identifier regex.
    expect(() => getUserId()).not.toThrow();
    expect(getUserId()).toBe(DEFAULT_USER_ID);
    expect(getCompanyId()).toBe(DEFAULT_COMPANY_ID);
    expect(isSoloMode()).toBe(true);
    expect(isPlaceholderIdentity()).toBe(true);
  });

  it("identity treats whitespace-only the same as blank", () => {
    setAll("   ");
    expect(getUserId()).toBe(DEFAULT_USER_ID);
    expect(getCompanyId()).toBe(DEFAULT_COMPANY_ID);
  });

  it("embedding config falls back to the documented openai defaults", () => {
    setAll("");
    // Before the fix this threw: "" failed the provider whitelist.
    expect(() => readEmbeddingConfigFromEnv()).not.toThrow();
    const cfg = readEmbeddingConfigFromEnv();
    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("text-embedding-3-small");
    expect(cfg.dimensions).toBe(1536);
    expect(cfg.awsRegion).toBe("us-east-1");
    expect(cfg.ollamaBaseUrl).toBe("http://localhost:11434");
    expect(cfg.rateLimit.maxCalls).toBe(30);
    expect(cfg.rateLimit.windowMs).toBe(60_000);
  });

  it("a blank OPENAI_API_KEY reads as undefined, not as an empty key", () => {
    setAll("");
    // An "" key would be sent to the provider and fail with a confusing
    // 401 rather than the clear "no key configured" path.
    expect(readEmbeddingConfigFromEnv().openaiApiKey).toBeUndefined();
  });

  it("a blank provider still rejects a genuinely wrong provider", () => {
    setAll("");
    process.env.EMBEDDING_PROVIDER = "pinecone";
    expect(() => readEmbeddingConfigFromEnv()).toThrow(/EMBEDDING_PROVIDER/);
  });

  it("timezone falls back to auto-detection rather than an empty zone", () => {
    setAll("");
    const tz = getLocalTimezone();
    expect(tz).not.toBe("");
    // Must be a zone Intl actually accepts.
    expect(() =>
      new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date())
    ).not.toThrow();
  });




  it("real values still win over the defaults after trimming", () => {
    setAll("");
    process.env.FOUNDERS_OS_COMPANY_ID = "  acme-co  ";
    process.env.EMBEDDING_PROVIDER = "ollama";
    process.env.EMBEDDING_DIM = " 768 ";
    expect(getCompanyId()).toBe("acme-co");
    const cfg = readEmbeddingConfigFromEnv();
    expect(cfg.provider).toBe("ollama");
    expect(cfg.model).toBe("nomic-embed-text");
    expect(cfg.dimensions).toBe(768);
  });
});
