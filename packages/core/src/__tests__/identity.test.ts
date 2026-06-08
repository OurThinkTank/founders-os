// ============================================================
// Founders OS - Identity helpers + placeholder nudge
// ============================================================
// Covers utils/identity.ts: env fallback to the memorable
// placeholders, the solo-mode sentinel, and the placeholder
// detection + nudge added 2026-05-30. These read process.env
// directly, so each test sets/restores the relevant vars.
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_USER_ID,
  DEFAULT_COMPANY_ID,
  getUserId,
  getCompanyId,
  isSoloMode,
  isPlaceholderIdentity,
  getPlaceholderIdentityHint,
} from "../utils/identity.js";

const USER = "FOUNDERS_OS_USER_ID";
const COMPANY = "FOUNDERS_OS_COMPANY_ID";

describe("identity — placeholder fallback + nudge", () => {
  let savedUser: string | undefined;
  let savedCompany: string | undefined;

  beforeEach(() => {
    savedUser = process.env[USER];
    savedCompany = process.env[COMPANY];
    delete process.env[USER];
    delete process.env[COMPANY];
  });

  afterEach(() => {
    if (savedUser === undefined) delete process.env[USER];
    else process.env[USER] = savedUser;
    if (savedCompany === undefined) delete process.env[COMPANY];
    else process.env[COMPANY] = savedCompany;
  });

  it("TC-ID01: unset env falls back to the memorable placeholders", () => {
    expect(getUserId()).toBe(DEFAULT_USER_ID);
    expect(getCompanyId()).toBe(DEFAULT_COMPANY_ID);
    expect(DEFAULT_USER_ID).toBe("foundersuser1");
    expect(DEFAULT_COMPANY_ID).toBe("myawesomecompany");
  });

  it("TC-ID02: placeholders are the solo-mode sentinel (both unset = solo)", () => {
    expect(isSoloMode()).toBe(true);
    expect(isPlaceholderIdentity()).toBe(true);
  });

  it("TC-ID03: fully configured identity is neither placeholder nor solo", () => {
    process.env[USER] = "alice";
    process.env[COMPANY] = "acme";
    expect(isSoloMode()).toBe(false);
    expect(isPlaceholderIdentity()).toBe(false);
    expect(getPlaceholderIdentityHint()).toBeNull();
  });

  it("TC-ID04: one configured, one placeholder = placeholder but NOT solo", () => {
    process.env[COMPANY] = "acme"; // user still placeholder
    expect(isSoloMode()).toBe(false);
    expect(isPlaceholderIdentity()).toBe(true);
    const hint = getPlaceholderIdentityHint();
    expect(hint).toContain(USER);
    expect(hint).not.toContain(COMPANY);
  });

  it("TC-ID05: nudge names both vars when both are placeholders", () => {
    const hint = getPlaceholderIdentityHint();
    expect(hint).toContain(USER);
    expect(hint).toContain(COMPANY);
  });

  it("TC-ID06: nudge names only the company var when only it is a placeholder", () => {
    process.env[USER] = "alice"; // company still placeholder
    const hint = getPlaceholderIdentityHint();
    expect(hint).toContain(COMPANY);
    expect(hint).not.toContain(USER);
  });
});
