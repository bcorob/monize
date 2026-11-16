import type { ParsedReceipt } from "../parsing/receipt-parser.types";
import {
  isUsableSchemaOrgOrder,
  orderFromStructuredData,
  schemaOrgToParsedReceipt,
} from "../parsing/schema-org-order";
import type { ReceiptSourceLines } from "./receipt-source-lines";

/** The payee a seller's name resolves to, as far as a reading needs it. */
export interface SellerPayee {
  defaultCategoryId: string | null;
}

/**
 * The email's own schema.org order (JSON-LD or microdata in the HTML part) as a
 * receipt, or null when the email has none, or it states no total or no line
 * (spec "Structured data"). `resolveSeller` is the payee lookup by name
 * (`PayeesService.resolveByName`: it never creates one); the payee's default
 * category is the category of every line, and with none the reading is
 * `items_uncategorized`. It is called only for an order that can be read, and
 * only when it names a seller. Reads only.
 */
export async function readSchemaOrgReceipt(
  sources: ReceiptSourceLines,
  resolveSeller: (name: string) => Promise<SellerPayee | null>,
): Promise<ParsedReceipt | null> {
  const data = sources.structured();
  if (data === null) return null;
  const order = orderFromStructuredData(data);
  if (order === null || !isUsableSchemaOrgOrder(order)) return null;
  const seller = order.seller ? await resolveSeller(order.seller) : null;
  return schemaOrgToParsedReceipt(order, seller?.defaultCategoryId ?? null);
}
