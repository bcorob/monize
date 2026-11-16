import {
  Entity,
  Check,
  Column,
  PrimaryColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from "typeorm";

/**
 * The deployment's automatic-backup policy: one row, for the whole instance.
 *
 * A singleton in the shape `update_check_state` and `push_instance_config` use
 * -- a boolean primary key with a `CHECK` that pins it to `true`, so the table
 * cannot hold a second row to disagree with.
 *
 * It exists because the policy previously lived on the `auto_backup_settings`
 * row of the earliest-created active administrator, which made three ordinary
 * account operations silently rewrite a deployment-wide setting: deactivating
 * or demoting that administrator, deleting them (the row cascades), and
 * restoring their own backup (the table is per-user and was exported with it).
 * `auto_backup_settings` now carries only what is genuinely one account's --
 * the bookkeeping of its own runs.
 */
// The primary key alone admits TRUE *and* FALSE; `CHECK (id)` is what refuses
// the second row. It is declared here as well as in schema.sql because the
// integration harness builds its database from entity metadata, so a constraint
// only schema.sql carries is one no integration spec can observe.
@Entity("auto_backup_policy")
@Check("id")
export class AutoBackupPolicyRow {
  /** Always `true`: the `CHECK (id)` is what makes this table one row. */
  @PrimaryColumn({ type: "boolean", default: true })
  id: boolean;

  @Column({ default: true })
  enabled: boolean;

  @Column({ name: "folder_path", length: 1024, default: "" })
  folderPath: string;

  @Column({ length: 20, default: "daily" })
  frequency: string;

  @Column({ name: "backup_time", length: 5, default: "02:00" })
  backupTime: string;

  @Column({ length: 100, default: "UTC" })
  timezone: string;

  @Column({ name: "retention_daily", type: "smallint", default: 7 })
  retentionDaily: number;

  @Column({ name: "retention_weekly", type: "smallint", default: 4 })
  retentionWeekly: number;

  @Column({ name: "retention_monthly", type: "smallint", default: 6 })
  retentionMonthly: number;

  /**
   * When a manual "back up every account" fan-out took this row, or `null` when
   * nobody holds it.
   *
   * Not a setting: it is the claim that keeps two operators -- or one operator
   * pressing again after a proxy timeout -- from interleaving two full fan-outs
   * over the same accounts. Claimed and released by conditional `UPDATE`
   * (`claimManualRun` / `releaseManualRun`), with a staleness bound so a
   * replica killed mid-run frees it without an unlock to forget.
   */
  @Column({ name: "manual_run_claimed_at", type: "timestamp", nullable: true })
  manualRunClaimedAt: Date | null;

  /**
   * Which run holds the claim. Released **by token**, so a fan-out that outran
   * the staleness bound cannot free the claim a later one has since taken --
   * the same rule the demo-reseed lease states.
   */
  @Column({ name: "manual_run_claim_token", type: "uuid", nullable: true })
  manualRunClaimToken: string | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
