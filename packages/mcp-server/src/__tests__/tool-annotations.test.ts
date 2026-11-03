// ============================================================
// Tests for annotations on the directly registered tools
// ============================================================
// ping, get_version, get_usage_guide, show_capabilities and
// list_demos call server.registerTool() directly instead of
// going through registerToolMap. Core covers the ToolMap tools.
// ============================================================

import { describe, it, expect } from "vitest";
import { registerDiagnosticTools } from "../tools/diagnostic.js";
import { registerMetaTools } from "../tools/meta.js";

const HINTS = [
  "readOnlyHint",
  "destructiveHint",
  "idempotentHint",
  "openWorldHint",
] as const;

type Annotations = Partial<Record<(typeof HINTS)[number], unknown>>;

function registerDirectTools() {
  const registered = new Map<string, Annotations | undefined>();
  const server = {
    registerTool(name: string, config: { annotations?: Annotations }) {
      registered.set(name, config.annotations);
    },
  };
  registerDiagnosticTools(server as never, { versionNotice: "", db: {} as never });
  registerMetaTools(server as never);
  return registered;
}

describe("direct tool annotations", () => {
  const tools = registerDirectTools();

  it("TC-DANN01: registers the five direct tools", () => {
    expect([...tools.keys()].sort()).toEqual([
      "get_usage_guide",
      "get_version",
      "list_demos",
      "ping",
      "show_capabilities",
    ]);
  });

  it("TC-DANN02: every direct tool sets all four hints as booleans", () => {
    for (const [name, annotations] of tools) {
      expect(annotations, name).toBeDefined();
      for (const hint of HINTS) {
        expect(typeof annotations![hint], `${name}.${hint}`).toBe("boolean");
      }
    }
  });

  it("TC-DANN03: every direct tool is read-only and not destructive", () => {
    for (const [name, annotations] of tools) {
      expect(annotations!.readOnlyHint, name).toBe(true);
      expect(annotations!.destructiveHint, name).toBe(false);
    }
  });

  it("TC-DANN04: get_version is not open world", () => {
    expect(tools.get("get_version")!.openWorldHint).toBe(false);
  });
});
