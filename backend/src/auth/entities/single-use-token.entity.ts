import { Column, Entity, Index, PrimaryColumn } from "typeorm";

/**
 * One thing that may be used once: a TOTP code inside its reuse window, a
 * confirmed AI action descriptor.
 *
 * The claim **is** the `INSERT`. `ON CONFLICT DO NOTHING RETURNING` makes the
 * primary key the serialization point, so the winner is decided by the database
 * rather than by a read the loser also passed -- which is the whole difference
 * between this and the `Set` it replaces, where every replica held its own idea
 * of what had been used.
 */
@Entity("single_use_tokens")
export class SingleUseToken {
  /** What kind of one-shot this is, e.g. `totp`, `ai-action`. Keeps two unrelated claims from colliding on one hash. */
  @PrimaryColumn({ type: "text" })
  purpose: string;

  /**
   * SHA-256 of the secret, never the secret.
   *
   * The table has no owner column and is RLS-exempt, so every session can read
   * it; a stored code would be a replayable one.
   */
  @PrimaryColumn({ type: "text", name: "token_hash" })
  tokenHash: string;

  /** When the claim stops mattering. The sweep deletes past this; a claim against an expired row is still a loss. */
  @Index("idx_single_use_tokens_expiry")
  @Column({ type: "timestamptz", name: "expires_at" })
  expiresAt: Date;
}
