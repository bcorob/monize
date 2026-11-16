/**
 * Thrown by a step that runs after a single-use write committed (A26-S17-02 /
 * A26-M14). The write is done, so a caller that would otherwise release an
 * idempotency claim or offer a retry keeps the claim: a retry would write
 * again. `committed` is the marker such a caller reads, through
 * `isPostCommitFailure`.
 *
 * The AI action confirm reads it today. The AI stream adopts it in
 * `executeCreateTransaction` / `executeUpdateTransaction` (`persistAttachments`)
 * and the MCP direct commits, so an attachment failure after the ledger write
 * no longer makes the same descriptor confirmable again.
 */
export class PostCommitFailure extends Error {
  readonly committed = true as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PostCommitFailure";
  }
}

export function isPostCommitFailure(
  error: unknown,
): error is PostCommitFailure {
  return (
    error instanceof PostCommitFailure ||
    (error instanceof Error &&
      error.name === "PostCommitFailure" &&
      (error as { committed?: unknown }).committed === true)
  );
}
