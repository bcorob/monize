import { Injectable } from "@nestjs/common";
import { McpServer } from "@modelcontextprotocol/server";
import { AccountsService } from "../../accounts/accounts.service";
import { resolveUserContext, hasScope } from "../mcp-context";

@Injectable()
export class McpAccountListResource {
  constructor(private readonly accountsService: AccountsService) {}

  register(server: McpServer) {
    server.registerResource(
      "accounts",
      "monize://accounts",
      {
        // Reference data a model reads to resolve a name to an id.
        cacheHint: { ttlMs: 60_000, cacheScope: "private" },
        title: "Accounts",
        description: "Current account list with types and balances",
      },
      async (_uri, ctx) => {
        const user = resolveUserContext(ctx);
        if (!user) {
          return {
            contents: [
              { uri: "monize://accounts", text: "Error: No user context" },
            ],
          };
        }
        if (!hasScope(user.scopes, "read")) {
          return {
            contents: [
              {
                uri: "monize://accounts",
                text: 'Error: Insufficient scope. Requires "read" scope.',
              },
            ],
          };
        }

        try {
          const [accounts, summary] = await Promise.all([
            this.accountsService.findAll(user.userId, false),
            this.accountsService.getSummary(user.userId),
          ]);

          return {
            contents: [
              {
                uri: "monize://accounts",
                mimeType: "application/json",
                text: JSON.stringify({ accounts, summary }, null, 2),
              },
            ],
          };
        } catch {
          return {
            contents: [
              {
                uri: "monize://accounts",
                text: "Error: An error occurred while loading accounts",
              },
            ],
          };
        }
      },
    );
  }
}
