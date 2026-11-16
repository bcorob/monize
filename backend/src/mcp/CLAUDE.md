# MCP Server

The rules for this directory are in `docs/backend/mcp.md`; read it before adding or changing a tool, resource or prompt, or touching the transport. Three of them hold on every change here:

- **Identity is a property of the request, not of a session.** A handler reads the caller from `resolveUserContext(ctx)`; `userId` never comes from tool arguments and no tool reads a session map. The transport seeds the bearer's user itself, per request (`withUserContext`).
- **Every tool declares `title`, `description`, `inputSchema`, `outputSchema` and `annotations`**, resolves context, checks scope, runs inside try/catch and returns through `toolResult` / `safeToolError`. It is listed in both `mcp.module.ts` and `mcp-server.service.ts`.
- **An AI tool is one domain-service method with two thin adapters**, here and in `backend/src/ai/query/tool-executor.service.ts`, wired in the same PR.
- **A 2025-era session lives in one process and cannot be moved.** Do not persist or share those maps; more than one backend replica needs sticky routing on the MCP path instead (`helm/README.md`).
