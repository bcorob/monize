/** The transaction a person paired with a sample email: its id and the line the wizard shows for it. */
export interface ChosenTransaction {
  transactionId: string;
  summary: string;
  /** The email's subject, for the lines that name the pair. */
  subject: string;
}

/** The draft profile the wizard is working on. */
export interface WizardDraft {
  parserId: string;
  /** Unknown (null) for a draft that was found, not generated; approval then does not check a revision. */
  revision: number | null;
}

/** The most emails a profile is written from at once. */
export const WIZARD_MAX_SAMPLES = 5;

/** What the profile being written reads: an order email (paired with its bank transaction) or a brokerage trade confirmation. */
export type WizardKind = 'receipt' | 'trade';
