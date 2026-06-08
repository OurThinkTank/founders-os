// ============================================================
// Founders OS - Tag Registry Tools (v0.4.0)
// ============================================================
// 5 tools for managing a shared tag vocabulary across FounderOS.
// Tags are soft-validated: task and customer tools warn on
// unrecognized tags but do not block operations.
//
// The slug field is the canonical form (lowercase, trimmed,
// spaces replaced with hyphens). The name field preserves the
// user's preferred display casing.
// ============================================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerToolMap, type ToolMap } from "../register.js";
import { conflict } from "../conflict.js";
import { writeAuditLog } from "../audit.js";
import { handleRemove, removeResolutionParams, type RemoveMode, type RemoveResolution } from "../remove.js";
import type { Render } from "../../types/render.js";
import type { ToolContext } from "../../types/context.js";

// Note: writeAuditLog still reads env vars; deferred to the audit-pass
// workstream. The tool-context lint only forbids createServiceClient /
// getCompanyId / getUserId directly inside handler bodies and helper
// files; indirect helpers like writeAuditLog are fine.

/** Convert a tag name to its canonical slug form. */
export function toSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")   // strip special chars (keep letters, digits, spaces, hyphens)
    .replace(/\s+/g, "-")        // spaces to hyphens
    .replace(/-+/g, "-")         // collapse consecutive hyphens
    .replace(/^-+|-+$/g, "");    // strip leading/trailing hyphens
}

// ── Structured Warning Types ────────────────────────────────

export interface TagWarning {
  code:
    | "typo"            // close match to existing tag
    | "bare_name"       // matches a known contact without @ prefix
    | "missing_prefix"  // no #, @, or ! prefix on a tag that should have one
    | "orphan_prefix";  // bare @ # or ! with nothing after it
  tag: string;
  message: string;
  suggestion?: string;
  severity: "hint" | "warning";
}

export interface ValidateTagsResult {
  warnings: TagWarning[];
  auto_registered: string[];
}

// Small lexicon of words that typically indicate state (! prefix)
const STATE_WORDS = new Set([
  "needs-review", "in-testing", "shipped", "shipped-not-announced",
  "waiting", "on-hold", "blocked", "stale", "draft", "ready",
  "approved", "rejected", "archived", "paused", "cancelled",
  "pending", "deferred", "in-progress", "done", "closed",
  "failed", "expired", "deprecated",
]);

/**
 * Validate tags against the registry and conventions.
 *
 * Four checks run in order for each unrecognized tag:
 * 1. Typo detection - close slug match to an existing registered tag
 * 2. Known-name detection - matches a contact's name without @ prefix
 * 2b. Known-customer detection - matches a customer/org name, nudges toward entity linking
 * 3. Prefix convention nudge - state words get !, project-looking tags get #,
 *    simple category words (bug, release, etc.) pass through quietly
 *
 * Tags with no close matches and no convention issues are auto-registered.
 */
export async function validateTags(
  ctx: ToolContext,
  tags: string[],
  opts: { preview?: boolean } = {}
): Promise<ValidateTagsResult> {
  // Filter out empty or whitespace-only tags
  const cleanTags = tags.filter((t) => t.trim().length > 0);
  if (cleanTags.length === 0) return { warnings: [], auto_registered: [] };

  const supabase = ctx.db;
  const companyId = ctx.companyId;
  const userId = ctx.userId;

  // Parallel fetch: tag registry + contacts + customers
  // All three queries are scoped to company_id (migration 007 added company_id
  // to both contacts and customers tables).
  const [registryRes, contactsRes, customersRes, projectsRes] =
    await Promise.all([
      supabase
        .from("tag_registry")
        .select("name, slug")
        .eq("company_id", companyId)
        .is("deleted_at", null),
      supabase
        .from("contacts")
        .select("first_name, last_name")
        .eq("company_id", companyId)
        .is("deleted_at", null),
      supabase
        .from("customers")
        .select("organization_name")
        .eq("company_id", companyId)
        .is("deleted_at", null),
      supabase
        .from("projects")
        .select("name, slug, tag_name")
        .eq("company_id", companyId)
        .in("status", ["active", "paused"])
        .is("deleted_at", null),
    ]);

  // If any fetch failed, fall back to no validation rather than blocking
  if (
    registryRes.error ||
    contactsRes.error ||
    customersRes.error ||
    projectsRes.error
  ) {
    return { warnings: [], auto_registered: [] };
  }

  const knownSlugs = new Set(
    (registryRes.data ?? []).map((r: { slug: string }) => r.slug)
  );
  const slugToName = new Map(
    (registryRes.data ?? []).map((r: { name: string; slug: string }) => [
      r.slug,
      r.name,
    ])
  );

  // Build a set of known person name slugs for name detection
  const knownNames = new Set<string>();
  for (const c of contactsRes.data ?? []) {
    const first = (c.first_name ?? "").trim().toLowerCase();
    const last = (c.last_name ?? "").trim().toLowerCase();
    if (first) knownNames.add(first);
    if (last) knownNames.add(last);
    if (first && last) knownNames.add(`${first}-${last}`);
  }

  // Build a set of known customer/org name slugs for project/company detection
  const knownCustomerSlugs = new Set<string>();
  for (const cust of customersRes.data ?? []) {
    const name = (cust.organization_name ?? "").trim();
    if (name) {
      knownCustomerSlugs.add(toSlug(name));
      // Also add individual words for multi-word org names
      // e.g. "Life Science Outsourcing" matches tag "life-science-outsourcing"
      // but also a tag shorthand like "outsourcing"
      for (const word of name.toLowerCase().split(/\s+/)) {
        if (word.length >= 3) knownCustomerSlugs.add(word);
      }
    }
  }

  // Build a set of known project slugs for project name detection
  const knownProjectSlugs = new Set<string>();
  for (const proj of projectsRes.data ?? []) {
    const s = (proj.slug ?? "").trim();
    if (s) knownProjectSlugs.add(s);
  }

  const warnings: TagWarning[] = [];
  const autoRegistered: string[] = [];

  for (const tag of cleanTags) {
    // ── Check 0: Orphan prefix (bare @ # or ! with nothing after) ──
    // This must run BEFORE the slug check because toSlug() strips prefix chars,
    // making "#" alone produce an empty slug which would hit `continue` below
    // and silently swallow the tag without generating a warning.
    const prefixMatch = tag.match(/^([#@!])(.*)/);
    const prefix = prefixMatch?.[1] ?? null;
    const bare = prefixMatch ? prefixMatch[2].trim() : tag.trim();

    if (prefix && !bare) {
      warnings.push({
        code: "orphan_prefix",
        tag,
        message: `Tag "${tag}" is just a prefix with nothing after it.`,
        severity: "warning",
      });
      continue;
    }

    const slug = toSlug(tag);
    if (!slug) continue;

    if (knownSlugs.has(slug)) {
      // Even for known slugs, check if the user submitted a bare name that
      // matches a #-prefixed registry entry (e.g. "alpha-release" when
      // "#alpha-release" exists). This catches the case where a project's
      // auto-created tag shares a slug with the unprefixed form.
      if (!prefix) {
        const matchedName = slugToName.get(slug);
        if (matchedName && matchedName.startsWith("#")) {
          warnings.push({
            code: "bare_name",
            tag,
            message: `Tag "${tag}" matches a registered project. Use ${matchedName} for the project tag.`,
            suggestion: matchedName,
            severity: "hint",
          });
        }
      }
      continue;
    }

    // ── Check 1: Typo detection against registry ──
    const similar = [...knownSlugs].filter((known) => {
      if (known.includes(slug) || slug.includes(known)) return true;
      const minLen = Math.min(known.length, slug.length);
      if (minLen < 3) return false;
      let shared = 0;
      for (let i = 0; i < minLen; i++) {
        if (known[i] === slug[i]) shared++;
        else break;
      }
      return shared >= 3;
    });

    if (similar.length > 0) {
      const displaySuggestions = similar.map((s) => slugToName.get(s) ?? s);
      warnings.push({
        code: "typo",
        tag,
        message: `Tag "${tag}" is not in the registry. Did you mean: ${displaySuggestions.join(", ")}?`,
        suggestion: displaySuggestions[0],
        severity: "warning",
      });
      continue;
    }

    // ── Check 2: Known-name detection (contacts → @) ──
    const bareSlug = toSlug(bare);
    if (!prefix && knownNames.has(bareSlug)) {
      warnings.push({
        code: "bare_name",
        tag,
        message: `Tag "${tag}" matches a known contact. Use @${bare} to mark this as a person tag.`,
        suggestion: `@${bare}`,
        severity: "hint",
      });
      // Auto-register below, but skip the prefix nudge - bare_name is more specific
    } else if (!prefix && knownCustomerSlugs.has(bareSlug)) {
      // ── Check 2b: Known-customer detection (nudge toward entity link) ──
      warnings.push({
        code: "bare_name",
        tag,
        message: `Tag "${tag}" matches a known customer/org. Consider using link_task to connect this task to the customer record instead of tagging. Tags with # are for projects (e.g. #${bare}-proposal).`,
        suggestion: undefined,
        severity: "hint",
      });
    } else if (!prefix && knownProjectSlugs.has(bareSlug)) {
      // ── Check 2c: Known-project detection (projects → #) ──
      warnings.push({
        code: "bare_name",
        tag,
        message: `Tag "${tag}" matches a known project. Use #${bare} for the project tag.`,
        suggestion: `#${bare}`,
        severity: "hint",
      });
    } else if (!prefix) {
      // ── Check 3: Prefix convention nudge (only if not a known name, customer, or project) ──
      if (STATE_WORDS.has(bareSlug)) {
        warnings.push({
          code: "missing_prefix",
          tag,
          message: `Tag "${tag}" looks like a state. Convention: use !${bare} for meta-states.`,
          suggestion: `!${bare}`,
          severity: "hint",
        });
      } else {
        // Heuristic fallback: nudge toward # if the tag looks like a
        // project name (contains a hyphen or version-like segment) and
        // is not a common compound word. This is a weak signal - the
        // registry-backed check above is authoritative.
        const looksLikeProject = bare.includes("-") || /v?\d/.test(bare);
        const COMPOUND_EXCLUSIONS = new Set([
          "go-to-market", "follow-up", "sign-off", "data-integrity",
          "multi-tenant", "end-to-end", "day-to-day", "one-on-one",
          "check-in", "kick-off", "run-through", "stand-up",
        ]);
        if (looksLikeProject && !COMPOUND_EXCLUSIONS.has(bare.toLowerCase())) {
          warnings.push({
            code: "missing_prefix",
            tag,
            message: `Tag "${tag}" looks like it could be a project name. Convention: use #${bare} for projects. If this is a registered project, this nudge will be automatic.`,
            suggestion: `#${bare}`,
            severity: "hint",
          });
        }
      }
    }

    // Preview mode: detection only. Return the warnings without ever
    // writing to the registry, so callers (e.g. preview_tags) can show how
    // a tag would be classified without persisting it.
    if (opts.preview) continue;

    // Auto-register the tag as provided (preserve user's choice)
    const { error } = await supabase.from("tag_registry").insert({
      name: tag.trim(),
      slug,
      color: null,
      description: null,
      scope: "org",
      company_id: companyId,
      created_by: userId,
    });

    if (!error) {
      autoRegistered.push(tag);
      knownSlugs.add(slug);
      slugToName.set(slug, tag.trim());
    } else if (error.code === "23505") {
      knownSlugs.add(slug);
    }
  }

  return { warnings, auto_registered: autoRegistered };
}

export const tagTools: ToolMap = {
  // ──────────────────────────────────────────────────────────
  // list_tags
  // ──────────────────────────────────────────────────────────
  list_tags: {
    title: "List Tags",
    description:
      "List all registered tags for the current company. Returns name, slug, color, " +
      "and description for each tag. Use this to see what tags are available before " +
      "tagging tasks or customers.",
    parameters: z.object({
      scope: z
        .enum(["personal", "org"])
        .optional()
        .describe("Filter by scope. Omit to return all tags."),
      include_archived: z
        .boolean()
        .optional()
        .describe("Set true to include archived tags. Defaults to false."),
    }),
    handler: async (ctx: ToolContext, { scope, include_archived }: { scope?: "personal" | "org"; include_archived?: boolean }) => {
      const supabase = ctx.db;
      let query = supabase
        .from("tag_registry")
        .select("*")
        .eq("company_id", ctx.companyId)
        .order("name", { ascending: true });

      if (scope) query = query.eq("scope", scope);
      if (!include_archived) {
        query = query.or("archived.is.null,archived.eq.false");
      }
      query = query.is("deleted_at", null);

      const { data, error } = await query;
      if (error) throw new Error(`Failed to list tags: ${error.message}`);
      return { tags: data ?? [], count: data?.length ?? 0 };
    },
  },

  // ──────────────────────────────────────────────────────────
  // preview_tags
  // ──────────────────────────────────────────────────────────
  preview_tags: {
    title: "Preview Tags",
    description:
      "Validate tag names and return the same warnings tagging would produce " +
      "(bare contact name, customer/org match, missing ! or # prefix, typo) " +
      "WITHOUT registering anything. Read-only - nothing is persisted. Call when " +
      "you want to show how a tag name would be classified before committing it. " +
      "Returns { warnings, auto_registered: [] }; auto_registered is always empty.",
    parameters: z.object({
      tags: z
        .array(z.string())
        .describe("Tag names to check, e.g. ['Alex', 'needs-review']."),
    }),
    handler: async (ctx: ToolContext, { tags }: { tags: string[] }) => {
      return await validateTags(ctx, tags, { preview: true });
    },
  },

  // ──────────────────────────────────────────────────────────
  // create_tag
  // ──────────────────────────────────────────────────────────
  create_tag: {
    title: "Create Tag",
    description:
      "Register a new tag in the tag registry. The slug (lowercase, hyphenated form) " +
      "must be unique per company. Returns an error if a tag with the same slug already exists.",
    parameters: z.object({
      name: z
        .string()
        .describe("Display name for the tag (e.g. 'Q2 2026', 'Fundraising')."),
      color: z
        .string()
        .optional()
        .describe("Hex color for UI rendering (e.g. '#4A90D9'). Optional."),
      description: z
        .string()
        .optional()
        .describe("What this tag means or when to use it."),
      scope: z
        .enum(["personal", "org"])
        .optional()
        .describe("Tag scope. Defaults to 'org'."),
    }),
    handler: async (ctx: ToolContext, {
      name,
      color,
      description,
      scope,
    }: {
      name: string;
      color?: string;
      description?: string;
      scope?: "personal" | "org";
    }) => {
      const supabase = ctx.db;
      const slug = toSlug(name);

      const { data, error } = await supabase
        .from("tag_registry")
        .insert({
          name: name.trim(),
          slug,
          color: color ?? null,
          description: description ?? null,
          scope: scope ?? "org",
          company_id: ctx.companyId,
          created_by: ctx.userId,
        })
        .select()
        .single();

      if (error) {
        if (error.code === "23505") {
          throw new Error(
            `Tag "${name}" (slug: "${slug}") already exists. Use rename_tag to change it.`
          );
        }
        throw new Error(`Failed to create tag: ${error.message}`);
      }

      return { success: true, tag: data };
    },
  },

  // ──────────────────────────────────────────────────────────
  // rename_tag
  // ──────────────────────────────────────────────────────────
  rename_tag: {
    title: "Rename Tag",
    description:
      "Rename a registered tag. Updates the display name and slug. " +
      "If the tag is in use and propagate is not explicitly set, a `conflict` response " +
      "is returned asking whether to propagate the rename. Set propagate=true or propagate=false " +
      "to skip the conflict.",
    parameters: z.object({
      tag_id: z.string().uuid().describe("Tag registry UUID."),
      new_name: z.string().describe("New display name for the tag."),
      cascade: z
        .boolean()
        .optional()
        .describe(
          "If true, rename the tag on all tasks/customers/financial records that use it. " +
          "If false, rename only the registry entry. If omitted and the tag is in use, " +
          "a conflict is returned asking the user to decide."
        ),
      propagate: z
        .boolean()
        .optional()
        .describe("Deprecated: use `cascade`."),
    }),
    handler: async (ctx: ToolContext, {
      tag_id,
      new_name,
      propagate,
      cascade,
    }: {
      tag_id: string;
      new_name: string;
      propagate?: boolean;
      cascade?: boolean;
    }) => {
      const doCascade = cascade ?? propagate;
      const supabase = ctx.db;
      const companyId = ctx.companyId;
      const newSlug = toSlug(new_name);

      // Fetch old tag to get old name
      const { data: oldTag, error: fetchError } = await supabase
        .from("tag_registry")
        .select("name, slug")
        .eq("id", tag_id)
        .is("deleted_at", null)
        .single();

      if (fetchError)
        throw new Error(`Tag not found: ${fetchError.message}`);

      const oldName = oldTag.name;

      // If cascade was not explicitly set, check usage and ask
      if (doCascade === undefined) {
        const [taskRes, custRes, acctRes, catRes, txRes] = await Promise.all([
          supabase
            .from("tasks")
            .select("id", { count: "exact", head: true })
            .eq("company_id", companyId)
            .contains("tags", [oldName])
            .is("deleted_at", null),
          supabase
            .from("customers")
            .select("id", { count: "exact", head: true })
            .contains("tags", [oldName])
            .is("deleted_at", null),
          supabase
            .from("financial_accounts")
            .select("id", { count: "exact", head: true })
            .eq("company_id", companyId)
            .contains("tags", [oldName])
            .is("deleted_at", null),
          supabase
            .from("financial_categories")
            .select("id", { count: "exact", head: true })
            .eq("company_id", companyId)
            .contains("tags", [oldName])
            .is("deleted_at", null),
          supabase
            .from("financial_transactions")
            .select("id", { count: "exact", head: true })
            .eq("company_id", companyId)
            .contains("tags", [oldName])
            .is("deleted_at", null),
        ]);

        const taskCount = taskRes.count ?? 0;
        const custCount = custRes.count ?? 0;
        const acctCount = acctRes.count ?? 0;
        const catCount = catRes.count ?? 0;
        const txCount = txRes.count ?? 0;
        const financialCount = acctCount + catCount + txCount;

        if (taskCount > 0 || custCount > 0 || financialCount > 0) {
          return conflict(
            "silent_default",
            `${taskCount} task(s), ${custCount} customer(s), and ${financialCount} financial record(s) use this tag. Should the rename apply to them too?`,
            [
              {
                key: "propagate",
                label: "Yes, update everywhere",
                value: { tag_id, new_name, cascade: true },
              },
              {
                key: "registry_only",
                label: "No, just rename in the registry",
                value: { tag_id, new_name, cascade: false },
              },
            ],
            {
              tag_name: oldName,
              task_count: taskCount,
              customer_count: custCount,
              account_count: acctCount,
              category_count: catCount,
              transaction_count: txCount,
            }
          );
        }
      }

      // Update registry (scoped to company_id to prevent cross-tenant renames)
      const { data, error } = await supabase
        .from("tag_registry")
        .update({ name: new_name.trim(), slug: newSlug })
        .eq("id", tag_id)
        .eq("company_id", companyId)
        .select()
        .single();

      if (error) {
        if (error.code === "23505") {
          throw new Error(
            `Tag slug "${newSlug}" already exists. Choose a different name.`
          );
        }
        throw new Error(`Failed to rename tag: ${error.message}`);
      }

      const propagated = { tasks: 0, customers: 0, accounts: 0, categories: 0, transactions: 0 };
      let propagation_error: string | null = null;

      if (doCascade) {
        // Update tasks: replace oldName with new_name in the tags array
        // Postgres: array_replace(tags, old, new)
        const { data: taskResult, error: taskRpcError } = await supabase.rpc(
          "rename_tag_in_tasks",
          {
            p_company_id: companyId,
            p_old_name: oldName,
            p_new_name: new_name.trim(),
          }
        );
        if (taskRpcError) {
          propagation_error = `Failed to propagate to tasks: ${taskRpcError.message}`;
        } else {
          propagated.tasks = taskResult ?? 0;
        }

        // Update customers similarly (attempt even if tasks failed)
        const { data: custResult, error: custRpcError } = await supabase.rpc(
          "rename_tag_in_customers",
          {
            p_company_id: companyId,
            p_old_name: oldName,
            p_new_name: new_name.trim(),
          }
        );
        if (custRpcError) {
          const msg = `Failed to propagate to customers: ${custRpcError.message}`;
          propagation_error = propagation_error
            ? `${propagation_error}; ${msg}`
            : msg;
        } else {
          propagated.customers = custResult ?? 0;
        }

        // Propagate to financial entities (attempt each even if earlier ones failed)
        const { data: acctResult, error: acctRpcError } = await supabase.rpc(
          "rename_tag_in_accounts",
          { p_company_id: companyId, p_old_name: oldName, p_new_name: new_name.trim() }
        );
        if (acctRpcError) {
          const msg = `Failed to propagate to accounts: ${acctRpcError.message}`;
          propagation_error = propagation_error ? `${propagation_error}; ${msg}` : msg;
        } else {
          propagated.accounts = acctResult ?? 0;
        }

        const { data: catResult, error: catRpcError } = await supabase.rpc(
          "rename_tag_in_categories",
          { p_company_id: companyId, p_old_name: oldName, p_new_name: new_name.trim() }
        );
        if (catRpcError) {
          const msg = `Failed to propagate to categories: ${catRpcError.message}`;
          propagation_error = propagation_error ? `${propagation_error}; ${msg}` : msg;
        } else {
          propagated.categories = catResult ?? 0;
        }

        const { data: txResult, error: txRpcError } = await supabase.rpc(
          "rename_tag_in_transactions",
          { p_company_id: companyId, p_old_name: oldName, p_new_name: new_name.trim() }
        );
        if (txRpcError) {
          const msg = `Failed to propagate to transactions: ${txRpcError.message}`;
          propagation_error = propagation_error ? `${propagation_error}; ${msg}` : msg;
        } else {
          propagated.transactions = txResult ?? 0;
        }
      }

      const result: Record<string, unknown> = {
        success: true,
        tag: data,
        propagated,
      };
      if (propagation_error) {
        result.propagation_error = propagation_error;
        result.note = "The tag was renamed, but some linked items did not update. " +
          "They still show the old tag name.";

        const incidentMarkdown =
          `**Tag renamed with issues**\n\n` +
          `The tag itself was renamed, but some linked items did not update and ` +
          `still show the old name.\n\n` +
          `**What happened:** ${propagation_error}\n\n` +
          `**Updated successfully:** ${propagated.tasks} task(s), ${propagated.customers} customer(s), ` +
          `${propagated.accounts} account(s), ${propagated.categories} category(ies), ${propagated.transactions} transaction(s).\n\n` +
          `You can retry the rename or update the missed items manually.`;

        const render: Render = {
          tier_1: {
            format_hint: "incident",
            instructions: {
              scope:
                "show that the rename succeeded but some linked items did not " +
                "update. Include the error detail and the count of items that " +
                "did update.",
              format:
                "amber header per the standard color conventions; show the " +
                "error detail beneath the success summary as plain prose; show " +
                "the counts of items that did update as a small metadata row.",
              forbidden:
                "do not present this as a clean success; do not paraphrase the " +
                "error detail (the user needs the literal message to act on it); " +
                "do not omit the counts of what did update.",
            },
          },
          tier_3: {
            markdown: incidentMarkdown,
          },
          do_not: [
            "Do not invent new color meanings; use the standard color conventions.",
          ],
        };
        result.render = render;
      }
      return result;
    },
  },

  // ──────────────────────────────────────────────────────────
  // remove_tag
  // ──────────────────────────────────────────────────────────
  remove_tag: {
    title: "Remove Tag",
    description:
      "Remove a tag by archiving (hides from active views, recoverable) or permanently deleting. " +
      "On first call, returns a `conflict` with ARCHIVE / DELETE / CANCEL options. " +
      "Pass mode after the user decides. If the tag is owned by a project, the tool suggests " +
      "removing the project instead. On delete, pass clean_items=true to also strip the tag " +
      "from all tasks and customers that use it.",
    parameters: z.object({
      tag_id: z.string().uuid().describe("Tag registry UUID to remove."),
      ...removeResolutionParams,
      cascade: z
        .boolean()
        .optional()
        .describe(
          "When deleting, also remove this tag from all tasks, customers, and financial " +
          "records that use it. If false, the registry entry is deleted but items keep the " +
          "tag text (orphaned)."
        ),
      clean_items: z
        .boolean()
        .optional()
        .describe("Deprecated: use `cascade`."),
    }),
    handler: async (ctx: ToolContext, { tag_id, mode, clean_items, resolution, cascade }: {
      tag_id: string;
      mode?: RemoveMode;
      clean_items?: boolean;
      resolution?: RemoveResolution;
      cascade?: boolean;
    }) => {
      const doCascade = cascade ?? clean_items;
      const supabase = ctx.db;
      const companyId = ctx.companyId;

      // Fetch the tag
      const { data: tag, error: tagErr } = await supabase
        .from("tag_registry")
        .select("name, slug, scope, created_by, company_id")
        .eq("id", tag_id)
        .is("deleted_at", null)
        .single();

      if (tagErr) throw new Error(`Tag not found: ${tagErr.message}`);

      // ── Project ownership check ──
      // If this tag belongs to a project, block removal and suggest
      // removing the project instead.
      if (!mode && !resolution) {
        const { data: owningProject } = await supabase
          .from("projects")
          .select("id, name, status")
          .eq("company_id", companyId)
          .eq("tag_name", tag.name)
          .is("deleted_at", null)
          .maybeSingle();

        if (owningProject) {
          return conflict(
            "destructive_action",
            `Tag "${tag.name}" is owned by project "${owningProject.name}" (status: ${owningProject.status}). ` +
            `Remove the project instead of the tag directly.`,
            [
              {
                key: "remove_project",
                label: `Remove project "${owningProject.name}" instead`,
                value: { project_id: owningProject.id },
              },
              { key: "cancel", label: "Cancel", value: { resolution: "cancel" } },
            ],
            { project_id: owningProject.id, project_name: owningProject.name }
          );
        }
      }

      // Count usage for linked_data
      const [taskRes, custRes, acctRes, catRes, txRes] = await Promise.all([
        supabase
          .from("tasks")
          .select("id", { count: "exact", head: true })
          .eq("company_id", companyId)
          .contains("tags", [tag.name])
          .is("deleted_at", null),
        supabase
          .from("customers")
          .select("id", { count: "exact", head: true })
          .contains("tags", [tag.name])
          .is("deleted_at", null),
        supabase
          .from("financial_accounts")
          .select("id", { count: "exact", head: true })
          .eq("company_id", companyId)
          .contains("tags", [tag.name])
          .is("deleted_at", null),
        supabase
          .from("financial_categories")
          .select("id", { count: "exact", head: true })
          .eq("company_id", companyId)
          .contains("tags", [tag.name])
          .is("deleted_at", null),
        supabase
          .from("financial_transactions")
          .select("id", { count: "exact", head: true })
          .eq("company_id", companyId)
          .contains("tags", [tag.name])
          .is("deleted_at", null),
      ]);

      const linked_data: Record<string, number> = {};
      if ((taskRes.count ?? 0) > 0) linked_data["task(s) using this tag"] = taskRes.count!;
      if ((custRes.count ?? 0) > 0) linked_data["customer(s) using this tag"] = custRes.count!;
      if ((acctRes.count ?? 0) > 0) linked_data["account(s) using this tag"] = acctRes.count!;
      if ((catRes.count ?? 0) > 0) linked_data["category(ies) using this tag"] = catRes.count!;
      if ((txRes.count ?? 0) > 0) linked_data["transaction(s) using this tag"] = txRes.count!;

      return handleRemove({
        ctx,
        entity_type: "tag",
        entity_id: tag_id,
        entity_label: tag.name,
        scope: (tag.scope as "personal" | "org") ?? "org",
        created_by: tag.created_by,
        company_id: tag.company_id,
        mode,
        resolution,
        linked_data,
        delete_warning: doCascade
          ? "The tag will also be stripped from all tasks and customers."
          : "Items using this tag will keep the text but it will be orphaned from the registry.",
        before_state: { name: tag.name, slug: tag.slug },
        archiveFn: async () => {
          const { data, error } = await supabase
            .from("tag_registry")
            .update({ archived: true })
            .eq("id", tag_id)
            .eq("company_id", companyId)
            .select()
            .single();
          if (error) throw new Error(`Failed to archive tag: ${error.message}`);
          return data;
        },
        deleteFn: async () => {
          // Clean items if requested (remove tag references from tasks/customers)
          if (doCascade) {
            const { error: taskCleanErr } = await supabase.rpc("remove_tag_from_tasks", {
              p_company_id: companyId,
              p_tag_name: tag.name,
            });
            if (taskCleanErr) throw new Error(`Failed to remove tag from tasks: ${taskCleanErr.message}`);

            const { error: custCleanErr } = await supabase.rpc("remove_tag_from_customers", {
              p_company_id: companyId,
              p_tag_name: tag.name,
            });
            if (custCleanErr) throw new Error(`Failed to remove tag from customers: ${custCleanErr.message}`);

            const { error: acctCleanErr } = await supabase.rpc("remove_tag_from_accounts", {
              p_company_id: companyId,
              p_tag_name: tag.name,
            });
            if (acctCleanErr) throw new Error(`Failed to remove tag from accounts: ${acctCleanErr.message}`);

            const { error: catCleanErr } = await supabase.rpc("remove_tag_from_categories", {
              p_company_id: companyId,
              p_tag_name: tag.name,
            });
            if (catCleanErr) throw new Error(`Failed to remove tag from categories: ${catCleanErr.message}`);

            const { error: txCleanErr } = await supabase.rpc("remove_tag_from_transactions", {
              p_company_id: companyId,
              p_tag_name: tag.name,
            });
            if (txCleanErr) throw new Error(`Failed to remove tag from transactions: ${txCleanErr.message}`);
          }

          const { data, error } = await supabase
            .from("tag_registry")
            .update({ deleted_at: new Date().toISOString() })
            .eq("id", tag_id)
            .eq("company_id", companyId)
            .select()
            .single();
          if (error) throw new Error(`Failed to delete tag: ${error.message}`);
          return data;
        },
      });
    },
  },
};

export function registerTagTools(server: McpServer, ctx: ToolContext): void {
  registerToolMap(server, tagTools, ctx);
}
