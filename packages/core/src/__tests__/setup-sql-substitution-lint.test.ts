// ============================================================
// Founders OS - setup.sql substitution sentinel lint
// ============================================================
// The setup pages (founders-os/integrations/setup-page/index.html and
// the marketing site's src/pages/setup.astro) hand the user a ready-to-
// run setup.sql with their chosen embedding dimension substituted in.
// The substitution is a global replace of the literal "vector(1024)"
// with "vector(<dim>)".
//
// That works only because the literal "vector(1024)" still marks the two
// embedding DDL spots:
//   1. the memories.embedding column
//   2. the match_memories(query_embedding ...) parameter
// (The header comment also mentions "vector(1024)" a couple of times; the
// global replace rewrites those too, which is harmless.)
//
// This lint pins that assumption. If a future schema edit changes the
// default literal (e.g. to vector(1536)) or drops one of the two DDL
// spots, the page substitution would silently produce a wrong-dimension
// file. This test fails loudly instead.
//
// See docs/initial-dev/plan-embedding-dimension-setup.md and
// docs/initial-dev/guide-setup-page-db-sql-fetch.md.
// ============================================================

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// supabase/setup.sql is at packages/core/src/__tests__/../../../../supabase/setup.sql
const SETUP_SQL_PATH = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "supabase",
  "setup.sql"
);

const SENTINEL = "vector(1024)";

/** The same substitution the setup pages perform. Kept in lockstep. */
function sqlForDimension(raw: string, dim: number): string {
  return raw.replace(/vector\(1024\)/g, `vector(${dim})`);
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("setup.sql substitution sentinel", () => {
  const source = readFileSync(SETUP_SQL_PATH, "utf-8");

  it("marks the memories.embedding column with the substitution sentinel", () => {
    expect(
      /\bembedding\s+vector\(1024\)/.test(source),
      `Could not find "embedding vector(1024)" (the memories column). The setup ` +
        `pages replace "${SENTINEL}" to set the embedding dimension; if you changed ` +
        `the column type, update the page substitution and this test together.`
    ).toBe(true);
  });

  it("marks the match_memories query_embedding parameter with the substitution sentinel", () => {
    expect(
      /\bquery_embedding\s+vector\(1024\)/.test(source),
      `Could not find "query_embedding vector(1024)" (the match_memories parameter). ` +
        `It must stay in lockstep with the column so recall types match.`
    ).toBe(true);
  });

  it("substitutes cleanly to a non-default dimension", () => {
    const out = sqlForDimension(source, 3072);
    // Both DDL spots are converted...
    expect(/\bembedding\s+vector\(3072\)/.test(out)).toBe(true);
    expect(/\bquery_embedding\s+vector\(3072\)/.test(out)).toBe(true);
    // ...and no original sentinel is left anywhere.
    expect(countOccurrences(out, SENTINEL)).toBe(0);
  });

  it("cannot break out of the inlined <script> data island", () => {
    // The standalone page inlines this file into a <script type="text/plain">
    // block; a literal </script> in the SQL would terminate it early.
    expect(source.includes("</script>")).toBe(false);
  });

  it("contains no vector(N) literal other than the sentinel", () => {
    // If a schema edit adds e.g. a vector(1536) column while the sentinel
    // spots stay vector(1024), the page substitution rewrites only the
    // sentinels and ships a file with MIXED embedding dimensions. Every
    // dimensioned vector literal must be the sentinel so the global
    // replace converts all of them together.
    const offenders = (source.match(/vector\(\d+\)/g) ?? []).filter(
      (lit) => lit !== SENTINEL
    );
    expect(
      offenders,
      `Found vector literal(s) other than the "${SENTINEL}" sentinel: ` +
        `${offenders.join(", ")}. The setup pages globally replace only ` +
        `"${SENTINEL}"; other dimensioned literals would survive substitution ` +
        `and produce a mixed-dimension setup file. Use the sentinel (and let ` +
        `the page substitute it) or update the substitution + this lint together.`
    ).toEqual([]);
  });
});
