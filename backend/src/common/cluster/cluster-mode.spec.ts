import { readFileSync } from "fs";
import { join } from "path";
import {
  CLUSTER_MODES,
  MIN_JWT_SECRET_LENGTH,
  checkClusterBoot,
  getClusterMode,
  parseClusterMode,
} from "./cluster-mode";

/** The shape "openssl rand -base64 32" prints; a fixture, never a real key. */
const GOOD_SECRET = "FkVtZprB4sKbrwNIl6YiZarB8gB9RrKoO0rt7sFg4YM=";

/** The shape "openssl rand -hex 32" prints; a fixture, never a real key. */
const GOOD_ENCRYPTION_KEY =
  "3f9c2a7be41d8056c9e2f7a13b8d4c60e5f1a2b3c4d5e6f708192a3b4c5d6e7f";

/**
 * Both secrets every boot needs, spread into the rows that are about
 * something else so they do not also test the secret refusals.
 */
const SECRETS = {
  JWT_SECRET: GOOD_SECRET,
  ENCRYPTION_KEY: GOOD_ENCRYPTION_KEY,
} as const;

/**
 * What a `multi` deployment must assert about its storage before it can boot.
 *
 * Spread into the rows below that are about something else, so a row testing
 * the JWT secret is not also silently testing the storage refusals. The
 * storage rows state their own inputs.
 */
const SHARED_STORAGE = { BACKUP_SHARED_VOLUME: "true" } as const;

describe("parseClusterMode", () => {
  it.each([
    [undefined, "single"],
    [null, "single"],
    ["", "single"],
    ["   ", "single"],
    ["single", "single"],
    ["multi", "multi"],
    ["MULTI", "multi"],
    [" Multi ", "multi"],
  ])("parses %p as %s", (raw, expected) => {
    expect(parseClusterMode(raw as string | undefined | null)).toBe(expected);
  });

  it("throws on an unrecognized value rather than defaulting", () => {
    expect(() => parseClusterMode("cluster")).toThrow(
      /Invalid CLUSTER_MODE "cluster"/,
    );
  });

  it("names every mode in the error, so the message is the fix", () => {
    try {
      parseClusterMode("nope");
      fail("expected a throw");
    } catch (error) {
      for (const mode of CLUSTER_MODES) {
        expect((error as Error).message).toContain(mode);
      }
    }
  });
});

describe("getClusterMode", () => {
  const original = process.env.CLUSTER_MODE;

  afterEach(() => {
    if (original === undefined) delete process.env.CLUSTER_MODE;
    else process.env.CLUSTER_MODE = original;
  });

  it("reads process.env fresh", () => {
    delete process.env.CLUSTER_MODE;
    expect(getClusterMode()).toBe("single");
    process.env.CLUSTER_MODE = "multi";
    expect(getClusterMode()).toBe("multi");
  });
});

describe("checkClusterBoot", () => {
  it("passes a default single-replica deployment", () => {
    const report = checkClusterBoot({ ...SECRETS });
    expect(report).toEqual({ mode: "single", refusals: [], warnings: [] });
  });

  describe("the boot matrix", () => {
    const cases: {
      name: string;
      env: Parameters<typeof checkClusterBoot>[0];
      mode: string | null;
      refusals: RegExp[];
      warnings: RegExp[];
    }[] = [
      {
        // multi asks for no setting of its own: PostgreSQL is the only shared
        // store, so a secret is the whole of what the matrix can check here.
        // What multi additionally needs -- a database host that can hold
        // LISTEN, and cluster-safe attachment and backup storage -- is a
        // connection and a module's configuration, which F2 and S1 add.
        name: "multi with a secret",
        env: {
          CLUSTER_MODE: "multi",
          ...SECRETS,
          ...SHARED_STORAGE,
        },
        mode: "multi",
        refusals: [],
        // The default attachment provider is `database`, which is cluster-safe
        // and says so rather than passing in silence.
        warnings: [/ATTACHMENT_STORAGE_PROVIDER=database/],
      },
      {
        name: "multi with attachments on s3",
        env: {
          CLUSTER_MODE: "multi",
          ...SECRETS,
          ATTACHMENT_STORAGE_PROVIDER: "s3",
          ...SHARED_STORAGE,
        },
        mode: "multi",
        refusals: [],
        warnings: [],
      },
      {
        name: "multi with per-pod attachments",
        env: {
          CLUSTER_MODE: "multi",
          ...SECRETS,
          ATTACHMENT_STORAGE_PROVIDER: "local",
          ...SHARED_STORAGE,
        },
        mode: "multi",
        refusals: [/ATTACHMENT_SHARED_VOLUME=true/],
        warnings: [],
      },
      {
        name: "multi with local attachments on an asserted shared volume",
        env: {
          CLUSTER_MODE: "multi",
          ...SECRETS,
          ATTACHMENT_STORAGE_PROVIDER: "local",
          ATTACHMENT_SHARED_VOLUME: "true",
          ...SHARED_STORAGE,
        },
        mode: "multi",
        refusals: [],
        warnings: [],
      },
      {
        // The provider is read case- and whitespace-insensitively, as the
        // module that selects it reads it.
        name: "multi with LOCAL attachments spelled loudly",
        env: {
          CLUSTER_MODE: "multi",
          ...SECRETS,
          ATTACHMENT_STORAGE_PROVIDER: "  LOCAL ",
          ...SHARED_STORAGE,
        },
        mode: "multi",
        refusals: [/ATTACHMENT_SHARED_VOLUME=true/],
        warnings: [],
      },
      {
        name: "multi without the backup assertion",
        env: {
          CLUSTER_MODE: "multi",
          ...SECRETS,
          ATTACHMENT_STORAGE_PROVIDER: "s3",
        },
        mode: "multi",
        refusals: [/BACKUP_SHARED_VOLUME=true/],
        warnings: [],
      },
      {
        // Anything but the exact assertion is not an assertion. "yes" and "1"
        // are what an operator reaches for, and accepting them would mean the
        // check passes on a value nobody chose deliberately.
        name: "multi with a backup assertion that is not true",
        env: {
          CLUSTER_MODE: "multi",
          ...SECRETS,
          ATTACHMENT_STORAGE_PROVIDER: "s3",
          BACKUP_SHARED_VOLUME: "yes",
        },
        mode: "multi",
        refusals: [/BACKUP_SHARED_VOLUME=true/],
        warnings: [],
      },
      {
        // The refusal above is the LOCAL store's. An object store is reachable
        // from every replica by construction, so the assertion it exists to
        // extract has nothing to assert -- which is the whole point of task S2.
        name: "multi with an s3 backup store needs no shared volume",
        env: {
          CLUSTER_MODE: "multi",
          ...SECRETS,
          ATTACHMENT_STORAGE_PROVIDER: "s3",
          BACKUP_STORAGE_PROVIDER: "s3",
          BACKUP_STORE_S3_BUCKET: "monize-store",
        },
        mode: "multi",
        refusals: [],
        warnings: [],
      },
      {
        // local is the default in every mode, so an unset provider is still the
        // one that needs the assertion.
        name: "multi with the backup store left unset still needs the assertion",
        env: {
          CLUSTER_MODE: "multi",
          ...SECRETS,
          ATTACHMENT_STORAGE_PROVIDER: "s3",
          BACKUP_STORAGE_PROVIDER: "local",
        },
        mode: "multi",
        refusals: [/BACKUP_SHARED_VOLUME=true/],
        warnings: [],
      },
      {
        // The refusal names the second way out now that there is one.
        name: "the local-store refusal offers the s3 store as an answer",
        env: {
          CLUSTER_MODE: "multi",
          ...SECRETS,
          ATTACHMENT_STORAGE_PROVIDER: "s3",
        },
        mode: "multi",
        refusals: [/BACKUP_STORAGE_PROVIDER=s3/],
        warnings: [],
      },
      {
        // A typo would otherwise be read as `local` and put the recovery points
        // on a pod's disk while the operator believed they were in a bucket.
        name: "an unrecognised backup store, in single",
        env: { ...SECRETS, BACKUP_STORAGE_PROVIDER: "S3-bucket" },
        mode: "single",
        refusals: [/is not a backup storage target/],
        warnings: [],
      },
      {
        // INV-BACKUP-007, at the boot rather than at 02:00: the off-machine
        // copy exists to survive the loss of the store, so one bucket holding
        // both is a 3-2-1 arrangement that is actually a 1.
        name: "an s3 store sharing its bucket with the off-machine destination",
        env: {
          ...SECRETS,
          BACKUP_STORAGE_PROVIDER: "s3",
          BACKUP_STORE_S3_BUCKET: "one-bucket",
          BACKUP_STORE_S3_PREFIX: "backups/",
          BACKUP_S3_BUCKET: "one-bucket",
          BACKUP_S3_PREFIX: "backups/offsite/",
        },
        mode: "single",
        refusals: [/INV-BACKUP-007/],
        warnings: [],
      },
      {
        name: "an s3 store and an off-machine destination in two buckets",
        env: {
          ...SECRETS,
          BACKUP_STORAGE_PROVIDER: "s3",
          BACKUP_STORE_S3_BUCKET: "monize-store",
          BACKUP_S3_BUCKET: "monize-offsite",
        },
        mode: "single",
        refusals: [],
        warnings: [],
      },
      {
        // The same bucket name on two services is two places; comparing the
        // names alone would refuse a perfectly good configuration.
        name: "the same bucket name on two different endpoints",
        env: {
          ...SECRETS,
          BACKUP_STORAGE_PROVIDER: "s3",
          BACKUP_STORE_S3_BUCKET: "backups",
          BACKUP_STORE_S3_ENDPOINT: "http://minio:9000",
          BACKUP_S3_BUCKET: "backups",
        },
        mode: "single",
        refusals: [],
        warnings: [],
      },
      {
        // A deployment with no off-machine destination has nothing to collide
        // with, and an s3 store with no bucket is refused by the store itself
        // with a message naming the variable -- one misconfiguration, one
        // wording.
        name: "an s3 store with no off-machine destination configured",
        env: {
          ...SECRETS,
          BACKUP_STORAGE_PROVIDER: "s3",
          BACKUP_STORE_S3_BUCKET: "monize-store",
        },
        mode: "single",
        refusals: [],
        warnings: [],
      },
      {
        name: "single ignores the storage settings entirely",
        env: {
          CLUSTER_MODE: "single",
          ...SECRETS,
          ATTACHMENT_STORAGE_PROVIDER: "local",
        },
        mode: "single",
        refusals: [],
        warnings: [],
      },
      {
        name: "JWT_SECRET missing in single",
        env: { ENCRYPTION_KEY: GOOD_ENCRYPTION_KEY },
        mode: "single",
        refusals: [/JWT_SECRET is not set/],
        warnings: [],
      },
      {
        name: "JWT_SECRET missing in multi",
        env: {
          CLUSTER_MODE: "multi",
          ENCRYPTION_KEY: GOOD_ENCRYPTION_KEY,
          ...SHARED_STORAGE,
        },
        mode: "multi",
        refusals: [/JWT_SECRET is not set/],
        warnings: [/ATTACHMENT_STORAGE_PROVIDER=database/],
      },
      {
        name: "JWT_SECRET too short",
        env: { JWT_SECRET: "short", ENCRYPTION_KEY: GOOD_ENCRYPTION_KEY },
        mode: "single",
        refusals: [/JWT_SECRET is shorter than 32 characters/],
        warnings: [],
      },
      {
        // Measured the way JwtStrategy measures it: this one boots there, so it
        // must boot here. A trimmed length would refuse a running deployment.
        name: "JWT_SECRET long enough only with its whitespace",
        env: {
          JWT_SECRET: `  ${GOOD_SECRET.slice(0, MIN_JWT_SECRET_LENGTH - 4)}  `,
          ENCRYPTION_KEY: GOOD_ENCRYPTION_KEY,
        },
        mode: "single",
        refusals: [],
        warnings: [],
      },
      {
        // The value `.env.example` used to ship. Weak, and public -- but it
        // boots: replacing it stops every user's authenticator codes working,
        // so it is reported (boot warning, admin alert, admin banner) rather
        // than refused.
        name: "JWT_SECRET left at the retired .env.example placeholder boots",
        env: {
          JWT_SECRET: "your-super-secret-jwt-key-change-in-production",
          ENCRYPTION_KEY: GOOD_ENCRYPTION_KEY,
        },
        mode: "single",
        refusals: [],
        warnings: [],
      },
      {
        name: "JWT_SECRET that is one character repeated boots",
        env: {
          JWT_SECRET: "x".repeat(MIN_JWT_SECRET_LENGTH),
          ENCRYPTION_KEY: GOOD_ENCRYPTION_KEY,
        },
        mode: "single",
        refusals: [],
        warnings: [],
      },
      {
        name: "ENCRYPTION_KEY missing in single",
        env: { JWT_SECRET: GOOD_SECRET },
        mode: "single",
        refusals: [/^ENCRYPTION_KEY is not set.*openssl rand -hex 32/],
        warnings: [],
      },
      {
        name: "ENCRYPTION_KEY missing in multi",
        env: {
          CLUSTER_MODE: "multi",
          JWT_SECRET: GOOD_SECRET,
          ...SHARED_STORAGE,
        },
        mode: "multi",
        refusals: [/^ENCRYPTION_KEY is not set/],
        warnings: [/ATTACHMENT_STORAGE_PROVIDER=database/],
      },
      {
        // A value below the floor is not a key: the write paths would refuse
        // it, so the boot does too.
        name: "ENCRYPTION_KEY too short",
        env: { JWT_SECRET: GOOD_SECRET, ENCRYPTION_KEY: "too-short" },
        mode: "single",
        refusals: [/^ENCRYPTION_KEY is not set \(or is shorter than 32/],
        warnings: [],
      },
      {
        name: "the legacy AI_ENCRYPTION_KEY still supplies the key",
        env: {
          JWT_SECRET: GOOD_SECRET,
          AI_ENCRYPTION_KEY: GOOD_ENCRYPTION_KEY,
        },
        mode: "single",
        refusals: [],
        warnings: [],
      },
      {
        name: "an unparsable CLUSTER_MODE",
        env: { CLUSTER_MODE: "cluster", ...SECRETS },
        mode: null,
        refusals: [/Invalid CLUSTER_MODE "cluster"/],
        warnings: [],
      },
    ];

    it.each(cases)("$name", ({ env, mode, refusals, warnings }) => {
      const report = checkClusterBoot(env);
      expect(report.mode).toBe(mode);
      expect(report.refusals).toHaveLength(refusals.length);
      refusals.forEach((pattern, i) =>
        expect(report.refusals[i]).toMatch(pattern),
      );
      expect(report.warnings).toHaveLength(warnings.length);
      warnings.forEach((pattern, i) =>
        expect(report.warnings[i]).toMatch(pattern),
      );
    });
  });

  it("names the directory an operator has to share", () => {
    // The refusal is only useful if it says which path to mount, and the
    // deprecated alias names the same directory as the current variable.
    const withAlias = checkClusterBoot({
      CLUSTER_MODE: "multi",
      ...SECRETS,
      ATTACHMENT_STORAGE_PROVIDER: "local",
      ATTACHMENT_LOCAL_DIR: "/srv/legacy-attachments",
      BACKUP_CONTAINER_DIR: "/srv/backups",
    });

    expect(withAlias.refusals.join("\n")).toContain("/srv/legacy-attachments");
    expect(withAlias.refusals.join("\n")).toContain("/srv/backups");
  });

  it("prefers the current directory variable over the deprecated alias", () => {
    const both = checkClusterBoot({
      CLUSTER_MODE: "multi",
      ...SECRETS,
      ATTACHMENT_STORAGE_PROVIDER: "local",
      ATTACHMENT_CONTAINER_DIR: "/srv/current",
      ATTACHMENT_LOCAL_DIR: "/srv/legacy",
      ...SHARED_STORAGE,
    });

    expect(both.refusals.join("\n")).toContain("/srv/current");
    expect(both.refusals.join("\n")).not.toContain("/srv/legacy");
  });

  it("names the container defaults when no directory is set", () => {
    // An operator who never set the paths still has to be told which ones to
    // mount, and the defaults are the chart's.
    const defaults = checkClusterBoot({
      CLUSTER_MODE: "multi",
      ...SECRETS,
      ATTACHMENT_STORAGE_PROVIDER: "local",
    });

    expect(defaults.refusals.join("\n")).toContain("/data/attachments");
    expect(defaults.refusals.join("\n")).toContain("/data/backups");
  });

  it("reports every problem at once, so one restart is enough", () => {
    // An unreadable mode does not stop the secrets being judged: an operator
    // who fixed one and restarted to find the next waiting is the failure
    // this asserts against.
    const report = checkClusterBoot({ CLUSTER_MODE: "cluster" });
    expect(report.refusals).toHaveLength(3);
    expect(report.refusals.join("\n")).toMatch(/Invalid CLUSTER_MODE/);
    expect(report.refusals.join("\n")).toMatch(/JWT_SECRET/);
    expect(report.refusals.join("\n")).toMatch(/ENCRYPTION_KEY/);
  });
});

/**
 * The boot matrix is only as good as what the bootstrap hands it.
 *
 * `assertClusterBootOrExit` in `main.ts` names each variable one by one instead
 * of passing `process.env`, so a field added to `ClusterBootEnv` and read by
 * `checkClusterBoot` arrives as `undefined` until that list is extended too --
 * and an `undefined` field reads as its default, which is the servable answer
 * for the attachment provider and the unservable one for the backup store.
 * That is how `BACKUP_STORAGE_PROVIDER=s3` spent a release refusing to boot
 * under `multi` with a message telling the operator to set
 * `BACKUP_STORAGE_PROVIDER=s3`. Every unit test passed: the pure function was
 * right and nothing tested the call site.
 *
 * So both sides are read from source. The spec cannot import the interface's
 * keys -- a TypeScript type is gone by runtime -- and a hand-kept list here
 * would be a third place to forget.
 */
describe("the main.ts call site", () => {
  const read = (...parts: string[]) =>
    readFileSync(join(__dirname, ...parts), "utf8");

  /** The `KEY?: string;` members of `interface ClusterBootEnv`. */
  const declaredFields = (): string[] => {
    const source = read("cluster-mode.ts");
    const body = /export interface ClusterBootEnv \{([\s\S]*?)\n\}/.exec(
      source,
    )?.[1];
    if (!body) throw new Error("ClusterBootEnv not found in cluster-mode.ts");
    return [...body.matchAll(/^\s{2}(\w+)\?:/gm)].map((match) => match[1]);
  };

  /** The object literal `assertClusterBootOrExit` builds. */
  const forwardedFields = (): string[] => {
    const source = read("..", "..", "main.ts");
    const literal = /checkClusterBoot\(\{([\s\S]*?)\n\s*\}\)/.exec(source)?.[1];
    if (!literal) throw new Error("checkClusterBoot call not found in main.ts");
    return [...literal.matchAll(/(\w+):\s*process\.env\.(\w+)/g)]
      .filter(([, key, variable]) => key === variable)
      .map(([, key]) => key);
  };

  it("parses both sides, so a silent zero match cannot pass this spec", () => {
    expect(declaredFields()).toContain("BACKUP_STORAGE_PROVIDER");
    expect(forwardedFields()).toContain("CLUSTER_MODE");
  });

  it("forwards every variable the boot matrix reads", () => {
    const forwarded = new Set(forwardedFields());
    const missing = declaredFields().filter((field) => !forwarded.has(field));

    // Naming them: the fix is to add these lines to the literal in main.ts.
    expect(missing).toEqual([]);
  });
});
