import { z } from "zod";
import { booleanArg } from "../../common/tool-schemas";

/**
 * Input-schema pieces shared by the MCP tools.
 *
 * Every tool's `inputSchema` is serialized to JSON Schema and shipped in
 * `tools/list` on every request, so a shape spelled out per tool is paid for per
 * tool. These fragments exist so the id, date, name-list, operation and approval
 * shapes are declared once -- and so the approval wording, which is identical
 * for all four `manage_*` tools, cannot drift between them.
 *
 * `schema-fragments.guard.spec.ts` fails when a tool re-declares one inline.
 */

/**
 * A UUID, as a bare pattern rather than `z.string().uuid()`.
 *
 * Zod 4 emits BOTH `format: "uuid"` and a 166-character pattern for `.uuid()`,
 * in every tool that takes an id. This pattern is the same check in 75
 * characters. It carries no flags on purpose: zod serializes `regex.source`
 * only, so a flag (an `i`, say) would be honoured by the server's own parse and
 * silently absent from the schema the client validates against -- two different
 * rules wearing one name.
 */
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export const uuidString = () => z.string().regex(UUID_PATTERN);

/** A calendar date. The format is stated once, in the server instructions. */
export const ymdDate = () => z.string().max(10);

/** A bounded list of entity names, resolved to ids server-side. */
export const nameList = (maxItems: number) =>
  z.array(z.string().max(100)).max(maxItems);

/** The operation every `manage_*` tool applies to all of its items. */
export const manageOperation = () =>
  z
    .enum(["create", "update", "delete"])
    .describe("The operation to perform on every item.");

/**
 * How a multi-item batch is confirmed. The default (bulk at 6 or more items,
 * one card each below that) is stated once in the server instructions.
 */
export const approvalMode = () =>
  // A client form that leaves the field blank sends "": read it as unset.
  z
    .preprocess(
      (value) => (value === "" ? undefined : value),
      z.enum(["bulk", "individual"]).optional(),
    )
    .describe("Force one confirmation per item with 'individual'.");

/** Preview without saving. */
export const dryRun = () =>
  booleanArg()
    .optional()
    .default(false)
    .describe("Validate and preview every item without saving.");

/** The rows a `manage_*` call acts on. */
export const itemsArray = <T extends z.ZodTypeAny>(item: T) =>
  z.array(item).min(1).max(25).describe("The rows to act on (1-25).");
