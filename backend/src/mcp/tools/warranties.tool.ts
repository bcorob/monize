import { Injectable } from "@nestjs/common";
import { McpServer } from "@modelcontextprotocol/server";
import {
  LIST_WARRANTIES_DESCRIPTION,
  listWarrantiesSchema,
} from "../../ai/query/tool-input-schemas";
import { WarrantiesService } from "../../warranties/warranties.service";
import {
  resolveUserContext,
  requireScope,
  toolResult,
  toolError,
  safeToolError,
} from "../mcp-context";
import { listWarrantiesOutput } from "../tool-output-schemas";
import { READ_ONLY } from "../mcp-annotations";

/**
 * `list_warranties` (docs/specs/warranty-tracker.md decision 11): a
 * read-only adapter over `WarrantiesService.getLlmWarranties`, the method the
 * assistant's executor calls too. An MCP credential is the owner's own (an
 * MCP request never acts as a delegate), so no account scope narrows the
 * linked purchase. The MCP transport seeds no request timezone, so `today`
 * (which decides each row's status and days left) is the owner's own date in
 * their effective timezone, read per call, not the process's.
 */
@Injectable()
export class McpWarrantiesTools {
  constructor(private readonly warrantiesService: WarrantiesService) {}

  register(server: McpServer) {
    server.registerTool(
      "list_warranties",
      {
        title: "List warranties",
        annotations: READ_ONLY,
        description: LIST_WARRANTIES_DESCRIPTION,
        inputSchema: listWarrantiesSchema,
        outputSchema: listWarrantiesOutput,
      },
      async (args, ctx) => {
        const user = resolveUserContext(ctx);
        if (!user) return toolError("No user context");
        const check = requireScope(user.scopes, "read");
        if (check.error) return check.result;

        try {
          const today = await this.warrantiesService.todayForUser(user.userId);
          const data = await this.warrantiesService.getLlmWarranties(
            user.userId,
            args,
            { today },
          );
          return toolResult(data);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );
  }
}
