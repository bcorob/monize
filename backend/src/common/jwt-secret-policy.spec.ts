import { randomBytes } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import {
  KNOWN_PLACEHOLDER_JWT_SECRETS,
  MIN_JWT_SECRET_LENGTH,
  assessJwtSecret,
  jwtSecretFatalProblem,
  jwtSecretWeakness,
  jwtSecretWeaknessWarningLines,
  logJwtSecretStatus,
} from "./jwt-secret-policy";

const REPO_ROOT = join(__dirname, "..", "..", "..");

/** The placeholder `.env.example` shipped until it stopped shipping one. */
const RETIRED_EXAMPLE_PLACEHOLDER =
  "your-super-secret-jwt-key-change-in-production";

describe("jwtSecretFatalProblem", () => {
  it("refuses a missing or empty secret", () => {
    expect(jwtSecretFatalProblem(undefined)).toMatch(/not set/);
    expect(jwtSecretFatalProblem(null)).toMatch(/not set/);
    expect(jwtSecretFatalProblem("")).toMatch(/not set/);
  });

  it("refuses a secret shorter than the floor", () => {
    expect(jwtSecretFatalProblem("a1B2c3D4e5F6g7H8")).toMatch(
      new RegExp(`shorter than ${MIN_JWT_SECRET_LENGTH}`),
    );
  });

  it("does not refuse a long-enough weak secret: that one boots and is reported", () => {
    expect(jwtSecretFatalProblem(RETIRED_EXAMPLE_PLACEHOLDER)).toBeNull();
    expect(jwtSecretFatalProblem("x".repeat(64))).toBeNull();
  });

  it("refuses a short secret even when it is also a placeholder, and reports it once", () => {
    // One severity per value: the short one is fatal, never "weak" as well.
    const shortPlaceholder = "change-me";
    expect(jwtSecretFatalProblem(shortPlaceholder)).toMatch(/shorter than/);
    expect(jwtSecretWeakness(shortPlaceholder)).toBeNull();
  });

  it("measures length untrimmed, as every caller always has", () => {
    const padded = `  ${"aB3dE5gH7jK9mN1pQ3sT5vW7yZ9b"}  `;
    expect(padded.length).toBe(MIN_JWT_SECRET_LENGTH);
    expect(assessJwtSecret(padded)).toBeNull();
  });
});

describe(".env.example", () => {
  it("ships JWT_SECRET empty, so a copied file refuses to boot until it is set", () => {
    // Read from the file rather than restated: the line an operator copies is
    // the line that must not start a server. It used to ship a placeholder,
    // which booted with a public signing key.
    const example = readFileSync(join(REPO_ROOT, ".env.example"), "utf8");
    const line = /^JWT_SECRET=(.*)$/m.exec(example)?.[1];
    expect(line).toBeDefined();
    expect(line).toBe("");
    expect(jwtSecretFatalProblem(line)).toMatch(/not set/);
  });
});

describe("jwtSecretWeakness", () => {
  it("flags the retired .env.example placeholder, however it is wrapped", () => {
    // Deployments set up from an older copy may still run with it.
    expect(KNOWN_PLACEHOLDER_JWT_SECRETS).toContain(
      RETIRED_EXAMPLE_PLACEHOLDER,
    );
    for (const wrapped of [
      RETIRED_EXAMPLE_PLACEHOLDER,
      `"${RETIRED_EXAMPLE_PLACEHOLDER}"`,
      ` ${RETIRED_EXAMPLE_PLACEHOLDER.toUpperCase()} `,
    ]) {
      expect(jwtSecretWeakness(wrapped)).toEqual({
        reason: "placeholder",
        message: expect.stringMatching(/example placeholder/),
      });
    }
  });

  it("flags every listed placeholder that is long enough, and any value built around one", () => {
    for (const placeholder of KNOWN_PLACEHOLDER_JWT_SECRETS) {
      expect(assessJwtSecret(placeholder)).not.toBeNull();
    }
    expect(
      jwtSecretWeakness("my-own-jwt-secret-please-changeme-now-2024")?.reason,
    ).toBe("placeholder");
  });

  it("flags a secret with too few distinct characters", () => {
    expect(jwtSecretWeakness("x".repeat(64))?.reason).toBe("predictable");
    expect(jwtSecretWeakness("ab".repeat(20))?.reason).toBe("predictable");
    expect(jwtSecretWeakness("1234567".repeat(6))?.reason).toBe("predictable");
  });

  it("flags a secret that is one short unit repeated", () => {
    // 12 distinct characters, so only the repetition gives it away.
    expect(jwtSecretWeakness("password1234".repeat(3))?.reason).toBe(
      "predictable",
    );
  });

  it("judges a multi-byte secret without throwing", () => {
    // A prefix repeated to the same UTF-16 length can differ in byte length;
    // the constant-time comparison must treat that as "not a repeat".
    expect(
      assessJwtSecret("é" + "Kq8vZ2mX9pL4rT7wB1nC6yH3jF5dG0sA"),
    ).toBeNull();
    expect(jwtSecretWeakness("éé".repeat(20))?.reason).toBe("predictable");
  });

  it("accepts what the documented generators print", () => {
    // 200 draws of each shape; the spec's arithmetic puts a false flag on a
    // 32-byte hex secret near 1e-19, so a failure here is the rule's fault.
    for (let i = 0; i < 200; i++) {
      const bytes = randomBytes(32);
      expect(assessJwtSecret(bytes.toString("base64"))).toBeNull();
      expect(assessJwtSecret(bytes.toString("hex"))).toBeNull();
      expect(assessJwtSecret(bytes.toString("base64url"))).toBeNull();
    }
  });

  it("accepts the secrets the CI and E2E stacks boot with", () => {
    // `.github/workflows/ci.yml` and `docker-compose.e2e.yml`; the rule must
    // not flag the stacks the test suites start.
    expect(
      assessJwtSecret("test-jwt-secret-for-ci-minimum-32-characters-long"),
    ).toBeNull();
    expect(
      assessJwtSecret("test-jwt-secret-that-is-at-least-32-chars-long"),
    ).toBeNull();
  });
});

describe("logJwtSecretStatus", () => {
  it("warns at boot about a weak secret, with the remedy and what the remedy costs", () => {
    const logger = { warn: jest.fn() };
    logJwtSecretStatus(RETIRED_EXAMPLE_PLACEHOLDER, logger);

    const lines = logger.warn.mock.calls.map(([line]) => line as string);
    expect(lines).toEqual([
      ...jwtSecretWeaknessWarningLines(
        jwtSecretWeakness(RETIRED_EXAMPLE_PLACEHOLDER)!,
      ),
    ]);
    const warning = lines.join(" ");
    expect(warning).toContain("openssl rand -base64 32");
    expect(warning).toMatch(/signed-in users stay signed in/);
    expect(warning).toMatch(/two-factor/);
    expect(warning).toMatch(/Backup codes keep working/);
    expect(warning).toMatch(/Reset 2FA/);
    expect(warning).toContain("docs/backend/modules-and-runtime.md");
    // One call per line: the Nest prefix lands only on a message's first line.
    for (const line of lines) expect(line).not.toContain("\n");
  });

  it("never logs the secret or any part of it", () => {
    const secret = "Zq" + "a".repeat(40);
    const logger = { warn: jest.fn() };
    logJwtSecretStatus(secret, logger);
    expect(logger.warn).toHaveBeenCalled();
    for (const [line] of logger.warn.mock.calls) {
      expect(line).not.toContain("aaaa");
    }
  });

  it("is silent for a sound secret", () => {
    const logger = { warn: jest.fn() };
    logJwtSecretStatus(randomBytes(32).toString("base64"), logger);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
