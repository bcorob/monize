import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ScheduledTransactionsService } from "../../scheduled-transactions/scheduled-transactions.service";
import {
  UserContextResolver,
  requireScope,
  toolResult,
  toolError,
  safeToolError,
} from "../mcp-context";
import { getUpcomingBillsOutput } from "../tool-output-schemas";
import { READ_ONLY } from "../mcp-annotations";

const SCHEDULED_KIND_VALUES = [
  "bill",
  "deposit",
  "transfer",
  "investment",
  "all",
] as const;

@Injectable()
export class McpScheduledTools {
  constructor(
    private readonly scheduledService: ScheduledTransactionsService,
  ) {}

  register(server: McpServer, resolve: UserContextResolver) {
    server.registerTool(
      "list_upcoming_bills",
      {
        title: "Upcoming bills and deposits",
        annotations: READ_ONLY,
        description:
          "Get upcoming scheduled bills and deposits due within a date window. Each item is classified as bill / deposit / transfer / investment / unknown -- `unknown` means the direction could not be derived (an unpriceable mixed-sign split can post either way), so report it as unknown rather than as a bill or a deposit, and it withholds BOTH rollup totals. Each item includes a daysUntilDue value (negative when overdue). Each item is ONE occurrence -- the next one due -- so `nextDueDate` is the date that occurrence actually falls on (a per-occurrence override can move it off the schedule's own recurrence date) and `amount` is what that occurrence would post today in its own `currency`, and is null with `amountComplete` false when the current exchange rate for it cannot be determined -- report such an item as unknown rather than guessing. Both bucket totals (`totalUpcomingBills` / `totalUpcomingDeposits`) describe the whole window and are NOT narrowed by a `kind` filter -- filtering to deposits still reports the bills total. Both are expressed in `totalsCurrency` (the user's default), not in the items' own currencies -- state that code whenever you quote a total, and never sum item `amount` values yourself since they can be in different currencies. A bucket total is null when any item in it has an unknown amount or is in a currency with no rate into `totalsCurrency`, with the partial sum in `knownUpcomingBillsSubtotal` / `knownUpcomingDepositsSubtotal`; quote that only as a subtotal. `amountsComplete` says whether anything is missing, `unknownAmountItems` names the items with no workable amount, and `missingRatePairs` names the currency pairs with no rate. Returns the same shape as the AI Assistant's list_upcoming_bills tool.",
        inputSchema: {
          days: z
            .number()
            .min(1)
            .max(365)
            .optional()
            .default(30)
            .describe("Number of days to look ahead (default 30)"),
          kind: z
            .enum(SCHEDULED_KIND_VALUES)
            .optional()
            .describe(
              "Narrow to a single kind: 'bill', 'deposit', 'transfer', 'investment'. Omit or pass 'all' for everything.",
            ),
          accountIds: z
            .array(z.string().uuid())
            .max(50)
            .optional()
            .describe("Optional account IDs to filter to."),
        },
        outputSchema: getUpcomingBillsOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const upcoming =
            await this.scheduledService.getLlmUpcomingBillsAndDeposits(
              ctx.userId,
              {
                days: args.days ?? 30,
                kind: args.kind,
                accountIds: args.accountIds,
              },
            );
          return toolResult(upcoming);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );
  }
}
