import { Check, Column, Entity, PrimaryColumn } from "typeorm";

/**
 * This deployment's OIDC signing identity: one JWKS per Monize instance, not
 * one per process.
 *
 * Without it `oidc-provider` mints a development key pair at boot, so every
 * replica signs ID tokens with its own keys and serves its own `/oauth/jwks`.
 * A client that fetched the document from one pod finds no matching `kid` for a
 * token minted by another and rejects it -- and a single pod does the same to
 * itself across a restart.
 *
 * Deployment-wide state with no owner column, so the table is RLS-exempt for
 * the same reason `push_instance_config` is
 * (`backend/src/common/db/rls-exempt-tables.ts`,
 * `docs/row-level-security-contract.md`).
 */
@Entity("oauth_instance_config")
// See `UpdateCheckState`: the singleton constraint has to be on the entity or
// the harness builds a table a second row fits into, and the race spec that
// proves one JWKS per deployment is then contending over a weaker schema than
// production has.
@Check("id")
export class OauthInstanceConfig {
  /**
   * Singleton discriminator. The column admits exactly one value, so a second
   * insert is a conflict rather than a second issuer identity -- which is what
   * lets `INSERT ... ON CONFLICT DO NOTHING` arbitrate between replicas racing
   * on first start.
   */
  @PrimaryColumn({ type: "boolean", default: true })
  id: boolean;

  /**
   * AES-256-GCM ciphertext of the JWKS, private halves included.
   *
   * Encrypted rather than stored plain because this is the key material that
   * signs for the issuer: anyone holding it can mint an ID token this
   * deployment will vouch for. A deployment with no `ENCRYPTION_KEY` writes no
   * row at all.
   */
  @Column({ name: "jwks_enc", type: "text" })
  jwksEnc: string;

  @Column({
    name: "generated_at",
    type: "timestamptz",
    default: () => "CURRENT_TIMESTAMP",
  })
  generatedAt: Date;
}
