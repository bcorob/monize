import { Injectable } from "@nestjs/common";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { emailReceiptParsersFields } from "../../ai/query/tool-input-schemas";
import { stripHtml } from "../../common/sanitization.util";
import { EmailReceiptParserToolsService } from "../../email-receipts/parsers/email-receipt-parser-tools.service";
import {
  EMAIL_RECEIPT_PARSER_TOOL_DESCRIPTION,
  EMAIL_RECEIPT_PARSER_TOOL_MAX_RECEIPTS,
} from "../../email-receipts/parsers/parser-tool.guide";
import {
  callerKey,
  resolveUserContext,
  requireScope,
  toolResult,
  toolError,
  safeToolError,
} from "../mcp-context";
import { emailReceiptParsersOutput } from "../tool-output-schemas";
import { CREATE } from "../mcp-annotations";
import { uuidString } from "./schema-fragments";

const SAVED =
  "Draft saved. It reads no email until the user approves it in Monize (Settings, Email receipts); tell them so. Do not say it was applied.";

/**
 * Write a receipt parser from stored order emails (email-receipts design
 * section 6) for an MCP agent: list the categories a parser may name, test a
 * definition on up to 25 emails, and save it as a DRAFT.
 *
 * It confirms nothing and spends none of the daily write cap, like
 * `ai_review_requests`, and for the same reason: nothing here writes the
 * ledger or anything that reads mail. A draft reads no email until the user
 * approves it in the settings screen (INV-RECEIPT-003), and that approval is
 * the confirmation; a dialog in the agent's client for a parser the person has
 * not yet seen would ask the wrong person at the wrong time. `test`,
 * `categories` and `get` need the `read` scope, `save_draft` the `write` scope.
 */
@Injectable()
export class McpEmailReceiptParserTools {
  constructor(private readonly parsers: EmailReceiptParserToolsService) {}

  register(server: McpServer) {
    server.registerTool(
      "email_receipt_parsers",
      {
        title: "Email receipt parsers",
        annotations: CREATE,
        description: EMAIL_RECEIPT_PARSER_TOOL_DESCRIPTION,
        inputSchema: emailReceiptParsersFields.extend({
          receiptIds: z
            .array(uuidString())
            .min(1)
            .max(EMAIL_RECEIPT_PARSER_TOOL_MAX_RECEIPTS)
            .optional()
            .describe("test: stored emails."),
          parserId: z.string().max(36).optional(),
          requestId: uuidString()
            .optional()
            .describe("save_draft: the claimed request."),
        }),
        outputSchema: emailReceiptParsersOutput,
      },
      async (args, ctx) => {
        const user = resolveUserContext(ctx);
        if (!user) return toolError("No user context");
        const operation = args.operation;
        const check = requireScope(
          user.scopes,
          operation === "save_draft" ? "write" : "read",
        );
        if (check.error) return check.result;

        try {
          if (operation === "categories") {
            return toolResult(await this.parsers.listCategories(user.userId));
          }

          if (operation === "get") {
            return toolResult(
              args.parserId
                ? await this.parsers.getParser(user.userId, args.parserId)
                : { parsers: await this.parsers.listParsers(user.userId) },
            );
          }

          if (operation === "test") {
            if (args.definition === undefined) {
              return toolError("definition is required.");
            }
            if (!args.receiptIds) {
              return toolError(
                `receiptIds is required: name 1 to ${EMAIL_RECEIPT_PARSER_TOOL_MAX_RECEIPTS} emails.`,
              );
            }
            return toolResult(
              await this.parsers.testDefinition(user.userId, {
                definition: args.definition,
                receiptIds: args.receiptIds,
                payeeName: stripHtml(args.payeeName),
                componentDrafts: args.componentDrafts,
              }),
            );
          }

          const caller = callerKey(ctx);
          if (args.requestId && !caller) {
            return toolError(
              "This connection cannot be identified, so a request cannot be answered for it.",
            );
          }
          if (args.definition === undefined) {
            return toolError("definition is required.");
          }
          if (!args.name?.trim()) return toolError("name is required.");
          if (!args.fromDomains) return toolError("fromDomains is required.");
          const saved = await this.parsers.saveDraft(
            user.userId,
            caller ?? "",
            {
              requestId: args.requestId,
              name: stripHtml(args.name) as string,
              fromDomains: args.fromDomains.map(
                (domain) => stripHtml(domain) as string,
              ),
              subjectContains: args.subjectContains?.map(
                (word) => stripHtml(word) as string,
              ),
              payeeName: stripHtml(args.payeeName),
              definition: args.definition,
            },
          );
          return toolResult({ ...saved, message: SAVED });
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );
  }
}
