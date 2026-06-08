# Founders OS

**Open-source MCP server for startup and small business founders.**

Founders OS gives you a complete business context - CRM, projects, tasks, finances, feeds, memory, playbooks - accessible from Claude, Cursor, or any MCP-compatible AI client. One connection, your entire business.

Built by [OurThinkTank](https://ourthinktank.com). Docs and setup wizard at [foundersmcp.com](https://foundersmcp.com). Source on [GitHub](https://github.com/OurThinkTank/founders-os).

92 tools across 12 modules: CRM, tasks, projects, playbooks, tags, financial ledger with P&L, RSS/Atom feeds, semantic memory (pgvector), cross-domain surfaces, members, audit + restore, and diagnostics.

## Quick start

You need a Supabase project, an embedding API key (OpenAI by default), and an MCP-capable AI client.

1. **Database** - the wizard at [foundersmcp.com/setup](https://foundersmcp.com/setup) hands you a ready-to-run `setup.sql` matched to your embedding provider. Run it once in your Supabase SQL Editor.

2. **Client config** - the same wizard generates this filled in, or paste it into your client's `mcp.json` by hand:

```json
{
  "mcpServers": {
    "founders-os": {
      "command": "npx",
      "args": ["-y", "@ourthinktank/founders-os@latest"],
      "env": {
        "SUPABASE_URL": "https://your-project.supabase.co",
        "SUPABASE_SECRET_KEY": "sb_secret_...",
        "FOUNDERS_OS_COMPANY_ID": "your-company",
        "FOUNDERS_OS_USER_ID": "your-name",
        "FOUNDERS_OS_TIMEZONE": "America/Los_Angeles",
        "EMBEDDING_PROVIDER": "openai",
        "EMBEDDING_MODEL": "text-embedding-3-small",
        "EMBEDDING_DIM": "1536",
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

3. **Try it** - restart your client and ask:

```
What can you do?
Catch me up
Add Acme Corp as a new prospect
Create a task to send the proposal by Friday
What's stuck or overdue?
Show me OTT's P&L for Q1
```

OpenAI, AWS Bedrock, and Ollama are supported as embedding providers. Full environment-variable reference, tool docs, and recipes: [foundersmcp.com/docs](https://foundersmcp.com/docs/getting-started/).

## Staying up to date

The `get_version` tool reports the running version, the latest published release, how to upgrade, and whether your database schema matches the server (with the exact migration files to run when it doesn't). [Set it up as a scheduled check](https://foundersmcp.com/docs/staying-up-to-date/) and forget about versions.

## License

[MIT](./LICENSE) (c) OurThinkTank
