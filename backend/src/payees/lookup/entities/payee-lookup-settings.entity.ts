import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from "typeorm";
import { User } from "../../../users/entities/user.entity";

/** Which source a user wants asked first. Mirrors the column's CHECK. */
export type PayeeLookupPreferredSource = "google-places" | "ai";

/**
 * One user's Google Places configuration for the payee contact lookup.
 *
 * A row exists only once the user has configured something; its absence is
 * "not configured" rather than a set of stored defaults, which is why every
 * reader tolerates `null` and falls back to the constants in
 * `google-places/google-places-cap.ts`.
 *
 * `apiKeyEnc` is ciphertext under `ENCRYPTION_KEY` and is deliberately named
 * for the same column as `ai_provider_configs.api_key_enc`: the backup's key
 * transport is keyed on that name, and without it the row restores onto
 * another instance populated and unreadable.
 */
@Entity("payee_lookup_settings")
export class PayeeLookupSettings {
  @PrimaryColumn({ type: "uuid", name: "user_id" })
  userId: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user?: User;

  @Column({ type: "text", name: "api_key_enc", nullable: true })
  apiKeyEnc: string | null;

  @Column({ name: "google_places_enabled", default: true })
  googlePlacesEnabled: boolean;

  /**
   * The AI source's own switch, symmetric with `googlePlacesEnabled`.
   *
   * Disabled means the AI adapter is not reached at all -- not first, and not
   * as the fallback when the Places cap is spent. A switch that still let it
   * answer sometimes would defeat the one thing it is for: not paying for it.
   */
  @Column({ name: "ai_enabled", default: true })
  aiEnabled: boolean;

  @Column({ name: "cap_enabled", default: true })
  capEnabled: boolean;

  /** Requests allowed per Pacific calendar month while `capEnabled`. */
  @Column({ type: "int", name: "monthly_cap", default: 1000 })
  monthlyCap: number;

  /**
   * Which source answers a lookup first.
   *
   * An ORDER rather than a switch: the other source is still reached when this
   * one cannot answer for a configuration or budget reason (no AI provider, or
   * the Places cap spent). A source that FAILS is still reported as a failure
   * -- paying the other one to hide a rejected key is the thing the routing
   * rule exists to prevent.
   */
  @Column({
    type: "varchar",
    length: 20,
    name: "preferred_source",
    default: "google-places",
  })
  preferredSource: PayeeLookupPreferredSource;

  /**
   * Which AI provider answers when AI does; `null` is "no preference", meaning
   * every active provider in priority order.
   *
   * A pin rather than a preference order of its own: the assistant falls
   * through to the next provider on failure, which is right for a chat turn and
   * wrong for a lookup the user pays per call for. A pin that resolves to
   * nothing (the provider was deactivated) reports `no_provider` rather than
   * spending a model the user did not choose.
   */
  @Column({
    type: "uuid",
    name: "ai_provider_config_id",
    nullable: true,
  })
  aiProviderConfigId: string | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
