import {
  DELEGATE_ALLOWED_AI_TOOLS,
  DELEGATE_DENIED_AI_TOOLS,
} from "./ai-query.service";
import { FINANCIAL_TOOLS } from "./tool-definitions";

/**
 * An acting delegate's assistant run is limited to an allow-list, so a new tool
 * is withheld by default. This guard makes the choice explicit: every tool is
 * in exactly one of the two lists, and neither names a tool that is gone.
 */
describe("delegate AI tool classification", () => {
  const lists = "DELEGATE_ALLOWED_AI_TOOLS or DELEGATE_DENIED_AI_TOOLS";
  const allowed = new Set(DELEGATE_ALLOWED_AI_TOOLS);
  const denied = new Set(DELEGATE_DENIED_AI_TOOLS);

  it.each(FINANCIAL_TOOLS.map((t) => t.name))(
    "classifies %s in exactly one list",
    (name) => {
      const count = Number(allowed.has(name)) + Number(denied.has(name));
      if (count !== 1) {
        throw new Error(
          `Tool "${name}" is in ${count} of the delegate lists; put it in exactly one of ${lists} (backend/src/ai/query/ai-query.service.ts). Allow it only if it reads what a full-scope read-only delegate can read through REST.`,
        );
      }
    },
  );

  it("names no tool that does not exist, in either list", () => {
    const real = new Set(FINANCIAL_TOOLS.map((t) => t.name));
    for (const name of [...allowed, ...denied]) {
      if (!real.has(name)) {
        throw new Error(
          `"${name}" is in ${lists} but not in FINANCIAL_TOOLS; remove it.`,
        );
      }
    }
  });

  it("never allows a manage_* tool or a tool withdrawn by the earlier deny-list", () => {
    for (const name of [
      "email_receipt_parsers",
      "ai_review_requests",
      "fetch_bond_series",
      "list_transaction_rules",
      "manage_transaction_rules",
      ...FINANCIAL_TOOLS.map((t) => t.name).filter((n) =>
        n.startsWith("manage_"),
      ),
    ]) {
      expect(allowed.has(name)).toBe(false);
    }
  });
});
