import {
  BadRequestException,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from "@nestjs/common";
import { DataSource, EntityManager, IsNull, Not } from "typeorm";
import * as crypto from "crypto";
import * as webpush from "web-push";
import { withScopedDb } from "../common/db/scoped-db";
import { affectedRowCount } from "../common/db/query-result";
import { tr } from "../i18n/translate";
import { withSystemContext } from "../common/db/with-context";
import { EncryptionService } from "../common/encryption/encryption.service";
import { ENCRYPTION_KEY_ENV } from "../common/encryption/encryption-key";
import { PushInstanceConfig } from "./entities/push-instance-config.entity";
import {
  PushDisabledReason,
  PushSubscription,
} from "./entities/push-subscription.entity";

/**
 * The `sub` claim every VAPID signature carries: a stable address the push
 * service can use to reach whoever is sending. A constant rather than an
 * environment variable on purpose -- the whole point of generating keys on
 * first start is that a self-hosted administrator configures nothing, and a
 * second source of truth for one value is how the currency default drifted
 * across twenty-three call sites.
 */
export const VAPID_SUBJECT = "https://github.com/kenlasko/monize";

/** What the browser is told, and the only shape `/push/config` ever returns. */
export interface PublicPushConfig {
  /**
   * All three true: the instance holds a key pair, that key pair can actually
   * be used, and an administrator has left the channel on. A key pair this
   * server cannot decrypt is not a channel -- offering the enable button over
   * one produces a subscription nothing will ever be delivered to.
   */
  enabled: boolean;
  /** Handed to `pushManager.subscribe()`. Public by construction. */
  publicKey: string | null;
  /** False when the instance holds no key pair at all, so the UI can say which. */
  configured: boolean;
  /**
   * A stored key pair this instance cannot decrypt -- ENCRYPTION_KEY changed
   * under a live database, or a restore landed on a different instance.
   *
   * Its own state, not folded into `configured`: "no key pair" is repaired by
   * setting ENCRYPTION_KEY and restarting, and this one by rotating. Two causes,
   * two repairs, so one message each -- and it is on the *public* shape too,
   * because without it the account surface reported this as "an administrator
   * switched push off", which is false and sends the reader to the wrong person.
   */
  keyUnreadable: boolean;
  /**
   * Whether this server holds an `ENCRYPTION_KEY` at all.
   *
   * `keyUnreadable` has two causes with OPPOSITE repairs, and folding them cost
   * the reader the only thing they needed: with no key configured, both surfaces
   * said "rotate the key pair to recover" and `rotateKeyPair` refuses in exactly
   * that state, so the documented repair was guaranteed to fail. A key that
   * changed under a live database is repaired by rotating; a missing one by
   * setting the variable and restarting, which no button here can do.
   *
   * Named as the AI provider surface names the same fact
   * (`AiConfigResponse.encryptionAvailable`), so a reader who has seen one
   * recognises the other.
   */
  encryptionAvailable: boolean;
}

/** The administrator's view. Adds provenance, never the private key. */
export interface AdminPushConfig extends PublicPushConfig {
  publicKeyFingerprint: string | null;
  generatedAt: string | null;
  /** Live devices across the whole deployment -- a count, never a device list. */
  liveSubscriptionCount: number;
  disabledSubscriptionCount: number;
}

/** What `WebPushSender` needs and nothing else may ask for. */
export interface VapidIdentity {
  publicKey: string;
  privateKey: string;
}

/**
 * A short, comparable name for a public key, so an administrator can tell two
 * instances apart without reading 87 base64 characters.
 */
export function fingerprintPublicKey(publicKey: string): string {
  return (
    crypto
      .createHash("sha256")
      // The VAPID public half is handed to every browser by `/push/config`; it is
      // an identifier, not a credential, and a short digest of it is the whole
      // point -- there is no secret here for a work factor to protect. CodeQL
      // reads `generateVAPIDKeys()` as a password source and reports
      // js/insufficient-password-hash on the `.update(...)` call, which a
      // suppression annotation covers only from the line directly below it.
      // Default setup does not run the alert-suppression query, so the alert is
      // dismissed as a false positive on the Security tab and the annotation is
      // placed where it takes effect the day that query runs
      // (docs/backend/modules-and-runtime.md, CodeQL suppressions).
      // codeql[js/insufficient-password-hash]
      .update(publicKey)
      .digest("hex")
      .slice(0, 16)
  );
}

/**
 * Owns this deployment's Web Push identity: generating it once, handing the
 * public half out, decrypting the private half for the sender, and rotating the
 * pair.
 *
 * Every method seeds its own identity context. There is no request behind the
 * bootstrap hook, and rotation and the deployment counts are genuinely
 * cross-user questions -- one key pair serves every account -- so the reads and
 * writes here run under `withSystemContext` rather than the caller's.
 */
@Injectable()
export class PushConfigService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PushConfigService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly encryption: EncryptionService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.ensureKeyPair();
    } catch (error) {
      // Push is a side channel. An instance that cannot mint a key pair still
      // serves every financial route, so this is logged rather than thrown --
      // `configured: false` is what the UI acts on.
      this.logger.error(
        `Could not establish a Web Push key pair: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Read the deployment's key pair, generating it on first start.
   *
   * Returns `null` when `ENCRYPTION_KEY` is absent. Storing the private half in
   * plaintext would be worse than having no push at all, and the operator is
   * already told about the missing key by the weekly `ENCRYPTION_KEY_MISSING`
   * alert (`SystemAlertMonitorService`) -- raising a second alert for one cause
   * would send them to fix two things.
   *
   * The WHOLE method runs under system context, the initial read included:
   * `onApplicationBootstrap` has no request to inherit an identity from, so a
   * bare `withScopedDb` there throws before it reads anything -- and the throw
   * is swallowed by the hook, which leaves the deployment permanently without a
   * key pair and the admin page blaming a missing ENCRYPTION_KEY. Seeding the
   * context at the entry point rather than around the write is what makes the
   * whole path work with no request behind it.
   */
  async ensureKeyPair(): Promise<PushInstanceConfig | null> {
    return withSystemContext(() => this.ensureKeyPairInContext());
  }

  private async ensureKeyPairInContext(): Promise<PushInstanceConfig | null> {
    const existing = await this.readConfig();
    if (existing) {
      // Warm the identity memo here, in the bootstrap hook, rather than leaving
      // the first request to pay for it. `resolveIdentity` decrypts through
      // `EncryptionService`, whose derivation is `scryptSync` -- tens of
      // milliseconds of BLOCKED event loop, for every concurrent request, on
      // whichever `GET /push/config` happened to arrive first after a restart.
      // The normal case is exactly this branch: the row already exists, so
      // returning it early meant the memo was cold after every restart, which is
      // the opposite of what it is for.
      this.canUseKeyPair(existing);
      return existing;
    }

    if (!this.encryption.isConfigured()) {
      this.logger.warn(
        `Web Push is unavailable: ${ENCRYPTION_KEY_ENV} is not set, so the ` +
          "VAPID private key cannot be stored encrypted. Set it and restart to " +
          "enable push notifications.",
      );
      return null;
    }

    const generated = webpush.generateVAPIDKeys();
    return withScopedDb(this.dataSource, async (manager) => {
      // Every replica runs this hook, so the insert is the arbiter rather
      // than a read-then-write. A conflict means another replica won, and the
      // authoritative row is then re-read inside this same transaction --
      // never assembled from the values we tried to insert.
      await manager.query(
        `INSERT INTO push_instance_config
             (id, vapid_public_key, vapid_private_key_enc, vapid_generated_at)
           VALUES (TRUE, $1, $2, CURRENT_TIMESTAMP)
           ON CONFLICT (id) DO NOTHING`,
        [generated.publicKey, this.encryption.encrypt(generated.privateKey)],
      );
      const row = await manager
        .getRepository(PushInstanceConfig)
        .findOne({ where: { id: true } });
      if (row && row.vapidPublicKey === generated.publicKey) {
        this.logger.log(
          `Generated this instance's Web Push key pair (fingerprint ${fingerprintPublicKey(row.vapidPublicKey)})`,
        );
      }
      // Warmed on this branch as well as the early return above. A first-ever
      // start reaches only this one, so warming only the other left the very
      // deployment that has never decrypted the key paying the `scryptSync` on
      // its first request -- the branch the memo exists for, missed because the
      // fix was written from the restart case.
      if (row) this.canUseKeyPair(row);
      return row;
    });
  }

  /**
   * The row as stored, or `null` when this instance has no push identity yet.
   *
   * Runs under whatever identity the caller already has: `push_instance_config`
   * is RLS-exempt, so a tenant transaction reads it exactly as a system one
   * would, and seeding a bypass here would widen the fence on a request path
   * for nothing (`docs/backend/database-access-and-tenancy.md`, "a read about somebody else"). The two
   * callers that genuinely have no ambient identity -- the bootstrap hook, and
   * the deployment-wide device counts -- seed their own.
   */
  async readConfig(): Promise<PushInstanceConfig | null> {
    return withScopedDb(this.dataSource, (manager) =>
      manager
        .getRepository(PushInstanceConfig)
        .findOne({ where: { id: true } }),
    );
  }

  async getPublicConfig(): Promise<PublicPushConfig> {
    const config = await this.readConfig();
    const keyUnreadable = !!config && !this.canUseKeyPair(config);
    return {
      enabled: !!config && config.webPushEnabled && !keyUnreadable,
      publicKey: config?.vapidPublicKey ?? null,
      configured: !!config,
      keyUnreadable,
      encryptionAvailable: this.encryption.isConfigured(),
    };
  }

  /**
   * The identity a stored ciphertext opens, decrypted at most once per key pair.
   *
   * The memo is not an optimization detail, it is the difference between a
   * usable endpoint and a blocked event loop: `EncryptionService.canDecrypt`
   * derives its key with `scryptSync` -- tens of milliseconds, by design -- and
   * its own doc comment says not to put it on a list path. This answer is
   * needed on every `GET /push/config`, every subscribe and every send, so a
   * ten-device test would otherwise have spent about a second of CPU deriving
   * the same key twenty times.
   *
   * Keyed on the ciphertext, so a rotation invalidates it by construction and
   * there is nothing to remember to clear. It holds the decrypted private key
   * in process memory, which is a real trade and a small one: `ENCRYPTION_KEY`
   * itself is already there, so anything that can read this could derive it
   * anyway, and every send needs the plaintext regardless.
   */
  private identityCache: {
    ciphertext: string;
    identity: VapidIdentity | null;
  } | null = null;

  /**
   * The usable identity for a stored config, or `null` when this server cannot
   * open it -- ENCRYPTION_KEY changed under a live database, or a backup landed
   * on a different instance. The failure is silent otherwise: the column is
   * populated, every "is push configured?" check says yes, and only the send
   * finds out -- exactly the shape `AiService` names for a stored API key it
   * cannot decrypt.
   */
  private resolveIdentity(config: PushInstanceConfig): VapidIdentity | null {
    const ciphertext = config.vapidPrivateKeyEnc;
    // `this.identityCache?.ciphertext === ciphertext` was a cache HIT for a row
    // whose ciphertext is absent: the optional chain answers `undefined`, which
    // equals the `undefined` on the right, and the next line then dereferenced a
    // null cache. An empty cache and an unreadable row are two different facts
    // and this is the line that used to treat them as one, so the guard is on
    // the cache's existence and nothing else.
    const cached = this.identityCache;
    if (cached !== null && cached.ciphertext === ciphertext) {
      return cached.identity;
    }
    let identity: VapidIdentity | null;
    try {
      // A row with a public key and no stored private half is unreadable, not a
      // crash: `getPublicConfig` reports `keyUnreadable` and the operator is
      // told to rotate, which is the same answer as a key this server cannot
      // decrypt.
      identity =
        this.encryption.isConfigured() && ciphertext
          ? {
              publicKey: config.vapidPublicKey,
              privateKey: this.encryption.decrypt(ciphertext),
            }
          : null;
    } catch {
      identity = null;
    }
    this.identityCache = { ciphertext, identity };
    return identity;
  }

  private canUseKeyPair(config: PushInstanceConfig): boolean {
    return this.resolveIdentity(config) !== null;
  }

  async getAdminConfig(): Promise<AdminPushConfig> {
    const config = await this.readConfig();
    // System context for the counts alone: "how many devices does this
    // deployment have" is a cross-user question, and it is the only one here.
    const counts = await withSystemContext(() =>
      withScopedDb(this.dataSource, async (manager) => {
        const repo = manager.getRepository(PushSubscription);
        const live = await repo.count({ where: { disabledAt: IsNull() } });
        const disabled = await repo.count({
          where: { disabledAt: Not(IsNull()) },
        });
        return { live, disabled };
      }),
    );

    const keyUnreadable = !!config && !this.canUseKeyPair(config);
    return {
      enabled: !!config && config.webPushEnabled && !keyUnreadable,
      publicKey: config?.vapidPublicKey ?? null,
      configured: !!config,
      keyUnreadable,
      encryptionAvailable: this.encryption.isConfigured(),
      publicKeyFingerprint: config
        ? fingerprintPublicKey(config.vapidPublicKey)
        : null,
      generatedAt: config?.vapidGeneratedAt
        ? new Date(config.vapidGeneratedAt).toISOString()
        : null,
      liveSubscriptionCount: counts.live,
      disabledSubscriptionCount: counts.disabled,
    };
  }

  /**
   * The private half, decrypted. Called only by `WebPushSender`; a guard test
   * (`push-secret.guard.spec.ts`) fails when any other file reaches for it.
   */
  async getVapidIdentity(): Promise<VapidIdentity | null> {
    const config = await this.readConfig();
    if (!config || !config.webPushEnabled) return null;
    const identity = this.resolveIdentity(config);
    if (!identity) {
      // A stored pair this instance cannot open is its own diagnosis: it
      // happens when ENCRYPTION_KEY changes under a live database. Saying so
      // beats an AES-GCM authentication failure surfacing as a generic 500 --
      // once per stored pair, not once per call: every notification fan-out
      // asks here, so a misconfigured key would otherwise print one identical
      // line per alert per user per cron run (issue #1265's shape). The admin
      // page carries the same fact as `keyUnreadable` for as long as it holds.
      if (this.unreadableLogged !== config.vapidPrivateKeyEnc) {
        this.unreadableLogged = config.vapidPrivateKeyEnc;
        this.logger.error(
          `The stored VAPID private key cannot be decrypted with this instance's ${ENCRYPTION_KEY_ENV}. Rotate the key pair on the admin notifications page to recover; every device will re-subscribe.`,
        );
      }
      return null;
    }
    this.unreadableLogged = null;
    return identity;
  }

  /** The ciphertext the unreadable-key error was last logged for, so it is logged once per pair. */
  private unreadableLogged: string | null | undefined = null;

  async setWebPushEnabled(enabled: boolean): Promise<AdminPushConfig> {
    const updated = await withSystemContext(() =>
      withScopedDb(this.dataSource, async (manager) =>
        affectedRowCount(
          await manager.query(
            `UPDATE push_instance_config
                SET web_push_enabled = $1, updated_at = CURRENT_TIMESTAMP
              WHERE id = TRUE`,
            [enabled],
          ),
        ),
      ),
    );
    if (updated === 0) {
      // No row to switch, so nothing was switched: the same "refusal reported
      // as success" shape the rotation had. Answering 200 would leave the
      // toggle springing back with no explanation.
      throw new BadRequestException(
        tr(
          "errors.push.channelNotConfigured",
          "This instance has no push key pair yet, so the browser push channel cannot be switched on or off.",
        ),
      );
    }
    return this.getAdminConfig();
  }

  /**
   * Mint a new key pair and disable every subscription in one transaction.
   *
   * The two halves are one decision, not two: a subscription created under the
   * old key can never be delivered to again -- the push service validates the
   * signature against the key the subscription was minted with -- so leaving
   * those rows enabled would be an interface that lists devices it cannot
   * reach. Either both land or neither does.
   */
  async rotateKeyPair(): Promise<{
    config: AdminPushConfig;
    disabled: number;
  }> {
    if (!this.encryption.isConfigured()) {
      // Returning the unchanged config here reported a refusal as a success:
      // the caller got 200 and "0 devices must register again", which is also
      // what a genuine no-op rotation looks like.
      throw new BadRequestException(
        tr(
          "errors.push.rotationUnavailable",
          `${ENCRYPTION_KEY_ENV} is not set, so a new private key could not be stored encrypted. Set it and restart before rotating.`,
        ),
      );
    }
    const generated = webpush.generateVAPIDKeys();
    const disabled = await withSystemContext(() =>
      withScopedDb(this.dataSource, async (manager) => {
        await manager.query(
          `INSERT INTO push_instance_config
             (id, vapid_public_key, vapid_private_key_enc, vapid_generated_at, updated_at)
           VALUES (TRUE, $1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
           ON CONFLICT (id) DO UPDATE
              SET vapid_public_key = EXCLUDED.vapid_public_key,
                  vapid_private_key_enc = EXCLUDED.vapid_private_key_enc,
                  vapid_generated_at = EXCLUDED.vapid_generated_at,
                  updated_at = EXCLUDED.updated_at`,
          [generated.publicKey, this.encryption.encrypt(generated.privateKey)],
        );
        return this.disableStaleSubscriptions(manager, generated.publicKey);
      }),
    );
    this.logger.log(
      `Rotated the Web Push key pair (fingerprint ${fingerprintPublicKey(generated.publicKey)}); ${disabled} subscription(s) must re-register`,
    );
    return { config: await this.getAdminConfig(), disabled };
  }

  /**
   * Disable every live subscription not minted under `currentPublicKey`.
   *
   * Takes an `EntityManager` rather than opening its own transaction so the
   * rotation's two writes commit together.
   */
  private async disableStaleSubscriptions(
    manager: EntityManager,
    currentPublicKey: string,
  ): Promise<number> {
    return affectedRowCount(
      await manager.query(
        `UPDATE push_subscriptions
            SET disabled_at = CURRENT_TIMESTAMP, disabled_reason = $1
          WHERE disabled_at IS NULL
            AND vapid_public_key <> $2`,
        [PushDisabledReason.KEY_ROTATED, currentPublicKey],
      ),
    );
  }
}
