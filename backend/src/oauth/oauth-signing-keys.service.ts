import { Injectable, Logger } from "@nestjs/common";
import { DataSource } from "typeorm";
import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";

import { withScopedDb } from "../common/db/scoped-db";
import { withSystemContext } from "../common/db/with-context";
import { EncryptionService } from "../common/encryption/encryption.service";
import { ENCRYPTION_KEY_ENV } from "../common/encryption/encryption-key";
import { OauthInstanceConfig } from "./entities/oauth-instance-config.entity";

/**
 * One private signing key as JSON.
 *
 * Spelled out rather than reusing the platform's `JsonWebKey`, which carries no
 * `kid`: the key id is the whole point here (it is what a client matches a
 * token's header against), so the type has to require it.
 */
export interface SigningJwk {
  kty?: string;
  kid: string;
  use: string;
  [member: string]: unknown;
}

/** A JWKS as `oidc-provider` takes it: private keys, `kid` and `use` included. */
export interface InstanceJwks {
  keys: SigningJwk[];
}

/**
 * The deployment's OIDC signing keys, generated once and read from a row after
 * that.
 *
 * `oidc-provider` mints a development key pair when none is supplied, and it
 * mints a *different* one in every process. Two replicas therefore serve two
 * `/oauth/jwks` documents, and a client that fetched one rejects a token signed
 * by the other for having no matching `kid`; a single replica does the same to
 * itself every time it restarts. One row is what makes the issuer one issuer.
 *
 * Every method seeds its own identity. The only caller is the provider's
 * initialization, which has no request behind it, and the row belongs to the
 * deployment rather than to anyone -- so the reads and writes run under
 * `withSystemContext`, exactly as `PushConfigService` does for the same shape
 * of singleton.
 *
 * Rotation is out of scope: see the design doc, WP4. Nothing here removes or
 * re-mints a key, so a stored JWKS lives until an operator deletes the row.
 */
@Injectable()
export class OauthSigningKeysService {
  private readonly logger = new Logger(OauthSigningKeysService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly encryption: EncryptionService,
  ) {}

  /**
   * The deployment's JWKS, minting it on first start.
   *
   * `null` means "carry on without one": no `ENCRYPTION_KEY`, so there is
   * nowhere to put private signing keys that is better than not storing them,
   * and the caller keeps per-process keys. Unreachable in a booted server,
   * which refuses to start without a key (`checkClusterBoot`); kept for the
   * entry points that construct this service outside that path.
   *
   * The whole method runs under system context, the initial read included: the
   * provider's `onModuleInit` has no request to inherit an identity from, so a
   * bare `withScopedDb` would throw before reading anything.
   */
  ensureJwks(): Promise<InstanceJwks | null> {
    return withSystemContext(() => this.ensureJwksInContext());
  }

  private async ensureJwksInContext(): Promise<InstanceJwks | null> {
    const existing = await this.readJwks();
    if (existing) return existing;

    if (!this.encryption.isConfigured()) {
      this.logger.warn(
        `OIDC signing keys are per process: ${ENCRYPTION_KEY_ENV} is not set, ` +
          "so they cannot be stored encrypted. Every restart and every replica " +
          "serves a different /oauth/jwks, and a token signed by one is not " +
          "verifiable against another. Set it and restart to fix this.",
      );
      return null;
    }

    const generated: InstanceJwks = {
      keys: [generateRsaJwk(), generateEcJwk()],
    };
    const ciphertext = this.encryption.encrypt(JSON.stringify(generated));

    return withScopedDb(this.dataSource, async (manager) => {
      // Every replica runs the provider's init, so the insert is the arbiter
      // rather than a read-then-write. A conflict means another replica won,
      // and the authoritative row is re-read inside this same transaction --
      // never assembled from the keys we tried to insert, which would leave two
      // replicas signing with two identities and both believing they had
      // stored theirs.
      await manager.query(
        `INSERT INTO oauth_instance_config (id, jwks_enc, generated_at)
           VALUES (TRUE, $1, CURRENT_TIMESTAMP)
           ON CONFLICT (id) DO NOTHING`,
        [ciphertext],
      );
      const stored = await this.decodeRow(
        manager.getRepository(OauthInstanceConfig),
      );
      if (stored && sameKeyIds(stored, generated)) {
        this.logger.log(
          `Generated this deployment's OIDC signing keys (kids ${keyIds(stored).join(", ")})`,
        );
      }
      return stored;
    });
  }

  /**
   * The stored JWKS, or `null` when this deployment has none yet or cannot read
   * the one it has.
   *
   * An unreadable row is `null` rather than a throw: that is what a database
   * restored onto an instance with a different `ENCRYPTION_KEY` leaves behind,
   * and refusing to boot the OAuth provider over it would take the whole MCP
   * surface down for a key an operator can simply rotate by deleting the row.
   * AES-GCM authenticates, so a wrong key raises rather than yielding plausible
   * bytes -- which is what makes this answerable at all.
   */
  readJwks(): Promise<InstanceJwks | null> {
    return withScopedDb(this.dataSource, (manager) =>
      this.decodeRow(manager.getRepository(OauthInstanceConfig)),
    );
  }

  private async decodeRow(repo: {
    findOne: (options: {
      where: { id: boolean };
    }) => Promise<OauthInstanceConfig | null>;
  }): Promise<InstanceJwks | null> {
    const row = await repo.findOne({ where: { id: true } });
    if (!row) return null;
    if (!this.encryption.isConfigured()) {
      this.logger.warn(
        `This deployment has stored OIDC signing keys but ${ENCRYPTION_KEY_ENV} ` +
          "is not set, so they cannot be read. Falling back to per-process keys.",
      );
      return null;
    }
    try {
      return JSON.parse(this.encryption.decrypt(row.jwksEnc)) as InstanceJwks;
    } catch {
      this.logger.error(
        "Stored OIDC signing keys could not be decrypted -- this instance's " +
          `${ENCRYPTION_KEY_ENV} does not match the one that wrote them. ` +
          "Falling back to per-process keys; delete the oauth_instance_config " +
          "row to mint a new set.",
      );
      return null;
    }
  }
}

/** The `kid`s a JWKS carries, in order. */
export function keyIds(jwks: InstanceJwks): string[] {
  return jwks.keys.map((key) => key.kid);
}

function sameKeyIds(a: InstanceJwks, b: InstanceJwks): boolean {
  return keyIds(a).join(",") === keyIds(b).join(",");
}

function generateRsaJwk(): SigningJwk {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return signingJwk(privateKey);
}

function generateEcJwk(): SigningJwk {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return signingJwk(privateKey);
}

/**
 * A private key as a signing JWK, with a `kid` derived from the key itself.
 *
 * `node:crypto` rather than `jose`: the two calls above are all this needs, and
 * `jose` is ESM-only, so reaching it from this CommonJS build would mean a
 * dynamic import and a new direct dependency to do what the platform already
 * does synchronously.
 *
 * The `kid` is the RFC 7638 thumbprint, so it is a function of the key and two
 * replicas that somehow generated the same key would agree on its name. A
 * random id would work for `oidc-provider`, but then a `kid` would say nothing
 * about which key it refers to.
 */
function signingJwk(privateKey: KeyObject): SigningJwk {
  const jwk = privateKey.export({ format: "jwk" });
  return { ...jwk, kid: thumbprint(jwk), use: "sig" };
}

/**
 * RFC 7638 JWK thumbprint: SHA-256 over the required members only, in lexical
 * order, with no whitespace. The member list is per key type and is deliberately
 * exhaustive rather than "everything public" -- a thumbprint that included
 * optional members would change when they did.
 */
function thumbprint(jwk: JsonWebKey): string {
  const required =
    jwk.kty === "RSA"
      ? { e: jwk.e, kty: jwk.kty, n: jwk.n }
      : { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y };
  return createHash("sha256")
    .update(JSON.stringify(required))
    .digest("base64url");
}
