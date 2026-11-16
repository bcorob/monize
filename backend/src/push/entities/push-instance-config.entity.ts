import {
  Check,
  Entity,
  Column,
  PrimaryColumn,
  UpdateDateColumn,
} from "typeorm";

/**
 * This deployment's Web Push identity: one VAPID key pair per Monize instance,
 * not per user.
 *
 * The pair is generated on first start (`PushConfigService`) so a self-hosted
 * administrator registers nothing with Google, Apple or Firebase -- the "zero
 * external setup" principle of discussion #1291. The public half is handed to
 * every browser that subscribes; the private half is AES-256-GCM ciphertext
 * under `ENCRYPTION_KEY` and never leaves the server.
 *
 * Deployment-wide state with no owner column, so the table is RLS-exempt for
 * the same reason `provider_health` is (`docs/row-level-security-contract.md`).
 */
@Entity("push_instance_config")
// See `UpdateCheckState`: the singleton constraint belongs on the entity too,
// so the harness and production agree about what a second row would do.
@Check("id")
export class PushInstanceConfig {
  /**
   * Singleton discriminator. The column admits exactly one value, so a second
   * insert is a conflict rather than a second push identity for one deployment
   * -- which is what makes `INSERT ... ON CONFLICT DO NOTHING` the arbiter when
   * several replicas start at once.
   */
  @PrimaryColumn({ type: "boolean", default: true })
  id: boolean;

  @Column({ name: "vapid_public_key", type: "varchar", length: 200 })
  vapidPublicKey: string;

  /** AES-256-GCM ciphertext. Read only by `PushConfigService`. */
  @Column({ name: "vapid_private_key_enc", type: "text" })
  vapidPrivateKeyEnc: string;

  @Column({ name: "vapid_generated_at", type: "timestamp" })
  vapidGeneratedAt: Date;

  /**
   * Instance kill-switch. Off hides the push surface from every account's
   * settings and makes the sender a no-op; it does not delete subscriptions,
   * so turning it back on restores the devices as they were.
   */
  @Column({ name: "web_push_enabled", type: "boolean", default: true })
  webPushEnabled: boolean;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
