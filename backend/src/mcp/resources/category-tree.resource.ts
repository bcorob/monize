import { Injectable } from "@nestjs/common";
import { McpServer } from "@modelcontextprotocol/server";
import { CategoriesService } from "../../categories/categories.service";
import { resolveUserContext, hasScope } from "../mcp-context";

@Injectable()
export class McpCategoryTreeResource {
  constructor(private readonly categoriesService: CategoriesService) {}

  register(server: McpServer) {
    server.registerResource(
      "categories",
      "monize://categories",
      {
        // Reference data a model reads to resolve a name to an id.
        cacheHint: { ttlMs: 60_000, cacheScope: "private" },
        title: "Category tree",
        description: "Full category hierarchy",
      },
      async (_uri, ctx) => {
        const user = resolveUserContext(ctx);
        if (!user) {
          return {
            contents: [
              { uri: "monize://categories", text: "Error: No user context" },
            ],
          };
        }
        if (!hasScope(user.scopes, "read")) {
          return {
            contents: [
              {
                uri: "monize://categories",
                text: 'Error: Insufficient scope. Requires "read" scope.',
              },
            ],
          };
        }

        try {
          const tree = await this.categoriesService.getTree(user.userId);

          return {
            contents: [
              {
                uri: "monize://categories",
                mimeType: "application/json",
                text: JSON.stringify(tree, null, 2),
              },
            ],
          };
        } catch {
          return {
            contents: [
              {
                uri: "monize://categories",
                text: "Error: An error occurred while loading categories",
              },
            ],
          };
        }
      },
    );
  }
}
