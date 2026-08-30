import { Entity, Column, PrimaryColumn } from "typeorm";
import { ApiProperty } from "@nestjs/swagger";

/**
 * Whether an outbound market-data provider is answering, and what has already
 * been said about it by email.
 *
 * Deployment-wide reference state with no owner column -- one Yahoo outage is
 * every user's Yahoo outage -- so the table is RLS-exempt for the same reason
 * `market_index_sync` is (`docs/row-level-security-contract.md`).
 *
 * The in-process circuit breaker (`ProviderCircuit`) is the authority on
 * *whether to call out*: it describes what this replica's own sockets just did,
 * which no shared table can know. This row exists for the two things memory
 * cannot do:
 *
 * 1. survive the restart -- the outage in issue #1265 restarted the container
 *    repeatedly, and an in-memory `outageStartedAt` would have reset to "just
 *    now" each time, so a "has it been down 15 minutes" gate would never have
 *    fired;
 * 2. serialize the notification across replicas -- `outageNotifiedAt` and
 *    `lastNotifiedAt` are claimed with a conditional UPDATE, so one alert goes
 *    out per episode however many replicas noticed it
 *    (`docs/concurrency-and-idempotency.md`).
 */
@Entity("provider_health")
export class ProviderHealth {
  @ApiProperty()
  @PrimaryColumn({ type: "varchar", length: 64 })
  provider: string;

  /** `down` means the breaker is open: calls are being refused locally. */
  @ApiProperty()
  @Column({ type: "varchar", length: 16, default: "up" })
  state: string;

  /**
   * Transport failures among the provider's last few attempts, as the breaker
   * counts them: a sliding window rather than a consecutive run, because a
   * provider that answers headers and stalls bodies never produces a run.
   */
  @ApiProperty()
  @Column({ name: "recent_failures", type: "integer", default: 0 })
  recentFailures: number;

  /**
   * First failure of the current outage episode, preserved across restarts: the
   * upsert only overwrites it when the stored state is not already `down`.
   */
  @ApiProperty({ required: false, nullable: true })
  @Column({ name: "outage_started_at", type: "timestamptz", nullable: true })
  outageStartedAt: Date | null;

  @ApiProperty({ required: false, nullable: true })
  @Column({ name: "last_failure_at", type: "timestamptz", nullable: true })
  lastFailureAt: Date | null;

  @ApiProperty({ required: false, nullable: true })
  @Column({ name: "last_failure_reason", type: "text", nullable: true })
  lastFailureReason: string | null;

  @ApiProperty({ required: false, nullable: true })
  @Column({ name: "last_success_at", type: "timestamptz", nullable: true })
  lastSuccessAt: Date | null;

  /**
   * When the outage email for the *current* episode was sent. Non-null is also
   * what makes a recovery email owed; the recovery send clears it, so the pair
   * is at most one outage notice and one all-clear per episode.
   */
  @ApiProperty({ required: false, nullable: true })
  @Column({ name: "outage_notified_at", type: "timestamptz", nullable: true })
  outageNotifiedAt: Date | null;

  /**
   * When any alert about this provider last left the process. Never cleared:
   * it is the floor that stops a flapping provider from mailing a pair of
   * notices every few minutes.
   */
  @ApiProperty({ required: false, nullable: true })
  @Column({ name: "last_notified_at", type: "timestamptz", nullable: true })
  lastNotifiedAt: Date | null;
}
