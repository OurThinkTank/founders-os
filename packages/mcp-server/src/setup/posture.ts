// ============================================================
// Founders OS — the auto-dispatch posture ladder (S6.2)
// ============================================================
// Full auto-dispatch is not one switch, it's a ladder of three postures a
// founder climbs deliberately. The machinery underneath (schedule run-mode,
// the company external_write tier, a connected channel, the model runner) is
// spread across independent switches, which is exactly why a non-technical
// user can lose the thread. This module is the SINGLE source of truth that
// turns those raw signals into one plain-language answer to four questions,
// reused verbatim by `doctor`, `init`, and `autosend`:
//
//   WHAT am I doing right now?        -> the current rung + its blurb
//   WHY would I move up?              -> nextStep.why
//   HOW do I proceed?                 -> nextStep.how (an exact command)
//   Is it working CORRECTLY?          -> healthy + blockers (with fixes)
//
// The three rungs:
//   1. Preparing        - schedule stages what needs you; nothing sends, no model.
//   2. Triaging         - a model prepares replies but sends nothing; all waits.
//   3. Sending routine  - low-risk messages send on their own; sensitive still waits.
// (Rung 0 = not set up yet.)
// ============================================================

import type { SdkCheck } from "./sdk.js";

export type ScheduleMode = "execute" | "hold-only" | "none";
export type Rung = 0 | 1 | 2 | 3;

export interface RungInfo {
  rung: Rung;
  title: string;
  blurb: string; // plain-language "what this posture does"
}

// The rungs a founder can be on, in order. Kept plain and jargon-free.
export const RUNGS: RungInfo[] = [
  { rung: 1, title: "Preparing", blurb: "Checks your watches on a schedule and sets aside anything that needs you. Nothing is sent." },
  { rung: 2, title: "Triaging", blurb: "A model reviews each item and prepares replies, but still sends nothing; everything waits for your approval." },
  { rung: 3, title: "Sending routine items", blurb: "Low-risk messages send on their own and are recorded. Anything sensitive (a contact email, a secret, a dollar amount) still waits for you." },
];

export interface NextStep {
  toTitle: string; // the rung you'd move to
  why: string; // WHY a founder would want it
  how: string; // the exact command(s) to get there
}

export interface Posture {
  rung: Rung;
  title: string; // current rung's name ("Not set up" at rung 0)
  doing: string; // WHAT is happening right now, one sentence
  ladder: (RungInfo & { current: boolean })[]; // all rungs, current marked
  healthy: boolean; // the current posture is working as intended
  blockers: string[]; // what's stopping it from working correctly, each with a fix
  nextStep?: NextStep; // how/why to climb; absent at the top rung
  tierKnown: boolean; // false when the send policy couldn't be read
}

export interface PostureInput {
  scheduleRegistered: boolean; // the OS actually has a job registered
  scheduleMode: ScheduleMode; // what the installed wrapper runs
  autosendOn: boolean; // company external_write tier allows sending
  tierKnown: boolean; // could we read the policy? (creds present)
  connectorConfigured: boolean; // a channel (Slack) is wired for the runner
  sdk: SdkCheck; // model engine + API key readiness
  paused: boolean; // company-wide kill switch
}

const CONNECT_CMD = "founders-os-tick connect slack";
const AUTOSEND_ON = "founders-os-tick autosend slack --on";

/** Turn the raw signals into the one plain-language posture. Pure. */
export function computePosture(i: PostureInput): Posture {
  const rung: Rung = !i.scheduleRegistered || i.scheduleMode === "none" ? 0 : i.scheduleMode === "hold-only" ? 1 : i.autosendOn ? 3 : 2;

  const title = rung === 0 ? "Not set up" : RUNGS[rung - 1].title;
  const doing =
    rung === 0
      ? "No automatic checks are running yet."
      : rung === 2 && !i.tierKnown
        ? "A model reviews each item and prepares replies. (I couldn't read your send setting, so I can't tell if routine items would send; check your credentials.)"
        : RUNGS[rung - 1].blurb;

  const ladder = RUNGS.map((r) => ({ ...r, current: r.rung === rung }));

  // ── What's stopping the CURRENT posture from working correctly ──
  const blockers: string[] = [];
  if (i.paused) {
    blockers.push("Everything is paused right now: a company-wide stop switch is on. Nothing runs until it's turned off.");
  }
  if (rung >= 2) {
    // A model runs at rungs 2 and 3.
    if (!i.sdk.sdkInstalled) blockers.push("The engine that runs the model didn't load; your install looks incomplete. Reinstall: npm i -g @ourthinktank/founders-os");
    if (!i.sdk.apiKey) blockers.push(`No model key found (${i.sdk.apiKeyVar}). Add it to the tick env file so the model can run.`);
  }
  if (rung === 3 && !i.connectorConfigured) {
    blockers.push(`No channel is connected, so there's nowhere to send. Connect one: ${CONNECT_CMD}`);
  }
  // Tier is ahead of the schedule: sending is allowed but the wrapper only prepares.
  if (rung === 1 && i.autosendOn && i.tierKnown) {
    blockers.push(`You've allowed sending, but the schedule only prepares, so nothing sends yet. Upgrade it: ${AUTOSEND_ON}`);
  }

  const healthy = blockers.length === 0;

  // ── How/why to climb to the next rung ──
  let nextStep: NextStep | undefined;
  if (rung === 0) {
    nextStep = { toTitle: "Preparing", why: "Start checking your watches automatically and set aside anything that needs you.", how: "founders-os-tick init" };
  } else if (rung === 1) {
    nextStep = { toTitle: "Triaging", why: "Let a model prepare your replies for you. It still won't send anything.", how: "founders-os-tick init --execute" };
  } else if (rung === 2) {
    nextStep = {
      toTitle: "Sending routine items",
      why: "Let routine, low-risk messages send on their own. Sensitive ones (a contact email, a secret, a dollar amount) still wait for you.",
      how: i.connectorConfigured ? AUTOSEND_ON : `${CONNECT_CMD}, then: ${AUTOSEND_ON}`,
    };
  }

  return { rung, title, doing, ladder, healthy, blockers, nextStep, tierKnown: i.tierKnown };
}

/** Render the posture as a plain-language terminal block: where you are, the
 * three rungs with you marked, whether it's working (with fixes), and the exact
 * next step. Shared by `doctor` so every surface tells the same story. */
export function renderPosture(p: Posture): string {
  const lines: string[] = [];
  lines.push(`  Where you are: ${p.title}. ${p.doing}`);
  lines.push("  The ladder:");
  for (const r of p.ladder) {
    const marker = r.current ? "▸" : " ";
    const here = r.current ? "  (you're here)" : "";
    lines.push(`   ${marker} ${r.rung}. ${r.title}${here}`);
    lines.push(`        ${r.blurb}`);
  }
  if (p.healthy) {
    lines.push(`  Working correctly: yes${p.rung === 0 ? " (nothing set up yet)" : ""}`);
  } else {
    lines.push("  Working correctly: NEEDS ATTENTION");
    for (const b of p.blockers) lines.push(`      - ${b}`);
  }
  if (p.nextStep) {
    lines.push(`  Next step (optional): move to "${p.nextStep.toTitle}"`);
    lines.push(`      Why:  ${p.nextStep.why}`);
    lines.push(`      How:  ${p.nextStep.how}`);
  } else {
    lines.push("  You're at the top rung. Nothing more to turn on.");
  }
  return lines.join("\n") + "\n";
}
