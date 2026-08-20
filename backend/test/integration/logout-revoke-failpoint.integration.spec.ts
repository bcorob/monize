import { Test, TestingModule } from "@nestjs/testing";
import { ConfigModule } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { TypeOrmModule } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { TokenService } from "@/auth/token.service";
import { hashToken } from "@/auth/crypto.util";
import { withSystemContext } from "@/common/db/with-context";
import {
  INTEGRATION_TYPEORM_OPTIONS,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { applyRlsPolicies } from "../helpers/rls-setup";

/**
 * INV-AUTH-004 -- the load-bearing failpoint (verification-contract.md marks a
 * failpoint as load-bearing for this invariant, and a mocked controller test is
 * only supporting).
 *
 * The property: a logout that did not revoke the session must never be presented
 * as a completed logout. The realistic failure is not the service *choosing* to
 * reject -- it is the family-revocation write failing at the database boundary.
 * The controller (`auth.controller.ts` logout) awaits `revokeRefreshToken` with
 * no try/catch, so the guarantee holds only if the service surfaces such a
 * failure rather than swallowing it and resolving.
 *
 * This test forces exactly that: a real `refresh_tokens` row, a `BEFORE UPDATE`
 * trigger that raises inside the database (so the revoke's own UPDATE fails at
 * the boundary, not a mock), and then the real `TokenService.revokeRefreshToken`
 * -- the method the controller awaits. It must reject, and the token family must
 * stay live (is_revoked still false), so nothing downstream can report a
 * completed logout. The companion controller unit test
 * (`auth.controller.spec.ts`, "does not report a completed logout when the revoke
 * fails") covers the other half: that the controller propagates the rejection
 * without clearing cookies or emitting the success body.
 *
 * Still owed per the matrix: the user-visible E2E assertion (the browser is not
 * shown a successful logout). The failpoint here is the load-bearing kind.
 */
describe("logout revoke failpoint (integration, INV-AUTH-004)", () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let tokenService: TokenService;
  let userId: string;

  const RAW_REFRESH_TOKEN = "failpoint-raw-refresh-token-value-0123456789";
  const tokenHash = hashToken(RAW_REFRESH_TOKEN);

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        JwtModule.register({
          secret: process.env.JWT_SECRET || "test_secret_for_failpoint_spec_32",
        }),
        TypeOrmModule.forRoot(INTEGRATION_TYPEORM_OPTIONS),
      ],
      providers: [TokenService],
    }).compile();

    dataSource = module.get(DataSource);
    await applyRlsPolicies(dataSource);
    tokenService = module.get(TokenService);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    // The trigger from a prior run must never leak into an unrelated one.
    await dropFailpoint();
    await cleanTables(dataSource, ["refresh_tokens", "users"]);

    const user = await createTestUserDirect(dataSource);
    userId = user.id;

    await dataSource.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, family_id, is_revoked, expires_at)
       VALUES ($1, $2, gen_random_uuid(), false, now() + interval '30 days')`,
      [userId, tokenHash],
    );
  });

  afterEach(async () => {
    await dropFailpoint();
  });

  async function installFailpoint(): Promise<void> {
    await dataSource.query(
      `CREATE OR REPLACE FUNCTION test_fail_revoke() RETURNS trigger
         LANGUAGE plpgsql AS $$
       BEGIN
         RAISE EXCEPTION 'failpoint: refresh-token revoke blocked';
       END;
       $$;`,
    );
    await dataSource.query(
      `CREATE TRIGGER test_fail_revoke
         BEFORE UPDATE ON refresh_tokens
         FOR EACH ROW EXECUTE FUNCTION test_fail_revoke();`,
    );
  }

  async function dropFailpoint(): Promise<void> {
    await dataSource.query(
      `DROP TRIGGER IF EXISTS test_fail_revoke ON refresh_tokens;`,
    );
    await dataSource.query(`DROP FUNCTION IF EXISTS test_fail_revoke();`);
  }

  async function isRevoked(): Promise<boolean> {
    const rows: { is_revoked: boolean }[] = await dataSource.query(
      `SELECT is_revoked FROM refresh_tokens WHERE token_hash = $1`,
      [tokenHash],
    );
    return rows[0].is_revoked;
  }

  it("rejects and leaves the family live when the revocation write fails", async () => {
    await installFailpoint();

    await expect(
      withSystemContext(() =>
        tokenService.revokeRefreshToken(RAW_REFRESH_TOKEN),
      ),
    ).rejects.toThrow(/failpoint: refresh-token revoke blocked/);

    // The whole revoke transaction rolled back, so the session the user believes
    // they ended is still live. A caller that reported success here would be
    // lying to the user -- which is what INV-AUTH-004 forbids.
    expect(await isRevoked()).toBe(false);
  });

  it("control: without the failpoint the same call revokes the family", async () => {
    // Proves the failpoint test is not vacuously green: the identical call, with
    // no trigger in the way, does revoke -- so the rejection above is caused by
    // the write failing, not by the token being unfindable.
    await withSystemContext(() =>
      tokenService.revokeRefreshToken(RAW_REFRESH_TOKEN),
    );

    expect(await isRevoked()).toBe(true);
  });
});
