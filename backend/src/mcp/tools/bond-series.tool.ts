import { Injectable } from "@nestjs/common";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { fetchBondSeriesSchema } from "../../ai/query/tool-input-schemas";
import { SeriesFetchError } from "../../bonds/bond-adapter";
import { seriesErrorMessage } from "../../bonds/bond-series-errors";
import { BondSeriesService } from "../../bonds/bond-series.service";
import {
  resolveUserContext,
  requireScope,
  toolResult,
  toolError,
  safeToolError,
} from "../mcp-context";
import { confirmWrite, isAsk } from "../mcp-confirm";
import { McpWriteLimiter } from "../mcp-write-limiter";
import { bondSeriesOutput } from "../tool-output-schemas";
import { CREATE, FETCH_EXTERNAL } from "../mcp-annotations";
import { ymdDate } from "./schema-fragments";

const DECIMAL = /^\d{1,3}(\.\d{1,6})?$/;

/** A refused series request is the translated message, never a generic failure. */
function refusal(err: unknown) {
  return err instanceof SeriesFetchError
    ? toolError(seriesErrorMessage(err))
    : safeToolError(err);
}

/**
 * Bond series for the catalog (docs/specs/bond-series-fetch.md).
 *
 * `fetch_bond_series` reads one series from its official source: it takes only a
 * country and a series code and writes only reference data, so it needs the
 * `write` scope and counts against the daily cap but asks no confirmation.
 * `enter_bond_series_manually` is the administrator's fallback when the source
 * cannot be read: it checks the role, validates the values before asking, and
 * confirms with the user before it stores.
 */
@Injectable()
export class McpBondSeriesTools {
  constructor(
    private readonly series: BondSeriesService,
    private readonly writeLimiter: McpWriteLimiter,
  ) {}

  register(server: McpServer) {
    server.registerTool(
      "fetch_bond_series",
      {
        title: "Fetch bond series",
        annotations: FETCH_EXTERNAL,
        description:
          "Store a bond series from its official source; codes only. " +
          "created=false: already stored",
        inputSchema: fetchBondSeriesSchema,
        outputSchema: bondSeriesOutput,
      },
      async (args, ctx) => {
        const user = resolveUserContext(ctx);
        if (!user) return toolError("No user context");
        const check = requireScope(user.scopes, "write");
        if (check.error) return check.result;

        try {
          const limited = await this.writeLimiter.reserve(user.userId, 1);
          if (limited) return limited;
          const result = await this.series.fetchSeries(
            user.userId,
            args.countryCode,
            args.seriesCode,
          );
          if (result.created) {
            await this.writeLimiter.record(user.userId, "fetch_bond_series");
          }
          return toolResult(result);
        } catch (err: unknown) {
          return refusal(err);
        }
      },
    );

    server.registerTool(
      "enter_bond_series_manually",
      {
        title: "Enter bond series by hand",
        annotations: CREATE,
        description:
          "Admins only: enter a series by hand. Fractional rates; omit " +
          "addend if fixed, fee if none. User confirms.",
        inputSchema: z.object({
          countryCode: fetchBondSeriesSchema.shape.countryCode,
          seriesCode: fetchBondSeriesSchema.shape.seriesCode,
          values: z.object({
            firstPeriodRate: z.string().regex(DECIMAL),
            addend: z.string().regex(DECIMAL).optional(),
            fee: z.string().regex(DECIMAL).optional(),
            saleWindow: z.object({ from: ymdDate(), to: ymdDate() }),
            letter: z.object({
              number: z.string().max(32),
              date: ymdDate(),
            }),
          }),
        }),
        outputSchema: bondSeriesOutput,
      },
      async (args, ctx) => {
        const user = resolveUserContext(ctx);
        if (!user) return toolError("No user context");
        const check = requireScope(user.scopes, "write");
        if (check.error) return check.result;

        try {
          if (!(await this.series.isAdministrator(user.userId))) {
            return toolError(
              "Only an administrator can enter a bond series by hand.",
            );
          }
          const limited = await this.writeLimiter.reserve(user.userId, 1);
          if (limited) return limited;

          const values = {
            firstPeriodRate: args.values.firstPeriodRate,
            addend: args.values.addend ?? null,
            fee: args.values.fee ?? null,
            saleWindow: args.values.saleWindow,
            letter: args.values.letter,
          };
          // Refuse before asking: a person confirms only values that would be stored.
          this.series.checkManual(args.countryCode, args.seriesCode, values);

          const confirmation = await confirmWrite(
            server,
            ctx,
            [
              `Store bond series ${args.seriesCode.toUpperCase()} (${args.countryCode.toUpperCase()}) with values entered by hand?`,
              `First period rate ${values.firstPeriodRate}, addend ${values.addend ?? "none"}, fee ${values.fee ?? "none"}`,
              `Sale ${values.saleWindow.from} to ${values.saleWindow.to}, letter ${values.letter.number} of ${values.letter.date}`,
            ].join("\n"),
            {
              type: "enter_bond_series_manually",
              countryCode: args.countryCode.toUpperCase(),
              seriesCode: args.seriesCode.toUpperCase(),
              values,
            },
          );
          if (isAsk(confirmation)) return confirmation.ask;
          if (confirmation === "declined") {
            return toolError(
              "Cancelled: the confirmation was declined, so the series was not stored.",
            );
          }
          const result = await this.series.enterManually(
            args.countryCode,
            args.seriesCode,
            values,
          );
          if (result.created) {
            await this.writeLimiter.record(
              user.userId,
              "enter_bond_series_manually",
            );
          }
          return toolResult(result);
        } catch (err: unknown) {
          return refusal(err);
        }
      },
    );
  }
}
