import { Check, Column, Entity, PrimaryColumn } from "typeorm";

/**
 * What this deployment last learned about the upstream release, and when it
 * last asked.
 *
 * It was a field on `UpdatesService`, which made two separate things false: two
 * replicas answered `/updates` from two caches, so the same person saw "update
 * available" or not depending on which pod served them; and a restart threw the
 * answer away and re-asked GitHub, whose unauthenticated rate limit is per IP
 * and shared by every replica behind one egress address.
 *
 * Deployment-wide state with no owner column -- one instance checks one
 * upstream -- so the table is RLS-exempt for the same reason
 * `push_instance_config` is (`backend/src/common/db/rls-exempt-tables.ts`,
 * `docs/row-level-security-contract.md`).
 */
@Entity("update_check_state")
// Declared here as well as in schema.sql, and for the same reason the relay
// tables declare theirs: TypeORM builds the integration harness's database from
// this metadata, so a constraint only schema.sql carries is one no integration
// spec can observe. `CHECK (id)` is what makes the table a singleton -- the
// primary key alone would admit a second row keyed FALSE.
@Check("id")
export class UpdateCheckState {
  /**
   * Singleton discriminator. The column admits exactly one value, which is what
   * lets the conditional upsert be the claim: replicas ticking together collide
   * on the key and only the one that moved `checked_at` calls GitHub.
   */
  @PrimaryColumn({ type: "boolean", default: true })
  id: boolean;

  /**
   * When GitHub was last **asked**, not when it last answered usefully.
   *
   * A failed check still holds the window. Stamping only on success would turn
   * an unreachable GitHub into a request from every replica on every tick --
   * which is exactly when the rate limit is least affordable.
   */
  @Column({
    type: "timestamptz",
    name: "checked_at",
    default: () => "CURRENT_TIMESTAMP",
  })
  checkedAt: Date;

  /** The upstream tag with any leading `v` stripped, or null before a first success. */
  @Column({ type: "text", name: "latest_version", nullable: true })
  latestVersion: string | null;

  @Column({ type: "text", name: "release_url", nullable: true })
  releaseUrl: string | null;

  @Column({ type: "text", name: "release_name", nullable: true })
  releaseName: string | null;

  @Column({ type: "timestamptz", name: "published_at", nullable: true })
  publishedAt: Date | null;

  /**
   * Why the last check did not produce a version, as a short machine-readable
   * token (`unreachable`, `github_status_403`). Surfaced to the client so the
   * banner can say "could not check" rather than "up to date".
   */
  @Column({ type: "text", name: "last_error", nullable: true })
  lastError: string | null;
}
