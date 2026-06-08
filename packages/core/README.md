# Founders OS Core

Transport-agnostic engine for [Founders OS](https://foundersmcp.com) - the open-source MCP server for startup and small business founders.

**Most users want [`@ourthinktank/founders-os`](https://www.npmjs.com/package/@ourthinktank/founders-os) instead.** That package wraps this core in a stdio MCP server that runs via `npx` in Claude, Cursor, and other MCP clients, and it's what the [setup wizard](https://foundersmcp.com/setup) configures.

Install this package directly only if you are building your own deployment surface - a hosted server, a different transport, or an embedded integration. It exposes the raw ToolMaps (CRM, tasks, projects, playbooks, tags, financial, feeds, memory, surfaces, members, restore) plus the context builder, Supabase client factory, and the rendering contract, without any transport bound.

```ts
import {
  buildContext,
  registerToolMap,
  taskTools,
  crmTools,
  // ...the other tool maps
} from "@ourthinktank/founders-os-core";
```

Versions are kept in lockstep with `@ourthinktank/founders-os`.

Docs: [foundersmcp.com](https://foundersmcp.com) - Source: [GitHub](https://github.com/OurThinkTank/founders-os)

## License

[MIT](./LICENSE) (c) OurThinkTank
