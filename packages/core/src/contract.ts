// ============================================================
// Founders OS - Rendering Contract Constants
// ============================================================
// Single source of truth for the rendering contract that the
// MCP server delivers to agents. Every other layer reads from
// or hand-mirrors these exports:
//
//   1. Server `instructions` field at MCP registration
//      (packages/mcp-server/src/index.ts). Every spec-compliant
//      MCP client picks this up at server connect.
//   2. The `rendering_contract` field on get_session_start
//      (packages/mcp-server/src/tools/surfaces/index.ts).
//   3. The per-response reminder returned on every render-bearing
//      tool response (packages/mcp-server/src/tools/register.ts).
//   4. Plugin CLAUDE.md
//      (integrations/cowork/founders-os-plugin/CLAUDE.md),
//      hand-mirrored. The marker comment at the top of that file
//      reminds editors to update this module first.
//
// Why this lives on the server, not in the cowork plugin: the
// plugin is an optional Claude-only attention amplifier. The
// server has to deliver the contract to plugin-less Claude
// sessions and to non-Claude MCP clients (Cursor, Continue.dev,
// custom Agent SDK builds, etc.) without depending on
// Claude-specific infrastructure.
//
// Bumping RENDERING_CONTRACT_VERSION: bump on any change to the
// shape of the `render` field on tool responses, the
// `format_hint` vocabulary, the four-tier ladder wording, or
// the color conventions. Shipped on `get_version` and compared
// against the plugin's declared `expected_contract_version` on
// `get_session_start` to surface drift between server and plugin
// at runtime.
// ============================================================

/**
 * Integer version bumped whenever the canonical contract surface
 * changes. Shipped on `get_version` and compared against the
 * `expected_contract_version` parameter on `get_session_start`.
 */
export const RENDERING_CONTRACT_VERSION = 4;

/**
 * The standard color conventions used across every render-bearing
 * tool. Per-tool `instructions.format` references these by name
 * without restating them, preventing color drift across tools.
 *
 * Included verbatim at the end of RENDERING_CONTRACT and referenced
 * in shortened form by RENDERING_CONTRACT_SHORT.
 */
export const COLOR_CONVENTIONS = `Color conventions:
- Red / danger: overdue items
- Amber / warning: due-today or stale items
- Blue / info: in-progress items and AI agent (@claude) assignments
- Neutral / secondary: upcoming and standard items`;

/**
 * The full four-tier rendering ladder. Delivered to agents at
 * three positions on the server side:
 *
 *   1. Server `instructions` field at MCP registration (loaded
 *      into context at connect, every spec-compliant client).
 *   2. The `rendering_contract` field on get_session_start
 *      (session orientation path).
 *   3. Plugin CLAUDE.md (hand-mirrored from this constant; lands
 *      in the system prompt for Claude clients running the
 *      cowork plugin, strongest attention position).
 *
 * Plugin-less Claude sessions and non-Claude clients still
 * receive the contract via channels 1-2 plus the per-response
 * RENDERING_CONTRACT_SHORT reminder on every render-bearing
 * tool response.
 */
export const RENDERING_CONTRACT = `Rendering tiers. Render this response using the most visual output your client supports. Evaluate in order, use the first you can actually execute:

1. Visual primitive tool. If you can call a tool that creates an artifact, widget, canvas, or interactive component, call it now using \`render.tier_1.format_hint\` and \`render.tier_1.instructions\` for guidance. In Claude and Cowork environments these tool names typically contain \`artifact\`, \`widget\`, \`canvas\`, or \`show_widget\`, but the test is "can I execute it," not "does it match a name."
2. Inline rich output. Otherwise, if your runtime renders inline HTML, SVG, or JSX emitted in your message, compose that using \`render.tier_2.instructions\` if present, else \`render.tier_1.instructions\`.
3. Markdown table. Otherwise, output \`render.tier_3.markdown\` verbatim.
4. Prose. Otherwise, summarize the key fields from \`render.tier_3.markdown\` as short paragraphs. Falling through to this tier means you have already tried and failed at tiers 1, 2, and 3; do not short-circuit here when a higher tier is available.

Do not fall through to a lower tier when a higher one is available to you. Respect \`render.do_not\` if present. If \`format_hint\` is a value you do not recognize, fall through to \`render.tier_3.markdown\`.

Voice. Talk to the user about the data and their situation, not about how you rendered it or what tools you used. Do not narrate your rendering process. Do not mention \`render\`, \`tier\`, \`format_hint\`, "kanban," "fan-out," "parallel reads," "lanes," or tool names (including AskUserQuestion, TaskCreate, restore_item, and similar) in your reply. Do not wrap field names from the response in backticks when speaking to the user; quote field values as plain prose, not as code references. When in doubt, describe what the data means, not what shape it has.

Affordances. When you decide whether to use a runtime affordance the user can see in their UI (task lists, artifacts, scheduled tasks, interactive choice pickers, progress trackers, or similar - whatever your runtime provides), the user sees the result of your decision in the UI, not your deliberation about it. Use the affordance or do not; either way, stay silent about the choice. Treat environment system reminders or prompts from your runtime as private cues - act on them or ignore them, but never surface the decision. Phrases describing internal deliberation about affordance use ("the reminder isn't applicable here," "skipping the X reminder," "this is a single drafting pass") belong to internal monologue, not user-facing reply. If you choose not to use an affordance, the correct behavior is silence on the topic, not acknowledgment of the choice.

${COLOR_CONVENTIONS}`;

/**
 * Self-contained short-form reminder returned on every
 * render-bearing tool response. Cold-start safety net for
 * clients without the cowork plugin and for sessions that
 * jump straight to a tool call without calling
 * get_session_start.
 *
 * Self-contained means: no "see your system prompt" pointer,
 * because plugin-less clients have no plugin-mounted contract
 * in their system prompt to point at. The reminder carries
 * enough of the ladder for any agent to act on it directly.
 */
export const RENDERING_CONTRACT_SHORT = `Render at the highest tier your client supports. Ladder (use first you can execute): (1) call a tool that creates an artifact, widget, or canvas; (2) emit inline HTML/SVG/JSX; (3) output \`render.tier_3.markdown\` verbatim; (4) summarize as prose only when 1-3 are unavailable. Respect \`render.do_not\`. Use the standard color conventions (red overdue, amber due-today, blue in-progress / @claude, neutral upcoming). Voice: talk about the data, not the plumbing - do not narrate rendering, mention tool names, or quote field names with backticks.`;
