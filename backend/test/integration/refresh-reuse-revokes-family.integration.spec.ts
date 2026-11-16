import { Test, TestingModule } from "@nestjs/testing";
import { ConfigModule } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { TypeOrmModule } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { TokenService } from "@/auth/token.service";
import { hashToken } from "@/auth/crypto.util";
import { withSystemContext } from "@/common/db/with-context";
import { User } from "@/users/entities/user.entity";
import {
  INTEGRATION_TYPEORM_OPTIONS,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { applyRlsPolicies } from "../helpers/rls-setup";

/**
 * INV-AUTH-001 against real PostgreSQL (A26-H01, A26-M03).
 *
 * The unit spec mocks `withScopedDb`'s transaction, so a call to `update` there
 * is indistinguishable from a committed update. That is how the reuse branch's
 * family revocation shipped rolled back by the very exception that reported it:
 * the thief's successor stayed live and kept rotating. Every assertion below
 * reads what the database committed, after the call resolved or rejected.
 *
 * The grace cases pin the other half: two tabs of one browser presenting the
 * same cookie a moment apart are not theft. The immediate predecessor of a
 * still-live successor minted within the grace window is answered with an
 * access token and no new refresh token, and revokes nothing; anything older,
 * or a predecessor whose successor has itself rotated, is reuse.
 */
describe("refresh reuse revokes the family (integration, INV-AUTH-001)", () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let tokens: TokenService;
  let user: User;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        JwtModule.register({
          secret: process.env.JWT_SECRET || "test_secret_for_refresh_reuse_32",
        }),
        TypeOrmModule.forRoot(INTEGRATION_TYPEORM_OPTIONS),
      ],
      providers: [TokenService],
    }).compile();

    dataSource = module.get(DataSource);
    await applyRlsPolicies(dataSource);
    tokens = module.get(TokenService);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, ["refresh_tokens", "users"]);
    user = await createTestUserDirect(dataSource);
  });

  const refresh = (raw: string) =>
    withSystemContext(() => tokens.refreshTokens(raw));

  async function liveTokens(): Promise<number> {
    const rows: { n: number }[] = await dataSource.query(
      `SELECT count(*)::int AS n FROM refresh_tokens
        WHERE user_id = $1 AND is_revoked = false`,
      [user.id],
    );
    return rows[0].n;
  }

  /** Move a token's mint time back, as if it were rotated long ago. */
  async function ageToken(raw: string, seconds: number): Promise<void> {
    await dataSource.query(
      `UPDATE refresh_tokens
          SET created_at = created_at - make_interval(secs => $2)
        WHERE token_hash = $1`,
      [hashToken(raw), seconds],
    );
  }

  async function firstPair(): Promise<string> {
    const { refreshToken } = await withSystemContext(() =>
      tokens.generateTokenPair(user, false),
    );
    return refreshToken;
  }

  async function rotated(raw: string): Promise<string> {
    const { refreshToken } = await refresh(raw);
    if (!refreshToken)
      throw new Error("expected a rotation, got a grace answer");
    return refreshToken;
  }

  it("a reused token revokes the successor durably once the grace has passed", async () => {
    const t0 = await firstPair();
    const t1 = await rotated(t0);
    await ageToken(t1, 120);

    await expect(refresh(t0)).rejects.toThrow("Refresh token reuse detected");

    expect(await liveTokens()).toBe(0);
    await expect(refresh(t1)).rejects.toThrow("Refresh token reuse detected");
  });

  it("a token presented after its successor rotated revokes the family, grace or not", async () => {
    const t0 = await firstPair();
    const t1 = await rotated(t0);
    const t2 = await rotated(t1);

    await expect(refresh(t0)).rejects.toThrow("Refresh token reuse detected");

    expect(await liveTokens()).toBe(0);
    await expect(refresh(t2)).rejects.toThrow("Refresh token reuse detected");
  });

  it("the immediate predecessor inside the grace gets an access token and revokes nothing", async () => {
    const t0 = await firstPair();
    const t1 = await rotated(t0);

    const second = await refresh(t0);

    expect(second.accessToken).toEqual(expect.any(String));
    expect(second.refreshToken).toBeNull();
    expect(second.userId).toBe(user.id);
    expect(await liveTokens()).toBe(1);
    // The successor the first tab received keeps working.
    await expect(refresh(t1)).resolves.toMatchObject({
      refreshToken: expect.any(String),
    });
  });

  it("two concurrent refreshes of one token leave exactly one live successor", async () => {
    const t0 = await firstPair();

    const results = await Promise.allSettled([refresh(t0), refresh(t0)]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(2);
    const minted = fulfilled
      .map((r) => r.value.refreshToken)
      .filter((v): v is string => v !== null);
    expect(minted).toHaveLength(1);
    expect(await liveTokens()).toBe(1);
  });

  it("an expired token is refused and its revocation is committed", async () => {
    const t0 = await firstPair();
    await dataSource.query(
      `UPDATE refresh_tokens SET expires_at = now() - interval '1 minute'
        WHERE token_hash = $1`,
      [hashToken(t0)],
    );

    await expect(refresh(t0)).rejects.toThrow("Refresh token expired");

    expect(await liveTokens()).toBe(0);
  });

  it("an inactive user's family is revoked durably", async () => {
    const t0 = await firstPair();
    const t1 = await rotated(t0);
    await dataSource.query(`UPDATE users SET is_active = false WHERE id = $1`, [
      user.id,
    ]);

    await expect(refresh(t1)).rejects.toThrow("User not found or inactive");

    expect(await liveTokens()).toBe(0);
  });
});
