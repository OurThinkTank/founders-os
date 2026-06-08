// ============================================================
// Founders OS — Structured Conflict Resolution Protocol
// ============================================================
// "Validate, Don't Assume"
//
// When a handler detects ambiguous input, a destructive consequence,
// or a silent default the user should know about, it returns a
// conflict instead of guessing or throwing.
//
// Conflicts are NOT errors. They return a normal response that the
// AI client presents as a choice. The operation is NOT performed
// until the user decides.
//
// AI clients:
//   1. Detect the `conflict` key in the tool response
//   2. Present all options via interactive UI (AskUserQuestion)
//      or as a numbered list in plain text
//   3. Retry the tool call with the user's chosen resolution
//
// Every conflict response carries a `render` block with
// format_hint: "decision" so the rendering contract is uniform
// across happy-path and conflict response shapes. tier_3 is
// omitted because conflicts are interactive; falling through
// to prose would be the wrong UX.
// ============================================================

import type { Render } from "../types/render.js";

/**
 * A single resolution option the user can choose.
 */
export interface ConflictOption {
  /** Machine-readable key, e.g. "delete", "cancel", "keep_date" */
  key: string;
  /** Human-readable label for display */
  label: string;
  /** Arbitrary payload - gets passed back if the user picks this option */
  value: Record<string, unknown>;
}

/**
 * Structured conflict returned instead of a normal result or error.
 * The presence of a `conflict` key in a tool response signals
 * that the operation was NOT performed and needs user input.
 */
export interface Conflict {
  /** What kind of conflict this is (for programmatic handling) */
  type:
    | "ambiguous_input"      // multiple interpretations of what user meant
    | "destructive_action"   // operation has irreversible consequences
    | "silent_default"       // server would apply a non-obvious default
    | "partial_match"        // lookup returned multiple candidates
    | "validation_mismatch"; // input contradicts itself (like date/day)

  /** Human-readable summary of the conflict */
  message: string;

  /** The options the user can choose from */
  options: ConflictOption[];

  /**
   * Instruction to the AI client on how to present this.
   * Always tells the AI NOT to assume and to present all options.
   */
  ai_guidance: string;

  /** Optional: extra context for the AI to relay */
  context?: Record<string, unknown>;
}

/**
 * Type guard: does this tool response contain a conflict?
 * Used by register.ts to detect conflict responses and skip
 * date enrichment. AI clients can also use this pattern.
 */
export function isConflictResponse(
  result: unknown
): result is { conflict: Conflict; render: Render } {
  return (
    typeof result === "object" &&
    result !== null &&
    "conflict" in result &&
    typeof (result as Record<string, unknown>).conflict === "object"
  );
}

/**
 * Standard `render` block for every conflict response.
 *
 * tier_3 is intentionally omitted: conflicts are interactive,
 * so falling through to a static markdown summary would be the
 * wrong UX. Agents that cannot render tier_1 should present the
 * options as a numbered list per the ai_guidance string.
 */
const CONFLICT_RENDER: Render = {
  tier_1: {
    format_hint: "decision",
    instructions: {
      scope:
        "present every option in the `options` array as a choice the user picks. " +
        "Show `conflict.type` as the header and `conflict.message` as the body text.",
      format:
        "each option as a prominent choice using its `label` field. Color the " +
        "destructive option red per the standard color conventions.",
      forbidden:
        "do not auto-pick an option; do not omit any option; do not editorialize " +
        "the choice.",
    },
  },
  do_not: [
    "Do not invent new color meanings; use the standard color conventions.",
    "Do not summarize a conflict as prose - let the user pick.",
  ],
};

/**
 * Helper to build a conflict response.
 * Handlers call this and return the result (no throw).
 *
 * Automatically attaches the standard `render` block with
 * format_hint: "decision" so every conflict response carries
 * uniform rendering guidance.
 */
export function conflict(
  type: Conflict["type"],
  message: string,
  options: ConflictOption[],
  context?: Record<string, unknown>
): { conflict: Conflict; render: Render } {
  return {
    conflict: {
      type,
      message,
      options,
      ai_guidance:
        "This operation was not performed. Show the user every option and " +
        "let them pick; do not assume which one is correct. Per the general " +
        "interactive-choice guidance, use the runtime's interactive chooser " +
        "if available rather than numbering the options as text. Wait for " +
        "the user to decide, then retry the operation with the chosen parameters.",
      context,
    },
    render: CONFLICT_RENDER,
  };
}
