import type { EntityManager } from "typeorm";
import { EmailReceiptParser } from "../entities/email-receipt-parser.entity";

/** At most this many approved parsers are considered for one email. */
const MAX_PARSERS_CONSIDERED = 1000;

/**
 * The profiles that read the user's mail, in the order `chooseReceiptParser`
 * breaks ties by: the pipeline reads an email with them, and a profile's bulk
 * actions ask the same question ("which profile reads this email?") with them.
 */
export function loadApprovedParsers(
  m: EntityManager,
  userId: string,
): Promise<EmailReceiptParser[]> {
  return m.getRepository(EmailReceiptParser).find({
    where: { userId, status: "approved" },
    order: { createdAt: "ASC", id: "ASC" },
    take: MAX_PARSERS_CONSIDERED,
  });
}
