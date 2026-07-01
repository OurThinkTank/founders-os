// ============================================================
// Founders OS — minimal interactive prompt
// ============================================================
// A tiny readline wrapper so init can ask a few questions. Fully bypassable:
// when stdin is not a TTY or `assumeYes` is set, every prompt returns its
// default, so init is scriptable and CI-safe. No dependency.
// ============================================================

import { createInterface } from "node:readline";

export interface Prompter {
  ask(question: string, def?: string): Promise<string>;
  confirm(question: string, def: boolean): Promise<boolean>;
  choice<T extends string>(question: string, options: { label: string; value: T }[], defIndex: number): Promise<T>;
  close(): void;
}

export function makePrompter(opts?: { assumeYes?: boolean; input?: NodeJS.ReadStream; output?: NodeJS.WriteStream }): Prompter {
  const input = opts?.input ?? process.stdin;
  const output = opts?.output ?? process.stdout;
  const nonInteractive = !!opts?.assumeYes || !input.isTTY;

  let rl: ReturnType<typeof createInterface> | null = null;
  function line(q: string): Promise<string> {
    if (!rl) rl = createInterface({ input, output });
    return new Promise((res) => rl!.question(q, (a) => res(a)));
  }

  return {
    async ask(question, def = "") {
      if (nonInteractive) return def;
      const hint = def ? ` [${def}]` : "";
      const a = (await line(`${question}${hint}: `)).trim();
      return a || def;
    },
    async confirm(question, def) {
      if (nonInteractive) return def;
      const hint = def ? "Y/n" : "y/N";
      const a = (await line(`${question} (${hint}): `)).trim().toLowerCase();
      if (!a) return def;
      return a === "y" || a === "yes";
    },
    async choice(question, options, defIndex) {
      if (nonInteractive) return options[defIndex].value;
      output.write(`${question}\n`);
      options.forEach((o, i) => output.write(`  ${i + 1}) ${o.label}${i === defIndex ? "  (default)" : ""}\n`));
      const a = (await line(`Choose [1-${options.length}]: `)).trim();
      const n = Number(a);
      if (!a || Number.isNaN(n) || n < 1 || n > options.length) return options[defIndex].value;
      return options[n - 1].value;
    },
    close() {
      rl?.close();
      rl = null;
    },
  };
}
