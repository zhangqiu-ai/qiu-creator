# MCP adapter (`creatorhub mcp`)

QC-087 (read tools) and QC-088 (import and write tools). A stdio MCP server that external agents (Claude Code, Codex, Claude Desktop) start locally. Design: `docs/mcp-plan.md`; setup examples: `docs/architecture.md` (MCP section).

Rules:

- Calls `@qiu-creator/api-client` only — no direct filesystem or SQLite access. Permissions, validation and 409 conflicts are the Mac server's.
- Authenticates with a revocable agent token (`CREATORHUB_TOKEN`).
- Every `/api/v1` route is classified in `coverage.ts` (tool, excluded with a reason, or pending); `test/mcp-coverage.test.ts` fails on a new unclassified route. A tool's `access` must equal the server's `requiredAccess` for its routes.

- No tool changes a work's text (Markdown or description); inputs are strict, so unexpected fields are errors.
- Errors carry a `retry` hint (409 → retry with `details.current_revision`; reuse an idempotency key only for the same request).

Files: `define.ts` (tool definition, results, retry hints), `read-tools.ts`, `write-tools.ts`, `tools.ts` (all tools), `server.ts` (tools, resources, toolsets), `stdio.ts`, `coverage.ts`, `diff.ts`.
