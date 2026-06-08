## What this changes

<!-- One paragraph. What does this PR do and why? -->

## Type of change

- [ ] Bug fix
- [ ] New tool or feature
- [ ] Refactor (no behavior change)
- [ ] Documentation only
- [ ] Migration (schema change)

## DB query checklist

If this PR touches any Supabase queries, confirm each one:

- [ ] Every SELECT scopes to `company_id` (or is intentionally global — explain below)
- [ ] Every UPDATE and DELETE scopes to `company_id` before mutating
- [ ] Soft-deletable entities use `.is("deleted_at", null)` in all reads
- [ ] No new tool reads from a table named `transactions` — the correct table is `financial_transactions`

If any item above is intentionally skipped, explain here:

## Tests

- [ ] `npm test` passes locally
- [ ] New behavior has test coverage, or explain why it doesn't need it:

## Migrations

- [ ] No schema changes in this PR, or:
- [ ] New migration file added under `supabase/migrations/` with the next sequential number
- [ ] Migration is safe to run on a live database (non-destructive, or explained below)

## Demo / tool params

- [ ] No tool parameter names changed, or:
- [ ] `npm run test:demos` passes (guards demo tool-call params against schema drift)
- [ ] Deprecated aliases added for any renamed params (Stage 2 removal is for the next major)

## Notes for reviewers

<!-- Anything that needs extra attention, known tradeoffs, or follow-up tasks. -->
