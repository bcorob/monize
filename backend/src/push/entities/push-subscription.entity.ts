import { Entity, Column, Index, PrimaryGeneratedColumn } from "typeorm";

/**
 * The wire a subscription is delivered on. Both are the same encrypted Web Push
 * protocol (RFC 8291 under this instance's VAPID key), so `WebPushSender` handles
 * both; the tag exists only so the per-user `push` / `unifiedpush` channel
 * toggles can gate them independently. The set is mirrored on the DB CHECK
 * constraint (`push_subscriptions_transport_check`).
 */
export const PUSH_TRANSPORTS = ["webpush", "unifiedpush"] as const;
export type PushTransport = (typeof PUSH_TRANSPORTS)[number];

/**
 * Why a subscription stops being usable. Stored so the device list can say
 * which of the three happened instead of rendering a bare "unavailable" -- the
 * repairs differ (re-enable push in the browser, subscribe again after a key
 * rotation, nothing at all for a device that has simply gone).
 */
export enum PushDisabledReason {
  /** The push service answered 404/410: this subscription no longer exists. */
  GONE = "GONE",
  /** Minted under a superseded VAPID key pair; the signature would be rejected. */
  KEY_ROTATED = "KEY_ROTATED",
  /** Bounded retry exhausted -- `MAX_CONSECUTIVE_FAILURES` transient failures. */
  FAILING = "FAILING",
}

/**
 * One browser profile's Web Push registration: the endpoint at the push service
 * plus the two keys that encrypt to it.
 *
 * User-owned and policied like any other user table. The endpoint, though, is
 * unique **globally** rather than per user, and that is a security property
 * rather than a normalization choice: `pushManager.subscribe()` is scoped to a
 * browser profile and an origin, not to a Monize session, so two people sharing
 * one browser receive the same endpoint and the same encryption keys. Per-user
 * uniqueness would leave both rows alive and let a notification addressed to
 * the first account be decrypted and displayed on the device the second account
 * is now using.
 *
 * One row per endpoint, and the second subscriber is refused rather than
 * allowed to take the row over -- see `PushSubscriptionService.subscribe` for
 * why an endpoint buys no right to another account's row, and what the client
 * does about the refusal.
 */
@Entity("push_subscriptions")
// Declared here as well as in migration 178, because the integration suites
// build their schema from the entities: without it `ON CONFLICT (endpoint_hash)`
// has no arbiter to name and `subscribe` fails outright there, while two
// accounts could hold one endpoint -- the exact thing INV-PUSH-001 rests on.
@Index("idx_push_subscriptions_endpoint", ["endpointHash"], { unique: true })
@Index("idx_push_subscriptions_user_live", ["userId"], {
  where: "disabled_at IS NULL",
})
export class PushSubscription {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "user_id", type: "uuid" })
  userId: string;

  @Column({ type: "text" })
  endpoint: string;

  /** SHA-256 hex of `endpoint`; the indexed form, since the endpoint is unbounded. */
  @Column({ name: "endpoint_hash", type: "varchar", length: 64 })
  endpointHash: string;

  @Column({ type: "varchar", length: 255 })
  p256dh: string;

  @Column({ type: "varchar", length: 255 })
  auth: string;

  /**
   * Which wire this subscription is delivered on. `'webpush'` is a browser
   * vendor's push service; `'unifiedpush'` is a UnifiedPush distributor endpoint
   * (ntfy/NextPush) -- the same encrypted Web Push protocol either way, so
   * `WebPushSender` handles both. The per-user `push` / `unifiedpush` channel
   * toggles gate the two independently (spec section 15).
   */
  @Column({ type: "varchar", length: 20, default: "webpush" })
  transport: PushTransport;

  @Column({ name: "device_name", type: "varchar", length: 100, nullable: true })
  deviceName: string | null;

  @Column({ name: "user_agent", type: "varchar", length: 255, nullable: true })
  userAgent: string | null;

  /**
   * The address this subscription was registered from, refreshed on each
   * re-registration (the same moment `lastSeenAt` moves).
   *
   * It is REGISTERED, not current, and the name is the claim: a push travels
   * from this server to the push SERVICE, which reaches the device over a
   * connection this deployment never sees, so where a device is reachable today
   * is not knowable here. Null for every row written before the column, and for
   * a request whose address this server could not determine -- unknown, rather
   * than an address nobody was at.
   */
  @Column({ name: "registered_ip", type: "inet", nullable: true })
  registeredIp: string | null;

  /**
   * The instance identity this subscription was minted under. A rotation makes
   * every older subscription undeliverable, so this column is what lets the
   * sender skip a stale row even if the rotation that should have disabled it
   * was interrupted.
   */
  @Column({ name: "vapid_public_key", type: "varchar", length: 200 })
  vapidPublicKey: string;

  @Column({ name: "created_at", type: "timestamp" })
  createdAt: Date;

  @Column({ name: "last_seen_at", type: "timestamp" })
  lastSeenAt: Date;

  @Column({ name: "last_success_at", type: "timestamp", nullable: true })
  lastSuccessAt: Date | null;

  /** Consecutive transient failures. Reset by a success, not by time. */
  @Column({ name: "failure_count", type: "integer", default: 0 })
  failureCount: number;

  @Column({ name: "disabled_at", type: "timestamp", nullable: true })
  disabledAt: Date | null;

  @Column({
    name: "disabled_reason",
    type: "varchar",
    length: 40,
    nullable: true,
  })
  disabledReason: PushDisabledReason | null;

  /**
   * When this device's account signed out of the browser it lives in. Delivery
   * skips a held row until the same account registers it again, which clears
   * the column (INV-PUSH-011). Not a disable: the endpoint is healthy and the
   * user has nothing to repair.
   */
  @Column({ name: "held_at", type: "timestamp", nullable: true })
  heldAt: Date | null;
}
