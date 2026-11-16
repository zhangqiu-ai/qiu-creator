# MCP adapter (placeholder)

Reserved for a thin MCP server that exposes CreatorHub import tools to AI agents.

Rules for when it is built (M1+):

- It must call `@qiu-creator/api-client` only — no direct filesystem or SQLite access — so there is a single import path into storage.
- It authenticates with a revocable, least-privilege agent token issued by the Mac server.
- No code lives here yet.
