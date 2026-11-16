import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from "typeorm";
import { User } from "../../../users/entities/user.entity";

/**
 * How many Google Places requests one user's own key has spent in one billing
 * month -- the Pacific calendar month Google's free allowance resets on.
 *
 * The row is created and incremented by the same statement
 * (`PayeeLookupQuotaService.claim`), which is also what enforces the cap: the
 * `ON CONFLICT ... WHERE` refuses to increment past it, and zero rows back
 * means the cap is reached. The month is written by PostgreSQL so every
 * replica rolls over on one clock, and in Google's zone so it rolls over at
 * the same instant the allowance it rations does.
 */
@Entity("payee_lookup_usage")
export class PayeeLookupUsage {
  @PrimaryColumn({ type: "uuid", name: "user_id" })
  userId: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user?: User;

  /** Pacific `YYYY-MM` -- see GOOGLE_PLACES_QUOTA_TIMEZONE. */
  @PrimaryColumn({ type: "char", length: 7 })
  month: string;

  @Column({ type: "int", name: "google_places_requests", default: 0 })
  googlePlacesRequests: number;
}
