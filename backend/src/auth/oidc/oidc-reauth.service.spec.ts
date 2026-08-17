import { UnauthorizedException } from "@nestjs/common";
import * as fs from "fs";
import * as path from "path";
import * as jwt from "jsonwebtoken";
import { createScopedDbMocks } from "../../test-helpers/scoped-db-testing";

jest.mock("../../common/db/scoped-db", () =>
  jest
    .requireActual("../../test-helpers/scoped-db-testing")
    .scopedDbMockModule(),
);

import {
  OIDC_REAUTH_PURPOSES,
  OIDC_REAUTH_TTL_SECONDS,
  OidcReauthService,
  isFreshAuthentication,
  isOidcReauthPurpose,
} from "./oidc-reauth.service";

const SECRET = "test-jwt-secret-at-least-thirty-two-characters";
const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

/**
 * A stand-in for the `oidc_step_up_claims` table: `INSERT ... ON CONFLICT DO
 * NOTHING ... RETURNING jti` returns one row for the caller that created it and
 * none for anyone else. Shared between service instances in the multi-replica
 * tests below, which is the whole point of moving the ledger out of the
 * process.
 */
function makeClaimStore() {
  const rows = new Set<string>();
  return {
    rows,
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("DELETE FROM oidc_step_up_claims")) return [];
      const jti = String(params?.[0]);
      if (rows.has(jti)) return [];
      rows.add(jti);
      return [{ jti }];
    }),
  };
}

describe("OidcReauthService", () => {
  let service: OidcReauthService;
  let claimStore: ReturnType<typeof makeClaimStore>;
  const originalSecret = process.env.JWT_SECRET;

  const buildService = (
    store: ReturnType<typeof makeClaimStore> = claimStore,
  ) => {
    const { manager, dataSource } = createScopedDbMocks([]);
    manager.query.mockImplementation(store.query);
    return new OidcReauthService(dataSource as never);
  };

  beforeEach(() => {
    process.env.JWT_SECRET = SECRET;
    claimStore = makeClaimStore();
    service = buildService();
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
  });

  describe("purpose vocabulary", () => {
    it("recognizes each destructive action and nothing else", () => {
      for (const purpose of OIDC_REAUTH_PURPOSES) {
        expect(isOidcReauthPurpose(purpose)).toBe(true);
      }
      for (const value of ["", "delete", "DELETE-ACCOUNT", null, 7, {}]) {
        expect(isOidcReauthPurpose(value)).toBe(false);
      }
    });
  });

  describe("isFreshAuthentication", () => {
    const now = 1_700_000_000_000; // fixed epoch ms, so the cases are exact
    const nowSeconds = Math.floor(now / 1000);
    const flowStart = nowSeconds - 30; // the flow began 30s ago

    it("accepts an authentication during the flow", () => {
      expect(isFreshAuthentication(nowSeconds - 5, flowStart, now)).toBe(true);
      expect(isFreshAuthentication(flowStart, flowStart, now)).toBe(true);
    });

    it("rejects a warm session whose auth predates the flow, even if recent", () => {
      // The hole this anchoring closes: an auth from two minutes ago is well
      // inside any now-relative window, but it happened before this challenge
      // began, so a non-compliant provider replaying it must not pass.
      const flowJustStarted = nowSeconds - 10;
      expect(
        isFreshAuthentication(nowSeconds - 120, flowJustStarted, now),
      ).toBe(false);
    });

    it("tolerates clock skew either side of the flow start", () => {
      // Our clock a little ahead of the IdP's can put a genuine fresh auth just
      // before the recorded flow start; a minute of drift is skew, not a replay.
      expect(isFreshAuthentication(flowStart - 60, flowStart, now)).toBe(true);
      expect(isFreshAuthentication(flowStart - 61, flowStart, now)).toBe(false);
    });

    it("rejects a reused SSO session from this morning", () => {
      expect(isFreshAuthentication(nowSeconds - 6 * 3600, flowStart, now)).toBe(
        false,
      );
    });

    it("tolerates small clock skew ahead of us, but not a future claim", () => {
      // The IdP's clock running up to a minute ahead is skew, not an attack.
      expect(isFreshAuthentication(nowSeconds + 59, flowStart, now)).toBe(true);
      expect(isFreshAuthentication(nowSeconds + 61, flowStart, now)).toBe(
        false,
      );
    });

    it("treats an absent or malformed claim as not fresh", () => {
      // A provider that omits auth_time has not answered the question.
      expect(isFreshAuthentication(undefined, flowStart, now)).toBe(false);
      expect(isFreshAuthentication(Number.NaN, flowStart, now)).toBe(false);
      expect(isFreshAuthentication(Infinity, flowStart, now)).toBe(false);
    });
  });

  describe("consume", () => {
    it("accepts an artifact it issued for the same user and action", async () => {
      const artifact = service.issue(USER, "delete-account");

      await expect(
        service.consume(USER, "delete-account", artifact),
      ).resolves.toBeUndefined();
    });

    // The defect. Every one of these was accepted before: the check was
    // `if (!oidcIdToken) throw`, so any non-empty string passed -- and the
    // frontend sent the literal "oidc-session-confirmed".
    it.each([
      ["the old sentinel", "oidc-session-confirmed"],
      ["a single character", "x"],
      ["an empty string", ""],
      ["undefined", undefined],
      ["something JWT-shaped but unsigned", "a.b.c"],
    ])("rejects %s", async (_label, token) => {
      await expect(
        service.consume(USER, "delete-account", token as string | undefined),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("rejects an artifact signed with a different key", async () => {
      const forged = jwt.sign(
        {
          sub: USER,
          type: "oidc_reauth",
          purpose: "delete-account",
          jti: "forged",
        },
        "a-different-secret-of-sufficient-length!!",
        { algorithm: "HS256", expiresIn: 300 },
      );

      await expect(
        service.consume(USER, "delete-account", forged),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("rejects an unsigned (alg=none) artifact", async () => {
      // The classic JWT forgery. `algorithms: ["HS256"]` on verify is what stops
      // it, and this asserts that option is actually set.
      const unsigned = jwt.sign(
        {
          sub: USER,
          type: "oidc_reauth",
          purpose: "delete-account",
          jti: "none",
        },
        "",
        { algorithm: "none" },
      );

      await expect(
        service.consume(USER, "delete-account", unsigned),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("rejects an artifact minted for a different user", async () => {
      const artifact = service.issue(OTHER, "delete-account");

      await expect(
        service.consume(USER, "delete-account", artifact),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("rejects an artifact minted for a different action", async () => {
      // Action binding matters most between these two: deleting data and
      // restoring a backup are both destructive, but a restore overwrites
      // everything, and a user who confirmed one did not confirm the other.
      const artifact = service.issue(USER, "delete-data");

      await expect(
        service.consume(USER, "restore-backup", artifact),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("rejects an expired artifact", async () => {
      const stale = jwt.sign(
        {
          sub: USER,
          type: "oidc_reauth",
          purpose: "delete-account",
          jti: "stale",
        },
        SECRET,
        { algorithm: "HS256", expiresIn: -1 },
      );

      await expect(
        service.consume(USER, "delete-account", stale),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("rejects a well-formed artifact that carries no exp", async () => {
      // issue() always sets exp; a token without one never expires at the JWT
      // layer, so after the sweep dropped its claim row it could be re-claimed.
      // consume refuses it rather than assuming the invariant holds. Signed with
      // the real secret and every other claim present, so only the missing exp
      // can be what rejects it.
      const noExp = jwt.sign(
        {
          sub: USER,
          type: "oidc_reauth",
          purpose: "delete-account",
          jti: "no-exp",
        },
        SECRET,
        { algorithm: "HS256" },
      );

      await expect(
        service.consume(USER, "delete-account", noExp),
      ).rejects.toThrow(UnauthorizedException);
      // And nothing was claimed, so the ledger never saw it.
      expect(claimStore.rows.size).toBe(0);
    });

    it("rejects a token of another type carrying the right claims", async () => {
      // An ordinary access token has sub and a signature from the same secret.
      // Only `type` distinguishes it, and each type answers a different question.
      const accessToken = jwt.sign(
        { sub: USER, purpose: "delete-account", jti: "x" },
        SECRET,
        { algorithm: "HS256", expiresIn: 300 },
      );

      await expect(
        service.consume(USER, "delete-account", accessToken),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("rejects a step-up token, which is a different proof", async () => {
      const stepUp = jwt.sign(
        {
          sub: USER,
          type: "step_up",
          purpose: "emergency-access",
          jti: "y",
        },
        SECRET,
        { algorithm: "HS256", expiresIn: 300 },
      );

      await expect(
        service.consume(USER, "emergency-access", stepUp),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("refuses an artifact with no jti, which cannot be spent once", async () => {
      const noJti = jwt.sign(
        { sub: USER, type: "oidc_reauth", purpose: "delete-data" },
        SECRET,
        { algorithm: "HS256", expiresIn: 300 },
      );

      await expect(service.consume(USER, "delete-data", noJti)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("rejects everything invalid before touching the claim ledger", async () => {
      // Fail before writing: a garbage token must not spend a DB round trip,
      // and must leave no row behind.
      await expect(
        service.consume(USER, "delete-account", "garbage"),
      ).rejects.toThrow(UnauthorizedException);

      expect(claimStore.query).not.toHaveBeenCalled();
      expect(claimStore.rows.size).toBe(0);
    });

    it("spends an artifact exactly once", async () => {
      const artifact = service.issue(USER, "delete-data");

      await expect(
        service.consume(USER, "delete-data", artifact),
      ).resolves.toBeUndefined();
      await expect(
        service.consume(USER, "delete-data", artifact),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("records the claim with the jti, user and purpose, atomically", async () => {
      // INSERT ... ON CONFLICT DO NOTHING on the primary key is the mechanism
      // that makes the claim atomic across replicas; this pins that the insert
      // actually carries it, and that the expired-row sweep runs in the same
      // call rather than on a timer someone has to remember.
      const artifact = service.issue(USER, "delete-data");
      await service.consume(USER, "delete-data", artifact);

      const calls = claimStore.query.mock.calls.map((c) => String(c[0]));
      expect(
        calls.some((sql) =>
          sql.includes("DELETE FROM oidc_step_up_claims WHERE expires_at"),
        ),
      ).toBe(true);
      const insert = claimStore.query.mock.calls.find((c) =>
        String(c[0]).includes("INSERT INTO oidc_step_up_claims"),
      );
      expect(String(insert?.[0])).toContain("ON CONFLICT (jti) DO NOTHING");
      const params = insert?.[1] as unknown[];
      expect(params?.[1]).toBe(USER);
      expect(params?.[2]).toBe("delete-data");
      expect(params?.[3]).toBeInstanceOf(Date);
    });

    it("shares the spent record across instances and replicas", async () => {
      // UsersModule provides its own instance because it cannot import
      // AuthModule -- and on k8s each backend replica is a whole separate
      // process whose memory never sees the others' spends. The ledger is a
      // table, so a proof spent through one instance is spent for all of them:
      // two instances sharing the store stand in for two replicas sharing the
      // database.
      const artifact = service.issue(USER, "delete-data");
      const replicaB = buildService(claimStore);

      await expect(
        service.consume(USER, "delete-data", artifact),
      ).resolves.toBeUndefined();
      await expect(
        replicaB.consume(USER, "delete-data", artifact),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("lets exactly one of two concurrent verifies win", async () => {
      // The race the in-memory Map lost across replicas: both requests arrive
      // before either records the spend. The store answers the INSERT
      // atomically, so exactly one caller is told yes.
      const artifact = service.issue(USER, "delete-data");
      const replicaB = buildService(claimStore);

      const outcomes = await Promise.allSettled([
        service.consume(USER, "delete-data", artifact),
        replicaB.consume(USER, "delete-data", artifact),
      ]);

      const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
      const rejected = outcomes.filter((o) => o.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
    });

    it("gives the same message whichever check failed", async () => {
      // Which of signature / subject / action / freshness failed is a fact about
      // the server's secrets and state, so it goes to the log, not the response.
      const messages = new Set<string>();
      const cases: Array<() => Promise<void>> = [
        () => service.consume(USER, "delete-account", "garbage"),
        () =>
          service.consume(
            USER,
            "delete-account",
            service.issue(OTHER, "delete-account"),
          ),
        () =>
          service.consume(
            USER,
            "delete-account",
            service.issue(USER, "delete-data"),
          ),
      ];
      for (const run of cases) {
        try {
          await run();
        } catch (err) {
          messages.add((err as UnauthorizedException).message);
        }
      }

      expect(messages.size).toBe(1);
    });
  });

  describe("pending marker", () => {
    const STATE = "state-of-the-forced-round-trip";
    const OTHER_STATE = "state-of-some-other-round-trip";

    it("round-trips the purpose and flow start for the user who started the flow", () => {
      const marker = service.createPendingMarker(USER, "restore-backup", STATE);

      expect(service.readPendingMarker(marker, USER, STATE)).toEqual({
        purpose: "restore-backup",
        flowStartedAt: expect.any(Number),
      });
    });

    it("refuses a marker started by a different account", () => {
      // The IdP authenticated somebody else. Minting here would hand user A an
      // artifact for a round trip user B completed.
      const marker = service.createPendingMarker(
        OTHER,
        "restore-backup",
        STATE,
      );

      expect(service.readPendingMarker(marker, USER, STATE)).toBeNull();
    });

    it("refuses a marker minted for a different authorization request", () => {
      // FV-001. The marker outlives its redirect: a second authorization request
      // -- an ordinary GET /auth/oidc, which sends no prompt=login -- overwrites
      // oidc_state while the marker cookie survives. Completing that callback
      // must not mint an artifact, or a live IdP SSO session substitutes for the
      // fresh challenge the whole flow exists to force.
      const marker = service.createPendingMarker(USER, "delete-account", STATE);

      expect(service.readPendingMarker(marker, USER, OTHER_STATE)).toBeNull();
    });

    it("refuses a marker with no flow binding at all", () => {
      // A cookie left over from the build before the binding existed. An
      // unbindable marker is precisely the case the binding closes, so it fails
      // closed rather than falling back to the user check alone.
      const marker = jwt.sign(
        { sub: USER, type: "oidc_reauth_pending", purpose: "delete-account" },
        SECRET,
        { algorithm: "HS256", expiresIn: 300 },
      );

      expect(service.readPendingMarker(marker, USER, STATE)).toBeNull();
    });

    it("refuses an otherwise-valid marker that carries no iat", () => {
      // Freshness is anchored to the marker's iat (the flow start). Every marker
      // we mint has one; a bound marker without it is not ours, so it fails
      // closed rather than minting with no flow-start reference. Craft one by
      // reusing a genuine marker's flow-binding hash but signing with no iat.
      const genuine = service.createPendingMarker(
        USER,
        "delete-account",
        STATE,
      );
      const { sth } = jwt.decode(genuine) as { sth: string };
      const noIat = jwt.sign(
        {
          sub: USER,
          type: "oidc_reauth_pending",
          purpose: "delete-account",
          sth,
        },
        SECRET,
        { algorithm: "HS256", noTimestamp: true },
      );

      expect(service.readPendingMarker(noIat, USER, STATE)).toBeNull();
    });

    it("refuses a valid marker when the callback validated no state", () => {
      const marker = service.createPendingMarker(USER, "delete-account", STATE);

      expect(service.readPendingMarker(marker, USER, undefined)).toBeNull();
    });

    it("does not carry the state in readable form", () => {
      // The binding is a hash. The state is public in the redirect URL, so this
      // is tidiness rather than secrecy -- but a marker that repeated it would
      // invite someone to read the claim instead of comparing it.
      const marker = service.createPendingMarker(USER, "delete-account", STATE);
      const payload = jwt.decode(marker) as { sth?: string };

      expect(payload.sth).not.toContain(STATE);
      expect(payload.sth).toMatch(/^[0-9a-f]{64}$/);
    });

    it("refuses a forged or absent marker", () => {
      expect(service.readPendingMarker(undefined, USER, STATE)).toBeNull();
      expect(service.readPendingMarker("not-a-jwt", USER, STATE)).toBeNull();
      expect(
        service.readPendingMarker(
          jwt.sign(
            { sub: USER, type: "oidc_reauth_pending", purpose: "delete-data" },
            "wrong-secret-wrong-secret-wrong!!",
            { algorithm: "HS256", expiresIn: 300 },
          ),
          USER,
          STATE,
        ),
      ).toBeNull();
    });

    it("refuses a marker whose purpose is not a known action", () => {
      const marker = service.createPendingMarker(
        USER,
        "become-admin" as never,
        STATE,
      );

      expect(service.readPendingMarker(marker, USER, STATE)).toBeNull();
    });

    it("refuses an artifact presented as a marker", () => {
      // Different types for different jobs: an artifact must not be replayable
      // into the callback to mint another one.
      const artifact = service.issue(USER, "delete-data");

      expect(service.readPendingMarker(artifact, USER, STATE)).toBeNull();
    });
  });

  describe("issued artifacts", () => {
    it("expire within five minutes", () => {
      const decoded = jwt.decode(service.issue(USER, "delete-data")) as {
        iat: number;
        exp: number;
      };

      expect(decoded.exp - decoded.iat).toBe(OIDC_REAUTH_TTL_SECONDS);
    });

    it("carry a distinct jti each time", () => {
      const first = jwt.decode(service.issue(USER, "delete-data")) as {
        jti: string;
      };
      const second = jwt.decode(service.issue(USER, "delete-data")) as {
        jti: string;
      };

      expect(first.jti).not.toBe(second.jti);
    });
  });

  // The single-use guarantee is that two requests racing on one artifact insert
  // the same jti and exactly one wins. That rests entirely on `ON CONFLICT
  // (jti)` conflicting against a real UNIQUE/PRIMARY KEY: the in-memory claim
  // store above models a conflict on jti, but a mock cannot prove the column is
  // actually unique in the database. If a migration ever dropped the primary
  // key or changed the conflict target, every unit test here would stay green
  // while the real INSERT raised "no unique or exclusion constraint matching
  // the ON CONFLICT" at runtime. So bind the three artifacts -- the service's
  // conflict target, schema.sql, and migration 155 -- to one column here.
  describe("ledger conflict target is a real primary key", () => {
    const root = path.join(__dirname, "../../../..");
    const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
    const tableBlock = (sql: string) =>
      sql.match(
        /CREATE TABLE[^;]*?oidc_step_up_claims\s*\(([^;]*?)\)\s*;/is,
      )?.[1] ?? "";
    const pkColumn = (sql: string) =>
      tableBlock(sql).match(/(\w+)\s+[a-z ]*\bprimary key\b/i)?.[1];
    const serviceSource = read("backend/src/auth/oidc/oidc-reauth.service.ts");
    const conflictColumn = serviceSource.match(
      /ON CONFLICT \((\w+)\) DO NOTHING/i,
    )?.[1];

    it("declares jti PRIMARY KEY in schema.sql", () => {
      expect(pkColumn(read("database/schema.sql"))).toBe("jti");
    });

    it("declares jti PRIMARY KEY in migration 155", () => {
      expect(
        pkColumn(read("database/migrations/155_oidc_step_up_claims.sql")),
      ).toBe("jti");
    });

    it("targets that primary key in the INSERT's ON CONFLICT", () => {
      expect(conflictColumn).toBe("jti");
      expect(conflictColumn).toBe(pkColumn(read("database/schema.sql")));
    });
  });
});
