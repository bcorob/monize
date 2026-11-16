import type { EntityManager } from "typeorm";
import { User } from "../../users/entities/user.entity";
import { EmailReceiptMailbox } from "../entities/email-receipt-mailbox.entity";
import { normalizeOwnAddress } from "../imap/forwarded-receipt";

/**
 * The addresses a forward is the owner's from (`resolveForwardedIdentity`):
 * the receipt mailbox's login and the owner's account email once verified.
 * Read from the server's own rows, never from the email; an unverified account
 * email is a claim nobody confirmed, so it is not one of them.
 */
export async function loadOwnAddresses(
  m: EntityManager,
  userId: string,
): Promise<ReadonlySet<string>> {
  const own = new Set<string>();
  // At most one mailbox per user (`uq_email_receipt_mailboxes_user`).
  const mailbox = await m.getRepository(EmailReceiptMailbox).findOne({
    where: { userId },
    select: { id: true, username: true },
  });
  const login = normalizeOwnAddress(mailbox?.username);
  if (login !== null) own.add(login);
  const user = await m.getRepository(User).findOne({
    where: { id: userId },
    select: { id: true, email: true, emailVerified: true },
  });
  const email = user?.emailVerified ? normalizeOwnAddress(user.email) : null;
  if (email !== null) own.add(email);
  return own;
}

/**
 * `load` run at most once, on the first call: the poll and the import read the
 * owner's addresses only when a message of the batch holds a forward.
 */
export function ownAddressesOnce(
  load: () => Promise<ReadonlySet<string>>,
): () => Promise<ReadonlySet<string>> {
  let pending: Promise<ReadonlySet<string>> | null = null;
  return () => (pending ??= load());
}
