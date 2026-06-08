---
category: domain
---

# Financial Tools Walkthrough - Interactive Demo

> **What is this?** A guided walkthrough of the financial tools in Founders OS.
> The demo covers the complete bookkeeping workflow: setting up accounts and
> categories, recording income and expenses, attributing payments to clients,
> transferring between accounts, running a profit and loss (P&L) report, and
> pulling a financial snapshot. Every step uses a fictional freelance consultant
> scenario - nothing touches real money or real records.
>
> **Who is this for?** Anyone evaluating the financial capabilities of Founders OS
> or learning how to use the bookkeeping tools for the first time.
>
> **How to use it:** Tell your AI agent: *"Read the financial tools demo and
> walk me through it."* The agent will guide you step by step, pausing after
> each section for you to continue.

---

## Prerequisites

- **Founders OS v0.12.0 or later.** This demo uses `set_transaction_customer`,
  the `customer_id` filter on `list_transactions`, and the `group_by_customer`
  option on `get_pl_report` - all introduced in v0.12.0. Before starting, call
  `get_version` and confirm the running version is 0.12.0 or higher. If it's
  older, stop and ask the user to update the server.

---

## How to Run This Demo

**Follow all rules in [DEMO_RULES.md](DEMO_RULES.md)** (in this directory),
plus these demo-specific rules:

- **Demo key:** `financial` (run tag is `demorun-financial-<run_id>`; see Run isolation in DEMO_RULES.md)
- **Minimum version:** 0.12.0
- **Keep real data safe.** Every demo account, category, and transaction
  carries the `demorun-financial-<run_id>` tag. Account and category names are
  also suffixed with ` (demo <run_id>)`. Check for existing categories and
  accounts first so you don't collide with real data. Never modify existing
  accounts or categories.
- **Tag-based cleanup.** Accounts, categories, and transactions all support
  tags, so this demo tags every record it creates with `demorun-financial-<run_id>`.
  Cleanup sweeps by that tag plus the tracked IDs, and deletes the tag last
  with `cascade: true`. The ` (demo <run_id>)` name suffix is a secondary
  safety net. Key cleanup strictly on the tag and tracked IDs, never on a
  partial name.

---

## Scenario: Freelance Consultant Month-End Close

Alex Rivera is a freelance UX consultant closing out April 2026. Alex does
client work, pays for a few software tools, and moves a portion of each
payment into a tax reserve account. You are walking through one month of
Alex's bookkeeping end-to-end.

---

## Phase 0: Setup

### 0-intro. Orientation

Before touching any data, give the user a short orientation:

> "We're going to walk through the complete financial workflow in Founders OS -
> accounts, categories, transactions, customer attribution, transfers, and
> reports. I'll play the role of Alex Rivera, a freelance UX consultant
> closing out April 2026. Everything we create is tagged for this run (and
> the account and category names are suffixed so they can't collide with
> anything else) so it won't interfere with any real data. At the end, we'll
> clean it all up."

After the verbal orientation, present a small visual showing how the workflow
unfolds - a simple numbered list of the steps:

1. **Accounts** - Set up where the money lives
2. **Categories** - Label income and expenses
3. **Transactions** - Record a month of activity, then attribute a payment to a client
4. **Transfers** - Move money and set aside taxes
5. **Fix a Mistake** - Correct an entry the safe way
6. **Snapshot** - See total assets and year-to-date numbers
7. **P&L Report** - Break the month down by category and by customer

Don't explain each one in detail. Let the list set expectations and move on.

Then proceed to setup.

### 0a. Mint the run id

Mint a `run_id` for this run as described in Run isolation (DEMO_RULES.md):
8 characters, lowercase base36, random (for example `k3p9zq4m`). Hold it in
context - every fixture and every cleanup step below uses it.

### 0b. Create the run tag

Create the cleanup tag first so every account, category, and transaction can
carry it:

```
Tool: create_tag
Params: {
  name: "demorun-financial-<run_id>",
  description: "Ephemeral Financial demo run tag"
}
```

Save as `tag_demo_id`. Everything created below is tagged
`demorun-financial-<run_id>` so cleanup can find it with a tag sweep.

### 0c. Check what already exists

Before creating anything, get a lay of the land:

```
Tool: list_accounts
Params: {}

Tool: list_categories
Params: {}
```

Note the existing accounts and categories. Use these results to avoid name
collisions and to confirm you're working in the right context. Mention to
the user how many accounts and categories currently exist - this shows the
tool working against live data, not a blank slate.

### 0d. Confirm setup

Tell the user:

> "I can see [N] existing accounts and [M] categories. I'll now create two
> demo accounts and three demo categories on top of that - all tagged for this
> run and suffixed so they're easy to find and clean up. Ready? Say 'next' to
> continue."

---

## Phase 1: Accounts

**What to tell the user:**

> "Before you can record a transaction, you need an account to put it in.
> Accounts in Founders OS represent capital pools - a bank account, a credit
> card, a petty cash envelope. Let me set up Alex's two accounts."

### 1a. Create the main checking account

```
Tool: add_account
Params: {
  name: "Demo: Main Checking (demo <run_id>)",
  initial_balance: 3200,
  tags: ["demorun-financial-<run_id>"]
}
```

Save as `checking_id`. This represents Alex's primary business checking
account. It starts with a $3,200 balance already in it from prior months.

### 1b. Create the tax reserve account

```
Tool: add_account
Params: {
  name: "Demo: Tax Reserve (demo <run_id>)",
  initial_balance: 850,
  tags: ["demorun-financial-<run_id>"]
}
```

Save as `tax_reserve_id`. Alex has already set aside $850 earlier in the
year. Every time a client pays, 25% goes here.

### 1c. Confirm

```
Tool: list_accounts
Params: {}
```

Show the updated account list to the user. Point out that balances are
tracked automatically - every transaction will adjust these in real time.

**Pause here.** Explain what you set up, then wait for the user to continue.

---

## Phase 2: Categories

**What to tell the user:**

> "Categories are how you classify your money flows. An income category marks
> something as revenue. An expense category marks it as a cost. The sign of
> a transaction is applied automatically based on which type of category you
> assign - you just enter the amount as a positive number."

### 2a. Add an income category

```
Tool: add_category
Params: { name: "Demo: Client Work (demo <run_id>)", type: "income", tags: ["demorun-financial-<run_id>"] }
```

Save as `cat_client_work_id`.

### 2b. Add expense categories

```
Tool: add_category
Params: { name: "Demo: Software Subscriptions (demo <run_id>)", type: "expense", tags: ["demorun-financial-<run_id>"] }
```

Save as `cat_software_id`.

```
Tool: add_category
Params: { name: "Demo: Meals & Entertainment (demo <run_id>)", type: "expense", tags: ["demorun-financial-<run_id>"] }
```

Save as `cat_meals_id`.

### 2c. Confirm

```
Tool: list_categories
Params: { type: "income" }

Tool: list_categories
Params: { type: "expense" }
```

Show the user the categorized breakdown. Note that the filter parameter lets
you see income and expense categories separately - useful when you have a long
list.

**Pause here.** Explain that categories are reusable across all transactions.
Wait for the user to continue.

---

## Phase 3: Recording Transactions

**What to tell the user:**

> "With accounts and categories in place, let's record April's activity.
> Alex had three client payments come in, paid for a couple of software tools,
> and had a team lunch. I'll enter them one by one - notice how each one
> updates the account balance automatically."

### 3a. Client invoice - Prism Analytics (April 5)

```
Tool: add_transaction
Params: {
  date: "2026-04-05",
  description: "Invoice #2041 - Prism Analytics UX audit",
  amount: 4800,
  category_id: <cat_client_work_id>,
  account_id: <checking_id>,
  tags: ["demorun-financial-<run_id>"]
}
```

Save as `tx1_id`. This is Alex's first payment of the month.

### 3b. Client invoice - Volta Mobility (April 12)

```
Tool: add_transaction
Params: {
  date: "2026-04-12",
  description: "Invoice #2042 - Volta Mobility dashboard redesign",
  amount: 3200,
  category_id: <cat_client_work_id>,
  account_id: <checking_id>,
  tags: ["demorun-financial-<run_id>"]
}
```

Save as `tx2_id`.

### 3c. Client invoice - Meridian Health (April 22)

```
Tool: add_transaction
Params: {
  date: "2026-04-22",
  description: "Invoice #2043 - Meridian Health mobile flows",
  amount: 2600,
  category_id: <cat_client_work_id>,
  account_id: <checking_id>,
  tags: ["demorun-financial-<run_id>"]
}
```

Save as `tx3_id`.

### 3d. Software subscription - Figma (April 1)

```
Tool: add_transaction
Params: {
  date: "2026-04-01",
  description: "Figma Professional - April",
  amount: 45,
  category_id: <cat_software_id>,
  account_id: <checking_id>,
  tags: ["demorun-financial-<run_id>"]
}
```

Save as `tx4_id`.

### 3e. Software subscription - Linear (April 1)

```
Tool: add_transaction
Params: {
  date: "2026-04-01",
  description: "Linear Team Plan - April",
  amount: 32,
  category_id: <cat_software_id>,
  account_id: <checking_id>,
  tags: ["demorun-financial-<run_id>"]
}
```

Save as `tx5_id`.

### 3f. Meals - Team lunch (April 18)

```
Tool: add_transaction
Params: {
  date: "2026-04-18",
  description: "Lunch with Prism Analytics team - project kickoff",
  amount: 127,
  category_id: <cat_meals_id>,
  account_id: <checking_id>,
  tags: ["demorun-financial-<run_id>"]
}
```

Save as `tx6_id`.

### 3g. Review what was recorded

```
Tool: list_transactions
Params: {
  from_date: "2026-04-01",
  to_date: "2026-04-30",
  account_id: <checking_id>
}
```

Show the user the full April transaction list. Point out:
- Income entries show as positive amounts
- Expense entries show as negative amounts
- The account balance in `list_accounts` reflects all of these

**Pause here.** Give the running balance picture - Alex started April with
$3,200, brought in $10,600 from three clients, and spent $204 on tools and
a lunch. Wait for the user to continue.

### 3h. Attribute a payment to a client

**What to tell the user:**

> "The Meridian invoice was logged with a description, but nothing in the
> system actually links it to Meridian as a customer. That's fine for the
> ledger, but it means a revenue-by-customer view wouldn't see it. Let's
> fix that. First we'll add Meridian as a customer record, then attach the
> payment we already logged."

Create the customer:

```
Tool: add_customer
Params: {
  organization_name: "Meridian Health (demo <run_id>)",
  customer_type: "client",
  customer_phase: "customer",
  tags: ["demorun-financial-<run_id>"],
  notes: "Demo client used to show transaction-to-customer attribution."
}
```

Save as `customer_meridian_id`.

### 3i. Attach the Meridian invoice to the customer record

```
Tool: set_transaction_customer
Params: {
  transaction_id: <tx3_id>,
  customer_id: <customer_meridian_id>
}
```

The response returns the updated transaction with `customer_id` populated. Tell
the user:

> "Same money, same date, same description - but now the system knows this
> $2,600 came from Meridian specifically. If we'd remembered when we logged
> the invoice, we could have passed `customer_id` directly on `add_transaction`
> and skipped this step entirely. `set_transaction_customer` is the recovery
> path for transactions already on the books, and the same call clears the
> attribution if you pass `customer_id: null`."

### 3j. List transactions filtered by customer

```
Tool: list_transactions
Params: {
  customer_id: <customer_meridian_id>,
  from_date: "2026-04-01",
  to_date: "2026-04-30"
}
```

Only the Meridian invoice comes back. Explain:

> "This filter is the foundation for revenue-by-customer reporting. With
> `customer_id` on the transaction, anything that needs to know 'how much did
> we earn from this client' has a direct path to that answer - no joining
> through tasks or descriptions."

**Pause here.** Wait for the user to continue.

---

## Phase 4: Transfers

**What to tell the user:**

> "Alex sets aside 25% of every client payment for taxes. With $10,600 in
> client income this month, that's $2,650 moving from Main Checking to
> Tax Reserve. Transfers use a special tool that creates two linked
> transactions - money out of one account, money into the other - and marks
> both as excluded from P&L so they don't inflate income or expenses."

### 4a. Check for an existing Transfer category

```
Tool: list_categories
Params: {}
```

Look for an existing category named "Demo: Transfer (demo <run_id>)" from this
run. If one exists, use it. Otherwise create one:

```
Tool: add_category
Params: { name: "Demo: Transfer (demo <run_id>)", type: "expense", tags: ["demorun-financial-<run_id>"] }
```

Save as `cat_transfer_id`. Note: the category type doesn't matter much for
transfers since both legs are `exclude_from_reports: true`.

### 4b. Execute the transfer

```
Tool: transfer_between_accounts
Params: {
  date: "2026-04-30",
  description: "April tax reserve allocation (25% of $10,600)",
  amount: 2650,
  from_account_id: <checking_id>,
  to_account_id: <tax_reserve_id>,
  category_id: <cat_transfer_id>
}
```

Save the returned `outflow.id` as `transfer_out_id` and `inflow.id` as
`transfer_in_id`.

### 4c. Verify the balances shifted

```
Tool: list_accounts
Params: {}
```

Show the updated balances. Main Checking should now be $2,650 lower, and
Tax Reserve should be $2,650 higher. Explain that these moved together in
one call - no risk of one side succeeding and the other failing without
a recovery path.

**Pause here.** Explain the double-entry model briefly: every transfer is two
entries, and they're always deleted as a pair if you need to remove them.
Wait for the user to continue.

---

## Phase 5: Correcting a Mistake

**What to tell the user:**

> "Alex just realized the Figma subscription was $45 but the actual charge was
> $48 - the price changed. Let's delete the incorrect entry and re-enter it
> with the right amount. This is the standard correction flow."

### 5a. Delete the incorrect Figma transaction

```
Tool: remove_transaction
Params: { transaction_id: <tx4_id> }
```

This is a standalone transaction (not a transfer), so pick Delete when prompted.
The balance adjusts automatically.

### 5b. Re-enter with the correct amount

```
Tool: add_transaction
Params: {
  date: "2026-04-01",
  description: "Figma Professional - April (corrected)",
  amount: 48,
  category_id: <cat_software_id>,
  account_id: <checking_id>,
  tags: ["demorun-financial-<run_id>"]
}
```

Save as `tx4b_id`. Point out that the balance reflects the corrected $48,
not the original $45.

### 5c. What happens with a transfer deletion

Show the user what the system does differently for transfers. Attempt to
delete one leg of the April tax transfer:

```
Tool: remove_transaction
Params: { transaction_id: <transfer_out_id> }
```

The system returns a `conflict` response with type `destructive_action`. The
delete warning notes this is one leg of a transfer and that confirming will
remove both legs together. Present the options naturally, then pick "Cancel" -
we don't want to actually delete the transfer at this point.

Explain:

> "See how it flagged that? Transfers are paired - deleting one side would
> leave the books unbalanced. So confirming the deletion removes both legs
> together; there's no way to delete just one. This follows double-entry
> bookkeeping rules. We'll cancel here since we want to keep the transfer."

**Pause here.** Wait for the user to continue.

---

## Phase 6: Financial Snapshot

**What to tell the user:**

> "Now that April's activity is recorded, let's get the big picture. The
> financial summary shows total assets across all accounts plus year-to-date
> income and expenses in a single call."

### 6a. Pull the summary

```
Tool: get_financial_summary
Params: { timezone: "America/Chicago" }
```

Present the results conversationally. Highlight:
- `total_assets` - the sum of all active account balances
- `ytd_income` - all income transactions since January 1
- `ytd_expenses` - all expense transactions since January 1
- `ytd_net` - what's left after expenses

Point out that transfers don't appear here because they're marked
`exclude_from_reports`. Only real income and expenses show up in these
totals.

**Pause here.** Wait for the user to continue.

---

## Phase 7: P&L Report

**What to tell the user:**

> "The financial summary gives you the snapshot. The P&L report gives you
> the breakdown - revenue and costs grouped by category for whatever date
> range you choose. Let's pull April specifically."

### 7a. Pull the April P&L

```
Tool: get_pl_report
Params: {
  from_date: "2026-04-01",
  to_date: "2026-04-30"
}
```

Present the results in a readable table format:

```
April 2026 P&L

Income
  Demo: Client Work     $10,600.00

Expenses
  Demo: Software Subscriptions   $80.00   ($48 Figma + $32 Linear)
  Demo: Meals & Entertainment   $127.00

Net                    $10,393.00
```

Explain:
- Categories with no April activity don't appear in the output
- The transfer to Tax Reserve does NOT show here (it's `exclude_from_reports`)
- The corrected Figma amount ($48) appears, not the original $45

### 7b. Break the same range down by customer

**What to tell the user:**

> "Earlier we tagged the Meridian invoice to a customer record. That single
> attribution is what makes this next view possible. Let me pull the same
> April range, but ask for it grouped by client."

```
Tool: get_pl_report
Params: {
  from_date: "2026-04-01",
  to_date: "2026-04-30",
  group_by_customer: true
}
```

The response now carries a `by_customer` array alongside the existing
`by_category`. Present the customer rollup as its own table, sorted by net
descending, with "Unattributed" pinned to the bottom:

```
April 2026 P&L - By Customer

| Customer       | Income     | Expenses | Net        |
|----------------|-----------:|---------:|-----------:|
| Meridian Health|  $2,600.00 |    $0.00 |  $2,600.00 |
| Unattributed   |  $8,000.00 |  $207.00 |  $7,793.00 |

Net:  $10,393.00
```

Walk through what's there:

> "Meridian shows up on its own line because we attributed that one invoice
> to them in step 3i. Everything else - the two other client invoices, the
> software subscriptions, and the team lunch - falls into 'Unattributed'
> because no one tied those transactions to a customer record."

Point out the reconciliation property:

> "Notice that the two lines add to the same net as the by-category view
> above. The customer breakdown doesn't change the books, it just reorganizes
> them. If you attribute the Prism and Volta payments after the fact with
> `set_transaction_customer`, the next run of this report will move them
> out of 'Unattributed' into their own rows."

This is the payoff for tagging payments to clients: by-customer reporting
becomes free. Without attribution, every dollar lands in Unattributed and
the view degenerates to one row.

### 7c. Show a multi-month range (conceptual)

Tell the user:

> "You can run this for any date range - Q1, year-to-date, trailing 90 days.
> Just change the start and end dates. The output groups by category and
> month, so you can see trends across months in one call. The
> `group_by_customer` flag works the same way at every range."

No need to execute another query for this - just explain the flexibility.

---

## Summary

### What to tell the user

> "That's the full financial workflow. In a few minutes you set up accounts
> and categories, recorded income and expenses, attributed one of those
> payments to a specific client, moved money between accounts with a linked
> transfer, corrected a mistake, pulled a company-wide financial snapshot,
> and ran a P&L report broken down both by category and by customer. And
> everything you just did, you could have done by just asking naturally -
> the system figures out the rest."

### Ways to ask

Present a visual reference card organized by intent. Each row has a
short intent label and 2-3 example phrases:

**Track money in and out**
- "Log a $3,000 payment from Acme Corp"
- "Record a $49 expense for Notion"
- "What transactions happened this week?"

**Move money between accounts**
- "Transfer $500 from checking to tax reserve"
- "Move money to savings"

**Link money to a client**
- "Log a $3,000 payment from Acme for invoice #42"
- "Attribute that last payment to Northstar"
- "Show me every transaction tied to Meridian"

**Check the numbers**
- "What's my financial summary?"
- "How's my P&L looking this month?"
- "Show me expenses for April"
- "Break April's P&L down by customer"
- "How much revenue did Meridian send us this quarter?"

**Set things up**
- "Create a checking account with a $10,000 balance"
- "Add an expense category for software tools"
- "What accounts do I have?"

**Clean up mistakes**
- "Delete that last transaction"
- "Remove the duplicate expense"

**Pause here.** Ask: *"That's all the core financial tools. Ready for
cleanup? Or do you want to explore anything else first?"*

---

## Phase 8: Cleanup

Remove all demo data in the correct order. Use the IDs tracked during the
demo, and sweep by the `demorun-financial-<run_id>` tag to catch anything
created during interactive steps. Key on the tag and tracked IDs, never on a
partial name. If a record is ambiguous, report it rather than deleting it.

### 8a. Remove demo transactions

First, sweep by tag to catch any transactions created during interactive steps,
then combine the result with your tracked IDs:

```
Tool: list_transactions
Params: { tag: "demorun-financial-<run_id>" }
```

Remove all individual transactions (tracked IDs plus anything the sweep found).
Passing resolution: "confirm" skips the conflict prompt.

```
Tool: remove_transaction
Params: { transaction_id: <tx1_id>, resolution: "confirm" }

Tool: remove_transaction
Params: { transaction_id: <tx2_id>, resolution: "confirm" }

Tool: remove_transaction
Params: { transaction_id: <tx3_id>, resolution: "confirm" }

Tool: remove_transaction
Params: { transaction_id: <tx4b_id>, resolution: "confirm" }

Tool: remove_transaction
Params: { transaction_id: <tx5_id>, resolution: "confirm" }

Tool: remove_transaction
Params: { transaction_id: <tx6_id>, resolution: "confirm" }
```

### 8b. Remove the transfer

```
Tool: remove_transaction
Params: { transaction_id: <transfer_out_id>, resolution: "confirm" }
```

This deletes both legs of the April tax reserve transfer in one call.

### 8c. Verify transactions are gone

Filter to the demo accounts specifically - do NOT query without an account filter,
as the user may have real April transactions that should not be touched:

```
Tool: list_transactions
Params: {
  from_date: "2026-04-01",
  to_date: "2026-04-30",
  account_id: <checking_id>
}

Tool: list_transactions
Params: {
  from_date: "2026-04-01",
  to_date: "2026-04-30",
  account_id: <tax_reserve_id>
}
```

Both should return empty. If any demo transactions remain in either account,
delete them. If unexpected transactions appear in an account you did not
create, leave them alone - they are not demo data.

### 8d. Remove the demo accounts

Sweep by tag to confirm you've caught every demo account, then remove each by
its tracked ID:

```
Tool: list_accounts
Params: { tag: "demorun-financial-<run_id>" }
```

Now that the accounts have zero net activity (all transactions removed), remove
each one. Passing `resolution: "confirm"` resolves the archive/delete/cancel conflict
and removes the account (deletion is allowed once an account has no live
transactions):

```
Tool: remove_account
Params: { account_id: <checking_id>, resolution: "confirm" }
```

Repeat for the tax reserve:

```
Tool: remove_account
Params: { account_id: <tax_reserve_id>, resolution: "confirm" }
```

Explain to the user:

> "Accounts are soft-deleted - they're recoverable for 30 days, then
> permanently purged. In practice, archiving is usually better for accounts
> since you may want the history."

### 8e. Verify accounts are archived

```
Tool: list_accounts
Params: {}
```

Confirm the two demo accounts no longer appear in the active list.

### 8f. Remove demo categories

Sweep by tag to confirm you've caught every demo category, then remove each:

```
Tool: list_categories
Params: { tag: "demorun-financial-<run_id>" }
```

Remove the demo categories:

```
Tool: remove_category
Params: { category_id: <cat_client_work_id>, resolution: "confirm" }

Tool: remove_category
Params: { category_id: <cat_software_id>, resolution: "confirm" }

Tool: remove_category
Params: { category_id: <cat_meals_id>, resolution: "confirm" }

Tool: remove_category
Params: { category_id: <cat_transfer_id>, resolution: "confirm" }
```

### 8g. Remove the demo customer

The Meridian transaction has already been deleted in 8a, so the customer
record has no live attribution to worry about. Remove it:

```
Tool: remove_customer
Params: { customer_id: <customer_meridian_id>, resolution: "confirm" }
```

### 8h. Delete the demo tag

```
Tool: list_tags
Params: {}
```

Find the `demorun-financial-<run_id>` tag and delete it, stripping it from
anything that still carries it:

```
Tool: remove_tag
Params: { tag_id: <tag_demo_id>, resolution: "confirm", cascade: true }
```

### 8i. Confirm cleanup complete

Tell the user:

> "Cleanup complete. All demo transactions, the tax transfer, demo accounts,
> demo categories, the demo customer, and the run tag have been removed.
> None of them will appear in reports, account lists, or the CRM. All demo
> data has been cleaned up."

---

## Appendix: Key Design Principles

For those who want to understand what's happening under the hood:

**Amount sign convention**

Amounts are always entered as positive numbers. The sign is derived from the
category type - income categories produce positive entries, expense categories
produce negative entries. You never have to remember which sign means what.

**Transfers and double-entry**

A transfer creates two linked transactions with `exclude_from_reports: true`
on both legs. This means the money movement is tracked in account balances
but doesn't appear in P&L reports. Deleting one leg of a transfer removes both
legs together: confirming the deletion clears the whole transfer so balances
stay correct.

**Account archiving vs deletion**

Accounts cannot be hard-deleted once they have transaction history. The
`remove_account` tool archives the account instead - setting `archived: true`
removes it from all active views and the financial summary without breaking
historical records. Archived accounts are still visible when you pass
`include_archived: true` to `list_accounts`.

**P&L exclusions**

Transactions with `exclude_from_reports: true` are omitted from both
`get_pl_report` and the YTD figures in `get_financial_summary`. This covers
transfers (automatically set) and anything you manually mark as an owner draw
or balance adjustment.
