import { Test, TestingModule } from "@nestjs/testing";
import { ConfigModule } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { TypeOrmModule } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { TokenService } from "@/auth/token.service";
import { hashToken } from "@/auth/crypto.util";
import { withUserContext } from "@/common/db/with-context";
import { User } from "@/users/entities/user.entity";
import {
  INTEGRATION_TYPEORM_OPTIONS,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { applyRlsPolicies } from "../helpers/rls-setup";
import { raceTwo } from "../helpers/race";

type TokenPair = { accessToken: string; refreshToken: string };

/**
 * Refresh-token rotation against logout and against itself, on two real
 * connections (audit A26-M42 / A26-S03-04; INV-AUTH-001, INV-AUTH-004).
 *
 * The mechanism is `lockTokenFamily`, a transaction-scoped advisory lock keyed
 * by family id, taken FIRST by both `refreshTokens` and `revokeTokenFamily`
 * (and therefore by `revokeRefreshToken`, whose lookup joins the same
 * transaction), followed in `refreshTokens` by a `pessimistic_write` re-read of
 * the token row. Revocation is `UPDATE ... WHERE family_id = ?`; under READ
 * COMMITTED it uses one statement snapshot, so a rotation that inserts its
 * successor after that snapshot is invisible to it. Only the family lock orders
 * the two so that the successor either exists before the UPDATE starts or is
 * never created.
 *
 * The first describe is a timing race, so it cannot be forced by a gate: the
 * interleaving that leaks is "rotation inserts its successor between logout's
 * snapshot and its commit", which depends on where each racer is when the other
 * starts. It runs 40 iterations with a 0-3 ms stagger, alternating which racer
 * starts late, to sweep the window. Do not lower the count: the audit's probe saw
 * 48 of 60 and 59 of 60 leaks with the locks removed, and a smaller loop turns a
 * regression into an intermittent pass.
 * Catches: deleting `await lockTokenFamily(manager, familyId);` in
 * `revokeTokenFamily`, or `await lockTokenFamily(manager, familyProbe.familyId);`
 * in `refreshTokens`.
 *
 * The second describe forces its interleaving with a gate: a test-held
 * `SELECT ... FOR UPDATE` on the presented token row. Both rotations have read
 * the row unlocked by the time they reach it. With the mechanism the first takes
 * the family lock and parks on the row, and the second parks on the family lock;
 * with neither lock both only park at the row write, after reading the token as
 * unrevoked, and on release each rotates it. Either way two backends are
 * lock-blocked, which is what `raceTwo` waits for, so the gate is released at the
 * same point in both arrangements.
 * Catches: deleting BOTH the `lockTokenFamily` call and the
 * `lock: { mode: "pessimistic_write" }` option of the re-read in `refreshTokens`
 * (either alone is still serialized by the other).
 * The loser presents a predecessor whose successor is live and seconds old, so
 * it gets the second-tab grace answer (A26-M03): an access token and
 * `refreshToken: null`, nothing revoked and nothing minted. Both rotations
 * fulfil; exactly one mints.
 */
describe("refresh-token concurrency (integration, INV-AUTH-001, INV-AUTH-004)", () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let tokenService: TokenService;
  let user: User;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        JwtModule.register({
          secret:
            process.env.JWT_SECRET || "test_secret_for_auth_concurrency_32ch",
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
    await cleanTables(dataSource, ["refresh_tokens", "users"]);
    user = await createTestUserDirect(dataSource);
  });

  const asUser = <T>(fn: () => Promise<T>): Promise<T> =>
    withUserContext(user.id, fn);

  const familyOf = async (rawToken: string): Promise<string> => {
    const [row]: { family_id: string }[] = await dataSource.query(
      `SELECT family_id FROM refresh_tokens WHERE token_hash = $1`,
      [hashToken(rawToken)],
    );
    return row.family_id;
  };

  const liveHashes = async (familyId: string): Promise<string[]> => {
    const rows: { token_hash: string }[] = await dataSource.query(
      `SELECT token_hash FROM refresh_tokens
        WHERE family_id = $1 AND is_revoked = false`,
      [familyId],
    );
    return rows.map((r) => r.token_hash);
  };

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  describe("logout racing a rotation of the same token (INV-AUTH-004)", () => {
    const ITERATIONS = 40;

    it(`leaves no live member of the family in any of ${ITERATIONS} staggered races`, async () => {
      const leaks: string[] = [];

      for (let i = 0; i < ITERATIONS; i += 1) {
        const pair: TokenPair = await asUser(() =>
          tokenService.generateTokenPair(user),
        );
        const t0 = pair.refreshToken;
        const familyId = await familyOf(t0);

        const stagger = i % 4;
        const logoutStartsLate = Math.floor(i / 4) % 2 === 0;
        const outcome = await raceTwo(
          dataSource,
          async () => {
            if (!logoutStartsLate) await sleep(stagger);
            return asUser(() => tokenService.refreshTokens(t0));
          },
          async () => {
            if (logoutStartsLate) await sleep(stagger);
            return asUser(() => tokenService.revokeRefreshToken(t0));
          },
        );

        // Logout must always fulfil: it either finds the token or does not.
        expect(outcome.b.status).toBe("fulfilled");

        const live = await liveHashes(familyId);
        if (live.length > 0) {
          leaks.push(
            `iteration ${i} (stagger ${stagger} ms, rotation ` +
              `${outcome.a.status}): ${live.length} live member(s)`,
          );
        }
      }

      // A completed logout with a usable token left in the family is the
      // defect; name every iteration that showed it.
      expect(leaks).toEqual([]);
    }, 120_000);
  });

  describe("two concurrent rotations of one token (INV-AUTH-001)", () => {
    it("yield exactly one live successor, the minting winner's", async () => {
      const pair: TokenPair = await asUser(() =>
        tokenService.generateTokenPair(user),
      );
      const t0 = pair.refreshToken;
      const familyId = await familyOf(t0);

      const outcome = await raceTwo(
        dataSource,
        () => asUser(() => tokenService.refreshTokens(t0)),
        () => asUser(() => tokenService.refreshTokens(t0)),
        {
          gate: {
            sql: `SELECT 1 FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`,
            params: [hashToken(t0)],
          },
        },
      );

      expect(outcome.fulfilled).toBe(2);
      expect(outcome.reasons).toHaveLength(0);

      const minted = [outcome.a, outcome.b]
        .flatMap((r) =>
          r.status === "fulfilled" ? [r.value.refreshToken] : [],
        )
        .filter((token): token is string => token !== null);
      expect(minted).toHaveLength(1);

      // Exactly one live row, and it is the token the minting winner was handed.
      expect(await liveHashes(familyId)).toEqual([hashToken(minted[0])]);
    });
  });
});
