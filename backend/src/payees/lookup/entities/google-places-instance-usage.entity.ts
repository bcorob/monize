import { Column, Entity, PrimaryColumn } from "typeorm";

/**
 * How many Google Places requests the OPERATOR's key
 * (`GOOGLE_PLACES_API_KEY`) has spent in one billing month -- the Pacific
 * calendar month Google's allowance resets on -- across every user on the
 * deployment.
 *
 * No owner column, and RLS-exempt for the same reason `provider_health` is:
 * one operator key is one bill, whoever's lookup spent it, and a per-user copy
 * could not enforce the single cap that matters. See
 * `docs/row-level-security-contract.md`.
 */
@Entity("google_places_instance_usage")
export class GooglePlacesInstanceUsage {
  /** Pacific `YYYY-MM` -- see GOOGLE_PLACES_QUOTA_TIMEZONE. */
  @PrimaryColumn({ type: "char", length: 7 })
  month: string;

  @Column({ type: "int", default: 0 })
  requests: number;
}
