# Contributing to FoundersOS

First off, thank you for taking an interest in FoundersOS. It means a lot.

## Current status: issues yes, pull requests not yet

FoundersOS is open source under the MIT license, but we are not accepting outside code contributions (pull requests) at this stage. We want the project to be stable and well documented before we open it up, and reviewing contributions well is its own commitment we are not ready to make yet. That is coming.

What helps us most right now is bug reports and feedback. Those are genuinely welcome, and we read every one.

## Reporting a bug

Please open a [GitHub issue](https://github.com/OurThinkTank/founders-os/issues) using the Bug report template. A good report includes:

- What you expected to happen and what actually happened
- Exact steps to reproduce
- The tool group involved (CRM, tasks, projects, playbooks, tags, financial, feeds, memory, surfaces, members, audit/restore, or diagnostic)
- Your FoundersOS version (ask your AI client to run get_version, or check the installed package version)
- Your Node version and which MCP client you use (Claude Desktop, Cursor, and so on)
- Your embedding provider if the issue touches memory (openai, bedrock, or ollama)

The more specific the reproduction, the faster we can help.

## Suggesting a feature

Open an issue with the Feature request template. Tell us the problem you are trying to solve first, then your proposed solution and any alternatives you considered. Problem-framed requests are easier for us to act on than solution-framed ones.

## Security issues

Please do not file security vulnerabilities as public issues. See [SECURITY.md](SECURITY.md) for how to report them privately.

## Running FoundersOS for your own use

You are welcome to clone, run, and modify FoundersOS for your own use under the MIT license. The [README](README.md) covers setup end to end: Supabase, migrations, client configuration, and environment variables. If you are reading the code, `packages/mcp-server/TOOL_PATTERNS.md` documents the conventions the tools follow.

## Code of conduct

This project follows a [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to uphold it.

Thanks again. Issue reports from people like you are what make the project better.
