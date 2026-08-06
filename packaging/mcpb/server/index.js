#!/usr/bin/env node
// ============================================================
// Founders OS - MCPB entry shim
// ============================================================
// The real server is the PUBLISHED npm package, installed into
// node_modules by build.sh at bundle build time. Importing its
// dist entry runs it: that file is a bin script with a shebang
// and top-level await, so the import itself starts the stdio
// transport.
//
// Why a shim instead of pointing the manifest straight at
// node_modules/@ourthinktank/founders-os/dist/index.js:
//   - the manifest entry_point stays stable if the package ever
//     changes its internal dist layout
//   - it gives us one place to add pre-flight checks later
//
// ESM only. The package is "type": "module", so never use
// require() here; it does not exist at runtime.
//
// Nothing in this file may write to stdout. stdout is the
// JSON-RPC channel, and a stray line corrupts the protocol and
// fails Smithery's registry validation. Diagnostics go to stderr.
// ============================================================

import "@ourthinktank/founders-os/dist/index.js";
