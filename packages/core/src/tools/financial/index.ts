// ============================================================
// Founders OS — Financial Tools
// ============================================================
// 12 tools: add_transaction, list_transactions, set_transaction_customer,
//           add_category, list_categories, add_account, list_accounts,
//           transfer_between_accounts, get_pl_report,
//           get_financial_summary, delete_transaction,
//           delete_account
//
// All tools automatically scope to FOUNDERS_OS_COMPANY_ID
// (defaults to the sample placeholder "myawesomecompany" for solo
// use when FOUNDERS_OS_COMPANY_ID is unset; see utils/identity.ts).
//
// Amount convention (inherited from FirstLedger):
//   positive = income, negative = expense
//   The add_transaction tool accepts a positive amount + category type
//   and computes the sign internally.
// ============================================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerToolMap, type ToolMap } from "../register.js";
import { getLocalDateStr } from "../dates.js";
import { getFinancialAccess, financialPermissionError } from "./access.js";
import { writeAuditLog } from "../audit.js";
import { handleRemove, removeResolutionParams, type RemoveMode, type RemoveResolution } from "../remove.js";
import { tagFilterParams, resolveTagList } from "../filters.js";
import type { Render } from "../../types/render.js";
import type { ToolContext } from "../../types/context.js";
import { validateTags } from "../tags/index.js";

// Note on helpers used inside contextual handlers:
//   - getFinancialAccess(ctx) — access.ts refactor 2026-05-28.
//   - validateTags(ctx, ...) — tags-domain refactor 2026-05-28.
//   - writeAuditLog(ctx, ...) — audit.ts refactor 2026-05-28.
// The tool-context lint checks for createServiceClient / getCompanyId
// / getUserId directly in handler bodies; all indirect helpers above
// are contextual.

/**
 * Reduce rows from `financial_pl_by_customer_summary` into a per-customer
 * rollup. Exported for unit-test reuse without a live DB.
 *
 * Behavior:
 * - Income totals are summed signed (positive numbers as-is).
 * - Expense totals are summed as absolute values to match the existing
 *   `get_pl_report` convention (the view stores expenses as negatives).
 * - Rows with `customer_id` null collapse to a single "Unattributed" entry
 *   so the rollup reconciles to the top-level total_income / total_expenses.
 * - Output is sorted by `total_income` descending; the Unattributed row is
 *   forced to the end regardless of its income.
 */
export function rollupByCustomer(
  rows: Array<{
    customer_id?: string | null;
    customer_name?: string | null;
    category_type: "income" | "expense";
    total: number | string;
  }>
): Array<{
  customer_id: string | null;
  customer_name: string;
  total_income: number;
  total_expenses: number;
  net: number;
}> {
  const byKey = new Map<
    string,
    { customer_id: string | null; customer_name: string; total_income: number; total_expenses: number }
  >();
  for (const r of rows) {
    const cid = r.customer_id ?? null;
    const key = cid ?? "__unattributed__";
    const entry =
      byKey.get(key) ?? {
        customer_id: cid,
        customer_name: cid ? (r.customer_name ?? "(deleted customer)") : "Unattributed",
        total_income: 0,
        total_expenses: 0,
      };
    const amount = Number(r.total);
    if (r.category_type === "income") {
      entry.total_income += amount;
    } else {
      entry.total_expenses += Math.abs(amount);
    }
    byKey.set(key, entry);
  }
  return [...byKey.values()]
    .map((e) => ({ ...e, net: e.total_income - e.total_expenses }))
    .sort((a, b) => {
      // Unattributed always goes last regardless of its numbers
      if (a.customer_id === null && b.customer_id !== null) return 1;
      if (b.customer_id === null && a.customer_id !== null) return -1;
      return b.total_income - a.total_income;
    });
}

export const financialTools: ToolMap = {
  add_transaction: {
    title: "Add Transaction",
    description:
      "Record an income or expense transaction. Automatically updates the account balance. " +
      "Provide a positive amount — the sign is applied based on the category type.",
    parameters: z.object({
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe("Transaction date in YYYY-MM-DD format."),
      description: z.string().describe("Description of the transaction."),
      amount: z
        .number()
        .positive()
        .describe("Transaction amount (positive number — sign is derived from category type)."),
      category_id: z.string().uuid().describe("UUID of the category (income or expense)."),
      account_id: z.string().uuid().describe("UUID of the capital account to debit/credit."),
      customer_id: z
        .string()
        .uuid()
        .optional()
        .describe("UUID of the customer this transaction is attributed to (e.g. a client payment). Optional."),
      exclude_from_reports: z
        .boolean()
        .optional()
        .describe("Set true to exclude from P&L reports (e.g. owner draws). Default false."),
      tags: z
        .array(z.string())
        .optional()
        .describe("Tags for categorization and cleanup, e.g. ['demo-financial']."),
    }),
    handler: async (ctx: ToolContext, { date, description, amount, category_id, account_id, customer_id, exclude_from_reports = false, tags }: {
      date: string;
      description: string;
      amount: number;
      category_id: string;
      account_id: string;
      customer_id?: string;
      exclude_from_reports?: boolean;
      tags?: string[];
    }) => {
      const access = await getFinancialAccess(ctx);
      if (access !== "write") return financialPermissionError("write");

      const { data: cat, error: catErr } = await ctx.db
        .from("financial_categories")
        .select("type")
        .eq("id", category_id)
        .eq("company_id", ctx.companyId)
        .is("deleted_at", null)
        .single();

      if (catErr || !cat)
        throw new Error(`Category not found: ${catErr?.message ?? "unknown error"}`);

      const signedAmount = cat.type === "income" ? Math.abs(amount) : -Math.abs(amount);

      // Optional customer attribution. These tools run as the service role
      // (RLS bypassed), so this app-layer check is the tenant boundary:
      // mirror the category lookup exactly — id + company_id + deleted_at.
      if (customer_id) {
        const { data: cust, error: custErr } = await ctx.db
          .from("customers")
          .select("id")
          .eq("id", customer_id)
          .eq("company_id", ctx.companyId)
          .is("deleted_at", null)
          .single();
        if (custErr || !cust)
          throw new Error(`Customer not found: ${custErr?.message ?? "unknown error"}`);
      }

      const { data, error } = await ctx.db.rpc("create_financial_transaction", {
        p_company_id: ctx.companyId,
        p_date: date,
        p_description: description,
        p_amount: signedAmount,
        p_category_id: category_id,
        p_account_id: account_id,
        p_transfer_to_account_id: null,
        p_exclude_from_reports: exclude_from_reports,
        p_customer_id: customer_id ?? null,
      });

      if (error) throw new Error(`Failed to add transaction: ${error.message}`);

      const txData = data as { id?: string } | null;

      // Tag validation + storage (advisory, with auto-registration for new tags).
      // The create_financial_transaction RPC does not set tags, so apply them
      // with a follow-up update on the returned row.
      const tagResult =
        tags && tags.length > 0
          ? await validateTags(ctx, tags)
          : { warnings: [], auto_registered: [] };

      if (tags && tags.length > 0 && txData?.id) {
        const { error: tagErr } = await ctx.db
          .from("financial_transactions")
          .update({ tags })
          .eq("id", txData.id)
          .eq("company_id", ctx.companyId);
        if (tagErr) throw new Error(`Transaction created but tagging failed: ${tagErr.message}`);
      }

      await writeAuditLog(ctx, {
        action: "add_transaction",
        entity_type: "financial_transaction",
        entity_id: txData?.id ?? "unknown",
        after_state: { date, description, amount: signedAmount, category_id, account_id, customer_id: customer_id ?? null, exclude_from_reports, tags: tags ?? [] },
      });

      const result: Record<string, unknown> = { ...(data as Record<string, unknown>), tags: tags ?? [] };
      if (tagResult.warnings.length > 0) result.tag_warnings = tagResult.warnings;
      if (tagResult.auto_registered.length > 0) result.tags_auto_registered = tagResult.auto_registered;
      return result;
    },
  },

  list_transactions: {
    title: "List Transactions",
    description:
      "List financial transactions with optional date range and account filters. " +
      "Response includes a render field with tiered rendering guidance - check it before composing your reply.",
    parameters: z.object({
      from_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Start date (YYYY-MM-DD, inclusive)."),
      to_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("End date (YYYY-MM-DD, inclusive)."),
      account_id: z.string().uuid().optional().describe("Filter by account UUID."),
      category_id: z.string().uuid().optional().describe("Filter by category UUID."),
      customer_id: z.string().uuid().optional().describe("Filter by customer UUID."),
      ...tagFilterParams,
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Max results (default 100)."),
    }),
    handler: async (ctx: ToolContext, { from_date, to_date, account_id, category_id, customer_id, tag, tags, tag_match, limit = 100 }: {
      from_date?: string;
      to_date?: string;
      account_id?: string;
      category_id?: string;
      customer_id?: string;
      tag?: string;
      tags?: string[];
      tag_match?: "all" | "any";
      limit?: number;
    }) => {
      const access = await getFinancialAccess(ctx);
      if (access === "none") return financialPermissionError("read");

      let query = ctx.db
        .from("financial_transactions")
        .select(
          "id, date, description, amount, exclude_from_reports, tags, customer_id, created_at, " +
          "financial_categories(name, type), financial_accounts!account_id(name)"
        )
        .eq("company_id", ctx.companyId)
        .or("archived.is.null,archived.eq.false")
        .is("deleted_at", null)
        .is("financial_categories.deleted_at", null)
        .is("financial_accounts.deleted_at", null)
        .order("date", { ascending: false })
        .limit(limit);

      if (from_date) query = query.gte("date", from_date);
      if (to_date) query = query.lte("date", to_date);
      if (account_id) query = query.eq("account_id", account_id);
      if (category_id) query = query.eq("category_id", category_id);
      if (customer_id) query = query.eq("customer_id", customer_id);
      const tagList = resolveTagList(tag, tags);
      if (tagList) {
        query = tag_match === "any"
          ? query.overlaps("tags", tagList)
          : query.contains("tags", tagList);
      }

      const { data, error } = await query;
      if (error) throw new Error(`Failed to list transactions: ${error.message}`);

      // Build tier_3 markdown fallback
      const txRows = (data ?? []) as unknown as {
        date: string;
        description: string;
        amount: number;
        financial_categories: { name: string; type: string } | null;
        financial_accounts: { name: string } | null;
      }[];
      const fmtTx = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
      const txTable =
        `| Date | Description | Amount | Category | Account |\n` +
        `|------|-------------|-------:|----------|--------|\n` +
        txRows
          .slice(0, 20)
          .map(
            (t) =>
              `| ${t.date} | ${t.description} | ${fmtTx(Number(t.amount))} | ${
                t.financial_categories?.name ?? "-"
              } | ${t.financial_accounts?.name ?? "-"} |`
          )
          .join("\n") +
        (txRows.length > 20 ? `\n\n_Showing 20 of ${txRows.length} transactions_` : "");

      return {
        transactions: data,
        count: txRows.length,
        render: {
          tier_1: {
            format_hint: "table",
            instructions: {
              scope:
                "render the `transactions` array with columns: date, description, " +
                "amount, category, account. Cap at 20 rows in the default view.",
              format:
                "right-aligned amount column. Income rows (positive amount) tinted " +
                "in a positive color; expense rows (negative amount) tinted red " +
                "per the standard color conventions.",
              forbidden:
                "do not omit the amount sign or currency formatting; do not " +
                "display more than 20 rows by default.",
            },
          },
          tier_3: {
            markdown: txTable,
          },
          do_not: [
            "Do not invent new color meanings; use the standard color conventions.",
          ],
        } satisfies Render,
      };
    },
  },

  set_transaction_customer: {
    title: "Set Transaction Customer",
    description:
      "Attribute an existing transaction to a customer, or detach it. " +
      "Pass a customer_id to attribute the transaction, or null to clear the attribution.",
    parameters: z.object({
      transaction_id: z.string().uuid().describe("UUID of the transaction to update."),
      customer_id: z
        .string()
        .uuid()
        .nullable()
        .describe("UUID of the customer to attribute, or null to detach."),
    }),
    handler: async (ctx: ToolContext, { transaction_id, customer_id }: { transaction_id: string; customer_id: string | null }) => {
      const access = await getFinancialAccess(ctx);
      if (access !== "write") return financialPermissionError("write");

      // Target transaction must exist in this company and not be soft-deleted.
      const { data: tx, error: txErr } = await ctx.db
        .from("financial_transactions")
        .select("id")
        .eq("id", transaction_id)
        .eq("company_id", ctx.companyId)
        .is("deleted_at", null)
        .single();
      if (txErr || !tx)
        throw new Error(`Transaction not found: ${txErr?.message ?? "unknown error"}`);

      // When attributing (not detaching), the customer must exist in this
      // company and not be soft-deleted. Service role bypasses RLS, so this
      // app-layer check is the tenant boundary.
      if (customer_id) {
        const { data: cust, error: custErr } = await ctx.db
          .from("customers")
          .select("id")
          .eq("id", customer_id)
          .eq("company_id", ctx.companyId)
          .is("deleted_at", null)
          .single();
        if (custErr || !cust)
          throw new Error(`Customer not found: ${custErr?.message ?? "unknown error"}`);
      }

      const { data, error } = await ctx.db
        .from("financial_transactions")
        .update({ customer_id })
        .eq("id", transaction_id)
        .eq("company_id", ctx.companyId)
        .select("id, description, amount, date, customer_id")
        .single();
      if (error) throw new Error(`Failed to update transaction: ${error.message}`);

      await writeAuditLog(ctx, {
        action: "set_transaction_customer",
        entity_type: "financial_transaction",
        entity_id: transaction_id,
        after_state: { customer_id },
      });

      return data;
    },
  },

  add_category: {
    title: "Add Category",
    description: "Create an income or expense category.",
    parameters: z.object({
      name: z.string().describe("Category name (must be unique within the company)."),
      type: z.enum(["income", "expense"]).describe("Category type."),
      tags: z
        .array(z.string())
        .optional()
        .describe("Tags for categorization and cleanup, e.g. ['demo-financial']."),
    }),
    handler: async (ctx: ToolContext, { name, type, tags }: { name: string; type: "income" | "expense"; tags?: string[] }) => {
      const access = await getFinancialAccess(ctx);
      if (access !== "write") return financialPermissionError("write");

      const tagResult =
        tags && tags.length > 0
          ? await validateTags(ctx, tags)
          : { warnings: [], auto_registered: [] };

      const { data, error } = await ctx.db
        .from("financial_categories")
        .insert({ company_id: ctx.companyId, name, type, tags: tags ?? [] })
        .select()
        .single();

      if (error) throw new Error(`Failed to add category: ${error.message}`);

      await writeAuditLog(ctx, {
        action: "add_category",
        entity_type: "financial_category",
        entity_id: (data as { id?: string })?.id ?? "unknown",
        after_state: { name, type, tags: tags ?? [] },
      });

      const result: Record<string, unknown> = { ...(data as Record<string, unknown>) };
      if (tagResult.warnings.length > 0) result.tag_warnings = tagResult.warnings;
      if (tagResult.auto_registered.length > 0) result.tags_auto_registered = tagResult.auto_registered;
      return result;
    },
  },

  list_categories: {
    title: "List Categories",
    description: "List all financial categories, optionally filtered by type.",
    parameters: z.object({
      type: z
        .enum(["income", "expense"])
        .optional()
        .describe("Filter by category type. Omit to return all."),
      ...tagFilterParams,
      include_archived: z
        .boolean()
        .optional()
        .describe("Include archived categories. Default false."),
    }),
    handler: async (ctx: ToolContext, { type, tag, tags, tag_match, include_archived = false }: {
      type?: "income" | "expense";
      tag?: string;
      tags?: string[];
      tag_match?: "all" | "any";
      include_archived?: boolean;
    }) => {
      const access = await getFinancialAccess(ctx);
      if (access === "none") return financialPermissionError("read");

      let query = ctx.db
        .from("financial_categories")
        .select("id, name, type, tags, archived, created_at")
        .eq("company_id", ctx.companyId)
        .order("type")
        .order("name");

      if (type) query = query.eq("type", type);
      const tagList = resolveTagList(tag, tags);
      if (tagList) {
        query = tag_match === "any"
          ? query.overlaps("tags", tagList)
          : query.contains("tags", tagList);
      }
      if (!include_archived) query = query.eq("archived", false);
      query = query.is("deleted_at", null);

      const { data, error } = await query;
      if (error) throw new Error(`Failed to list categories: ${error.message}`);
      return data;
    },
  },

  add_account: {
    title: "Add Account",
    description: "Create a capital account (e.g. bank account, credit card, wallet).",
    parameters: z.object({
      name: z.string().describe("Account name (must be unique within the company)."),
      initial_balance: z
        .number()
        .nonnegative("Starting balance cannot be negative.") // FIX NEW-04
        .optional()
        .describe("Starting balance. Must be 0 or greater. Default 0."),
      tags: z
        .array(z.string())
        .optional()
        .describe("Tags for categorization and cleanup, e.g. ['demo-financial']."),
    }),
    handler: async (ctx: ToolContext, { name, initial_balance = 0, tags }: { name: string; initial_balance?: number; tags?: string[] }) => {
      const access = await getFinancialAccess(ctx);
      if (access !== "write") return financialPermissionError("write");

      const tagResult =
        tags && tags.length > 0
          ? await validateTags(ctx, tags)
          : { warnings: [], auto_registered: [] };

      const { data, error } = await ctx.db
        .from("financial_accounts")
        .insert({
          company_id: ctx.companyId,
          name,
          balance: initial_balance,
          initial_balance,
          tags: tags ?? [],
        })
        .select()
        .single();

      if (error) throw new Error(`Failed to add account: ${error.message}`);

      await writeAuditLog(ctx, {
        action: "add_account",
        entity_type: "financial_account",
        entity_id: (data as { id?: string })?.id ?? "unknown",
        after_state: { name, initial_balance, tags: tags ?? [] },
      });

      const result: Record<string, unknown> = { ...(data as Record<string, unknown>) };
      if (tagResult.warnings.length > 0) result.tag_warnings = tagResult.warnings;
      if (tagResult.auto_registered.length > 0) result.tags_auto_registered = tagResult.auto_registered;
      return result;
    },
  },

  list_accounts: {
    title: "List Accounts",
    description: "List all capital accounts with their current balances.",
    parameters: z.object({
      ...tagFilterParams,
      include_archived: z
        .boolean()
        .optional()
        .describe("Include archived accounts. Default false."),
    }),
    handler: async (ctx: ToolContext, { tag, tags, tag_match, include_archived = false }: { tag?: string; tags?: string[]; tag_match?: "all" | "any"; include_archived?: boolean }) => {
      const access = await getFinancialAccess(ctx);
      if (access === "none") return financialPermissionError("read");

      let query = ctx.db
        .from("financial_accounts")
        .select("id, name, balance, initial_balance, tags, archived, created_at")
        .eq("company_id", ctx.companyId)
        .order("name");

      const tagList = resolveTagList(tag, tags);
      if (tagList) {
        query = tag_match === "any"
          ? query.overlaps("tags", tagList)
          : query.contains("tags", tagList);
      }
      if (!include_archived) query = query.eq("archived", false);
      query = query.is("deleted_at", null);

      const { data, error } = await query;
      if (error) throw new Error(`Failed to list accounts: ${error.message}`);
      return data;
    },
  },

  transfer_between_accounts: {
    title: "Transfer Between Accounts",
    description:
      "Record a transfer of funds between two capital accounts. " +
      "Both legs are marked exclude_from_reports=true so they don't skew P&L. " +
      "If the inflow leg fails after the outflow succeeds, the outflow is automatically " +
      "reversed to keep account balances consistent. For full atomicity, a future " +
      "migration will wrap both legs in a single DB transaction.",
    parameters: z.object({
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe("Transfer date in YYYY-MM-DD format."),
      description: z.string().describe("Description of the transfer."),
      amount: z.coerce.number().positive().describe("Amount to transfer (positive number)."),
      from_account_id: z.string().uuid().describe("Account to transfer from."),
      to_account_id: z.string().uuid().describe("Account to transfer to."),
      category_id: z
        .string()
        .uuid()
        .describe("Category to assign (typically a 'Transfer' income/expense category)."),
    }),
    handler: async (ctx: ToolContext, { date, description, amount, from_account_id, to_account_id, category_id }: {
      date: string;
      description: string;
      amount: number;
      from_account_id: string;
      to_account_id: string;
      category_id: string;
    }) => {
      const access = await getFinancialAccess(ctx);
      if (access !== "write") return financialPermissionError("write");

      if (from_account_id === to_account_id) {
        return { error: "Cannot transfer to the same account: from_account_id and to_account_id must differ" };
      }

      const { data: outflow, error: outErr } = await ctx.db.rpc(
        "create_financial_transaction",
        {
          p_company_id: ctx.companyId,
          p_date: date,
          p_description: `Transfer out: ${description}`,
          p_amount: -Math.abs(amount),
          p_category_id: category_id,
          p_account_id: from_account_id,
          p_transfer_to_account_id: to_account_id,
          p_exclude_from_reports: true,
        }
      );
      if (outErr) throw new Error(`Transfer outflow failed: ${outErr.message}`);

      const { data: inflow, error: inErr } = await ctx.db.rpc(
        "create_financial_transaction",
        {
          p_company_id: ctx.companyId,
          p_date: date,
          p_description: `Transfer in: ${description}`,
          p_amount: Math.abs(amount),
          p_category_id: category_id,
          p_account_id: to_account_id,
          p_transfer_to_account_id: from_account_id,
          p_exclude_from_reports: true,
        }
      );

      if (inErr) {
        // Inflow failed - attempt to reverse the outflow so balances stay consistent.
        const outflowId = (outflow as { id?: string } | null)?.id;
        if (outflowId) {
          const { error: rollbackErr } = await ctx.db.rpc(
            "delete_financial_transaction",
            { p_company_id: ctx.companyId, p_transaction_id: outflowId }
          );
          if (rollbackErr) {
            // Both inflow and rollback failed - return structured partial failure
            // instead of throwing, so the AI can relay actionable instructions.
            const manualAction =
              `One transaction needs to be deleted manually to restore correct balances.`;
            const incidentMarkdown =
              `**Transfer did not complete cleanly**\n\n` +
              `The transfer started, but only one side went through and the cleanup ` +
              `step also failed. Account balances are currently inconsistent until ` +
              `the manual step below runs.\n\n` +
              `**What happened on the inflow side:** ${inErr.message}\n\n` +
              `**What happened on the cleanup:** ${rollbackErr.message}\n\n` +
              `**You will need to:** ${manualAction}`;
            const render: Render = {
              tier_1: {
                format_hint: "incident",
                instructions: {
                  scope:
                    "show that the transfer did not complete cleanly. Lead with " +
                    "the manual action the user has to take. Show both error " +
                    "messages beneath so the user can understand what went wrong.",
                  format:
                    "danger / red header per the standard color conventions; the " +
                    "manual action is the prominent call-to-action at the top; " +
                    "both error messages appear as plain prose beneath.",
                  forbidden:
                    "do not bury the manual action - balances are inconsistent " +
                    "until the user acts; do not paraphrase the error messages " +
                    "(the user needs the literal text); do not present this as " +
                    "anything less than a failure that needs manual intervention.",
                },
              },
              tier_3: {
                markdown: incidentMarkdown,
              },
              do_not: [
                "Do not invent new color meanings; use the standard color conventions.",
                "Do not auto-retry the transfer - the user has to verify state first.",
              ],
            };
            return {
              partial_failure: true,
              outflow_id: outflowId,
              inflow_error: inErr.message,
              rollback_error: rollbackErr.message,
              manual_action_required: manualAction,
              render,
            };
          }
        }
        throw new Error(
          `Transfer inflow failed (outflow has been reversed): ${inErr.message}`
        );
      }

      const outflowData = outflow as { id?: string } | null;
      const inflowData = inflow as { id?: string } | null;

      await writeAuditLog(ctx, {
        action: "transfer",
        entity_type: "financial_transaction",
        entity_id: outflowData?.id ?? "unknown",
        after_state: { amount, description, date },
        metadata: {
          from_account_id,
          to_account_id,
          outflow_id: outflowData?.id ?? null,
          inflow_id: inflowData?.id ?? null,
        },
      });

      return { outflow, inflow };
    },
  },

  get_pl_report: {
    title: "Get P&L Report",
    description:
      "Return a profit & loss summary grouped by category for a given date range. " +
      "Excludes transactions marked exclude_from_reports. Pass `customer_id` to " +
      "scope the report to a single attributed customer, or `group_by_customer: true` " +
      "to include a per-customer rollup alongside the category breakdown. " +
      "Transactions with no customer attribution bucket as 'Unattributed' in the rollup. " +
      "Response includes a render field with tiered rendering guidance - check it before composing your reply.",
    parameters: z.object({
      from_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe("Start date (YYYY-MM-DD, inclusive)."),
      to_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe("End date (YYYY-MM-DD, inclusive)."),
      customer_id: z
        .string()
        .uuid()
        .optional()
        .describe("Optional. Restrict the report to transactions attributed to this customer."),
      group_by_customer: z
        .boolean()
        .optional()
        .describe("Optional. When true, include a `by_customer` rollup with per-customer income, expenses, and net. Transactions without a customer attribution bucket as 'Unattributed'."),
    }),
    handler: async (ctx: ToolContext, { from_date, to_date, customer_id, group_by_customer }: {
      from_date: string;
      to_date: string;
      customer_id?: string;
      group_by_customer?: boolean;
    }) => {
      const access = await getFinancialAccess(ctx);
      if (access === "none") return financialPermissionError("read");

      // When customer_id is provided, validate it against the company first.
      // Service role bypasses RLS, so this app-layer check is the tenant boundary.
      if (customer_id) {
        const { data: cust, error: custErr } = await ctx.db
          .from("customers")
          .select("id")
          .eq("id", customer_id)
          .eq("company_id", ctx.companyId)
          .is("deleted_at", null)
          .single();
        if (custErr || !cust)
          throw new Error(`Customer not found: ${custErr?.message ?? "unknown error"}`);
      }

      // Pick the source view. Either customer_id or group_by_customer triggers
      // the by-customer view; everything else falls back to the original
      // financial_pl_summary, preserving the historical response shape.
      const usesByCustomerView = !!customer_id || !!group_by_customer;

      type PlRow = {
        month: string;
        category: string;
        category_type: "income" | "expense";
        total: number | string;
        customer_id?: string | null;
        customer_name?: string | null;
      };

      let data: PlRow[] = [];
      if (usesByCustomerView) {
        let q = ctx.db
          .from("financial_pl_by_customer_summary")
          .select("month, category, category_type, total, customer_id, customer_name")
          .eq("company_id", ctx.companyId)
          .gte("month", from_date)
          .lte("month", to_date)
          .order("month", { ascending: false })
          .order("category_type")
          .order("category");
        if (customer_id) q = q.eq("customer_id", customer_id);
        const { data: byCustData, error: byCustErr } = await q;
        if (byCustErr) throw new Error(`Failed to get P&L report: ${byCustErr.message}`);
        data = (byCustData ?? []) as PlRow[];
      } else {
        const { data: catData, error: catErr } = await ctx.db
          .from("financial_pl_summary")
          .select("month, category, category_type, total")
          .eq("company_id", ctx.companyId)
          .gte("month", from_date)
          .lte("month", to_date)
          .order("month", { ascending: false })
          .order("category_type")
          .order("category");
        if (catErr) throw new Error(`Failed to get P&L report: ${catErr.message}`);
        data = (catData ?? []) as PlRow[];
      }

      const income = data
        .filter((r) => r.category_type === "income")
        .reduce((s, r) => s + Number(r.total), 0);
      const expenses = data
        .filter((r) => r.category_type === "expense")
        .reduce((s, r) => s + Math.abs(Number(r.total)), 0);

      // Build by_customer rollup when grouping was requested. Always include
      // an "Unattributed" line for null customer_id rows so the rollup
      // reconciles to total_income / total_expenses.
      const byCustomer = group_by_customer
        ? rollupByCustomer(data)
        : undefined;

      // Build tier_3 markdown fallback
      const catTotals: Record<string, { type: string; total: number }> = {};
      for (const r of data) {
        if (!catTotals[r.category]) catTotals[r.category] = { type: r.category_type, total: 0 };
        catTotals[r.category].total += r.category_type === "expense" ? Math.abs(Number(r.total)) : Number(r.total);
      }
      const fmt = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
      const customerMarkdown = byCustomer && byCustomer.length > 0
        ? `\n\n| Customer | Income | Expenses | Net |\n|----------|-------:|---------:|----:|\n` +
          byCustomer
            .map((c) => `| ${c.customer_name} | ${fmt(c.total_income)} | ${fmt(c.total_expenses)} | ${fmt(c.net)} |`)
            .join("\n")
        : "";
      const headerLabel = customer_id ? ` (customer scoped)` : "";
      const markdownTable =
        `**P&L: ${from_date} to ${to_date}${headerLabel}**\n\n` +
        `| Category | Type | Amount |\n|----------|------|--------|\n` +
        Object.entries(catTotals)
          .map(([cat, { type, total }]) => `| ${cat} | ${type} | ${fmt(total)} |`)
          .join("\n") +
        `\n\n**Income:** ${fmt(income)} | **Expenses:** ${fmt(expenses)} | **Net:** ${fmt(income - expenses)}` +
        customerMarkdown;

      const tier1Scope = byCustomer
        ? "render `by_category` as a P&L statement grouped by category_type " +
          "(income section, then expense section), with category line items. " +
          "Then render `by_customer` as a second section: per-customer rows with " +
          "income, expenses, and net columns, sorted by income descending. " +
          "Pin the 'Unattributed' row to the bottom of that section. " +
          "Show the totals (total_income, total_expenses, net) at the very bottom."
        : "render `by_category` as a P&L statement grouped by category_type " +
          "(income section, then expense section), with category line items. " +
          "Show the totals (total_income, total_expenses, net) at the bottom.";

      return {
        from_date,
        to_date,
        net: income - expenses,
        total_income: income,
        total_expenses: expenses,
        by_category: data,
        ...(byCustomer ? { by_customer: byCustomer } : {}),
        ...(customer_id ? { customer_id } : {}),
        render: {
          tier_1: {
            format_hint: "table",
            instructions: {
              scope: tier1Scope,
              format:
                "two sections (income then expenses) with right-aligned amount " +
                "column; income tinted positive, expenses tinted red per the " +
                "standard color conventions. Net total in bold beneath.",
              forbidden:
                "do not omit the net total (it is the headline); do not interleave " +
                "income and expense categories.",
            },
          },
          tier_3: {
            markdown: markdownTable,
          },
          do_not: [
            "Do not invent new color meanings; use the standard color conventions.",
          ],
        } satisfies Render,
      };
    },
  },

  remove_transaction: {
    title: "Remove Transaction",
    description:
      "Remove a transaction by archiving (hides from views and reports, recoverable) or permanently " +
      "deleting (reverses the balance effect). On first call, returns a `conflict` with confirm / archive / cancel. " +
      "If the transaction is one leg of a transfer, confirming the deletion removes both legs together " +
      "to keep the books balanced.",
    parameters: z.object({
      transaction_id: z
        .string()
        .uuid()
        .describe("UUID of the transaction to remove."),
      ...removeResolutionParams,
      force_mode: z
        .enum(["delete_both"])
        .optional()
        .describe(
          "Deprecated: confirming a transfer-leg deletion now deletes both legs " +
          "automatically. 'delete_both' is still accepted."
        ),
    }),
    handler: async (ctx: ToolContext, { transaction_id, mode, force_mode, resolution }: {
      transaction_id: string;
      mode?: RemoveMode;
      force_mode?: "delete_both";
      resolution?: RemoveResolution;
    }) => {
      const access = await getFinancialAccess(ctx);
      if (access !== "write") return financialPermissionError("write");

      // Fetch the transaction
      const { data: tx, error: txErr } = await ctx.db
        .from("financial_transactions")
        .select("id, description, amount, transfer_to_account_id, account_id, date, company_id")
        .eq("id", transaction_id)
        .eq("company_id", ctx.companyId)
        .is("deleted_at", null)
        .single();

      if (txErr) throw new Error(`Transaction not found: ${txErr.message}`);

      // Confirming deletion of a transfer leg deletes both legs together
      // (double-entry). resolution: "confirm" / legacy mode "delete" / force_mode
      // all drive this; no separate "delete both?" step is needed.
      const wantsDelete = resolution === "confirm" || mode === "delete";
      const deleteBoth =
        force_mode === "delete_both" || (wantsDelete && !!tx.transfer_to_account_id);

      return handleRemove({
        ctx,
        entity_type: "financial_transaction",
        entity_id: transaction_id,
        entity_label: `${tx.description} ($${Math.abs(Number(tx.amount)).toFixed(2)})`,
        scope: "org",
        company_id: tx.company_id,
        mode,
        resolution,
        delete_warning: tx.transfer_to_account_id
          ? "This is one leg of a transfer; both legs will be deleted together to keep the books balanced."
          : undefined,
        before_state: {
          date: tx.date,
          description: tx.description,
          amount: tx.amount,
          account_id: tx.account_id,
          transfer_to_account_id: tx.transfer_to_account_id,
        },
        archiveFn: async () => {
          const { data, error } = await ctx.db
            .from("financial_transactions")
            .update({ archived: true })
            .eq("id", transaction_id)
            .eq("company_id", ctx.companyId)
            .select()
            .single();
          if (error) throw new Error(`Failed to archive transaction: ${error.message}`);
          return data;
        },
        deleteFn: async () => {
          // Soft-delete this transaction (reverses balance via RPC)
          const { error } = await ctx.db.rpc("soft_delete_financial_transaction", {
            p_company_id: ctx.companyId,
            p_transaction_id: transaction_id,
          });
          if (error) throw new Error(`Failed to delete transaction: ${error.message}`);

          // If delete_both, also soft-delete the paired transfer leg
          if (deleteBoth && tx.transfer_to_account_id) {
            const { data: paired } = await ctx.db
              .from("financial_transactions")
              .select("id, date, description, amount, account_id")
              .eq("company_id", ctx.companyId)
              .eq("transfer_to_account_id", tx.account_id)
              .eq("account_id", tx.transfer_to_account_id)
              .eq("date", tx.date)
              .neq("id", transaction_id)
              .is("deleted_at", null)
              .limit(1)
              .single();

            if (paired) {
              const { error: pairErr } = await ctx.db.rpc("soft_delete_financial_transaction", {
                p_company_id: ctx.companyId,
                p_transaction_id: paired.id,
              });
              if (pairErr) {
                const manualAction = `The paired transfer leg still needs to be deleted manually to restore correct balances.`;
                const incidentMarkdown =
                  `**Paired transaction did not delete cleanly**\n\n` +
                  `The primary transaction was deleted, but its paired transfer leg ` +
                  `could not be removed. Account balances will be inconsistent until ` +
                  `the pair is cleared.\n\n` +
                  `**What happened:** ${pairErr.message}\n\n` +
                  `**You will need to:** ${manualAction}`;
                const render: Render = {
                  tier_1: {
                    format_hint: "incident",
                    instructions: {
                      scope:
                        "show that the primary delete succeeded but its paired " +
                        "transfer leg did not. Lead with the manual action; show " +
                        "the error message so the user can understand what went wrong.",
                      format:
                        "danger / red header per the standard color conventions; the " +
                        "manual action is the prominent call-to-action; the error " +
                        "message appears as plain prose beneath.",
                      forbidden:
                        "do not bury the manual action - balances are inconsistent " +
                        "until the user acts; do not paraphrase the error message.",
                    },
                  },
                  tier_3: {
                    markdown: incidentMarkdown,
                  },
                  do_not: [
                    "Do not invent new color meanings; use the standard color conventions.",
                  ],
                };
                return {
                  partial_failure: true,
                  deleted_id: transaction_id,
                  paired_delete_error: pairErr.message,
                  manual_action_required: manualAction,
                  render,
                };
              }
              await writeAuditLog(ctx, {
                action: "delete_financial_transaction",
                entity_type: "financial_transaction",
                entity_id: paired.id,
                before_state: {
                  date: (paired as { date: string }).date,
                  description: (paired as { description: string }).description,
                  amount: (paired as { amount: number }).amount,
                  account_id: (paired as { account_id: string }).account_id,
                },
                metadata: { paired_with: transaction_id, force_mode: "delete_both" },
              });
            }
          }
        },
      });
    },
  },

  get_financial_summary: {
    title: "Get Financial Summary",
    description:
      "Return a snapshot of the company's financial position: total assets across all accounts, " +
      "plus year-to-date income and expenses. " +
      "Response includes a render field with tiered rendering guidance - check it before composing your reply.",
    parameters: z.object({
      timezone: z
        .string()
        .optional()
        .describe(
          "IANA timezone string (e.g. 'America/New_York'). When provided, the YTD start " +
          "is computed in the user's local timezone rather than UTC. Affects ytdStart."
        ),
    }),
    handler: async (ctx: ToolContext, { timezone }: { timezone?: string }) => {
      const access = await getFinancialAccess(ctx);
      if (access === "none") return financialPermissionError("read");

      // Use the caller's timezone when provided so YTD reflects local Jan 1,
      // not the server's UTC year. Falls back to getUTCFullYear() when no
      // timezone is supplied to avoid server-local timezone skew.
      const currentYear = timezone
        ? parseInt(getLocalDateStr(timezone).slice(0, 4), 10)
        : new Date().getUTCFullYear();
      const ytdStart = `${currentYear}-01-01`;

      const [accountsResult, plResult] = await Promise.all([
        ctx.db
          .from("financial_accounts")
          .select("name, balance")
          .eq("company_id", ctx.companyId)
          .eq("archived", false)
          .is("deleted_at", null),
        ctx.db
          .from("financial_pl_summary")
          .select("category_type, total")
          .eq("company_id", ctx.companyId)
          .gte("month", ytdStart),
      ]);

      if (accountsResult.error)
        throw new Error(`Failed to fetch accounts: ${accountsResult.error.message}`);
      if (plResult.error)
        throw new Error(`Failed to fetch P&L: ${plResult.error.message}`);

      const totalAssets = (accountsResult.data ?? []).reduce(
        (s, a) => s + Number(a.balance),
        0
      );
      const ytdIncome = (plResult.data ?? [])
        .filter((r) => r.category_type === "income")
        .reduce((s, r) => s + Number(r.total), 0);
      const ytdExpenses = (plResult.data ?? [])
        .filter((r) => r.category_type === "expense")
        .reduce((s, r) => s + Math.abs(Number(r.total)), 0);

      // Build tier_3 markdown fallback
      const accts = (accountsResult.data ?? []) as { name: string; balance: number }[];
      const fmtUsd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
      const summaryTable =
        `**Financial Snapshot**\n\n` +
        `| Account | Balance |\n|---------|--------:|\n` +
        accts.map((a) => `| ${a.name} | ${fmtUsd(Number(a.balance))} |`).join("\n") +
        `\n\n**Total Assets:** ${fmtUsd(totalAssets)}\n\n` +
        `**YTD Income:** ${fmtUsd(ytdIncome)} | **YTD Expenses:** ${fmtUsd(ytdExpenses)} | **YTD Net:** ${fmtUsd(ytdIncome - ytdExpenses)}`;

      return {
        company_id: ctx.companyId,
        total_assets: totalAssets,
        accounts: accountsResult.data,
        ytd_income: ytdIncome,
        ytd_expenses: ytdExpenses,
        ytd_net: ytdIncome - ytdExpenses,
        render: {
          tier_1: {
            format_hint: "metric_cards",
            instructions: {
              scope:
                "show four headline numbers prominently (total_assets, " +
                "ytd_income, ytd_expenses, ytd_net), then an account balance list.",
              format:
                "headline numbers at the top in bold, currency-formatted; " +
                "account balance list beneath. Color ytd_net positive when >= 0, " +
                "red when negative, per the standard color conventions.",
              forbidden:
                "do not bury ytd_net (it is the headline); do not omit the " +
                "per-account balance list.",
            },
          },
          tier_3: {
            markdown: summaryTable,
          },
          do_not: [
            "Do not invent new color meanings; use the standard color conventions.",
          ],
        } satisfies Render,
      };
    },
  },

  remove_account: {
    title: "Remove Account",
    description:
      "Remove a financial account by archiving (hides from active views, recoverable) or " +
      "permanently deleting. On first call, returns a `conflict` with ARCHIVE / DELETE / CANCEL. " +
      "Accounts with active (non-deleted) transactions cannot be deleted - the delete " +
      "option becomes available once the account has no live transactions.",
    parameters: z.object({
      account_id: z.string().uuid().describe("Account UUID to remove."),
      ...removeResolutionParams,
    }),
    handler: async (ctx: ToolContext, { account_id, mode, resolution }: { account_id: string; mode?: RemoveMode; resolution?: RemoveResolution }) => {
      const access = await getFinancialAccess(ctx);
      if (access !== "write") return financialPermissionError("write");

      const { data: account, error: fetchErr } = await ctx.db
        .from("financial_accounts")
        .select("id, name, balance, archived, company_id")
        .eq("id", account_id)
        .eq("company_id", ctx.companyId)
        .is("deleted_at", null)
        .single();

      if (fetchErr) throw new Error(`Account not found: ${fetchErr.message}`);

      // Count LIVE (non-soft-deleted) transactions only. This is a soft-delete,
      // so soft-deleted children don't threaten referential integrity and must
      // not block removal - otherwise a leftover soft-deleted transaction wedges
      // the account in the archived state permanently.
      const { count: txCount } = await ctx.db
        .from("financial_transactions")
        .select("id", { count: "exact", head: true })
        .eq("account_id", account_id)
        .is("deleted_at", null);

      const linked_data: Record<string, number> = {};
      if ((txCount ?? 0) > 0) linked_data["transaction(s)"] = txCount!;

      // Block hard delete if transactions exist (FK constraint)
      const hasTx = (txCount ?? 0) > 0;
      const deleteWarning = hasTx
        ? "This account has transactions and cannot be permanently deleted. Use archive instead."
        : "The account and its balance will be permanently removed.";

      return handleRemove({
        ctx,
        entity_type: "financial_account",
        entity_id: account_id,
        entity_label: account.name,
        scope: "org",
        company_id: account.company_id,
        mode,
        resolution,
        linked_data,
        delete_warning: deleteWarning,
        before_state: { name: account.name, balance: Number(account.balance), archived: account.archived },
        archiveFn: async () => {
          const { data, error } = await ctx.db
            .from("financial_accounts")
            .update({ archived: true })
            .eq("id", account_id)
            .eq("company_id", ctx.companyId)
            .select()
            .single();
          if (error) throw new Error(`Failed to archive account: ${error.message}`);
          return data;
        },
        deleteFn: async () => {
          if (hasTx) {
            throw new Error(
              `Account "${account.name}" has ${txCount} active transaction(s) and cannot be deleted. ` +
              `Use archive instead, or delete all transactions first.`
            );
          }
          const { data, error } = await ctx.db
            .from("financial_accounts")
            .update({ deleted_at: new Date().toISOString() })
            .eq("id", account_id)
            .eq("company_id", ctx.companyId)
            .select()
            .single();
          if (error) throw new Error(`Failed to delete account: ${error.message}`);
          return data;
        },
      });
    },
  },

  remove_category: {
    title: "Remove Category",
    description:
      "Remove a financial category by archiving (hides from active views, recoverable) or " +
      "permanently deleting. On first call, returns a `conflict` with ARCHIVE / DELETE / CANCEL. " +
      "Categories with active (non-deleted) transactions cannot be deleted.",
    parameters: z.object({
      category_id: z.string().uuid().describe("Category UUID to remove."),
      ...removeResolutionParams,
    }),
    handler: async (ctx: ToolContext, { category_id, mode, resolution }: { category_id: string; mode?: RemoveMode; resolution?: RemoveResolution }) => {
      const access = await getFinancialAccess(ctx);
      if (access !== "write") return financialPermissionError("write");

      const { data: category, error: fetchErr } = await ctx.db
        .from("financial_categories")
        .select("id, name, type, archived, company_id")
        .eq("id", category_id)
        .eq("company_id", ctx.companyId)
        .is("deleted_at", null)
        .single();

      if (fetchErr) throw new Error(`Category not found: ${fetchErr.message}`);

      // Count LIVE (non-soft-deleted) transactions only. Soft-deleted children
      // must not block removal (see remove_account for the rationale).
      const { count: txCount } = await ctx.db
        .from("financial_transactions")
        .select("id", { count: "exact", head: true })
        .eq("category_id", category_id)
        .is("deleted_at", null);

      const linked_data: Record<string, number> = {};
      if ((txCount ?? 0) > 0) linked_data["transaction(s)"] = txCount!;

      const hasTx = (txCount ?? 0) > 0;
      const deleteWarning = hasTx
        ? "This category has transactions and cannot be permanently deleted. Use archive instead."
        : "The category will be permanently removed.";

      return handleRemove({
        ctx,
        entity_type: "financial_category",
        entity_id: category_id,
        entity_label: `${category.name} (${category.type})`,
        scope: "org",
        company_id: category.company_id,
        mode,
        resolution,
        linked_data,
        delete_warning: deleteWarning,
        before_state: { name: category.name, type: category.type, archived: category.archived },
        archiveFn: async () => {
          const { data, error } = await ctx.db
            .from("financial_categories")
            .update({ archived: true })
            .eq("id", category_id)
            .eq("company_id", ctx.companyId)
            .select()
            .single();
          if (error) throw new Error(`Failed to archive category: ${error.message}`);
          return data;
        },
        deleteFn: async () => {
          if (hasTx) {
            throw new Error(
              `Category "${category.name}" has ${txCount} active transaction(s) and cannot be deleted. ` +
              `Use archive instead, or reassign transactions to another category first.`
            );
          }
          const { data, error } = await ctx.db
            .from("financial_categories")
            .update({ deleted_at: new Date().toISOString() })
            .eq("id", category_id)
            .eq("company_id", ctx.companyId)
            .select()
            .single();
          if (error) throw new Error(`Failed to delete category: ${error.message}`);
          return data;
        },
      });
    },
  },
};

export function registerFinancialTools(server: McpServer, ctx: ToolContext): void {
  registerToolMap(server, financialTools, ctx);
}
