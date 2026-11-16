import { Logger } from "@nestjs/common";
import {
  ENCRYPTION_KEY_ENV,
  envReaderFromRecord,
  LEGACY_ENCRYPTION_KEY_ENV,
  logEncryptionKeyStatus,
  MIN_ENCRYPTION_KEY_LENGTH,
  missingEncryptionKeyMessage,
  missingEncryptionKeyRefusal,
  resolveEncryptionKey,
} from "./encryption-key";

const CURRENT = "c".repeat(MIN_ENCRYPTION_KEY_LENGTH);
const LEGACY = "l".repeat(MIN_ENCRYPTION_KEY_LENGTH);

const read = (env: Record<string, string | undefined>) =>
  envReaderFromRecord(env);

describe("resolveEncryptionKey", () => {
  it("reads ENCRYPTION_KEY", () => {
    expect(
      resolveEncryptionKey(read({ [ENCRYPTION_KEY_ENV]: CURRENT })),
    ).toEqual({ key: CURRENT, source: ENCRYPTION_KEY_ENV });
  });

  it("still reads AI_ENCRYPTION_KEY, so an existing deployment upgrades unchanged", () => {
    // Every column encrypted under the old name is AES-GCM ciphertext that only
    // that key opens; dropping the name would strand provider keys,
    // emergency-access credentials and the stored backup password at once.
    expect(
      resolveEncryptionKey(read({ [LEGACY_ENCRYPTION_KEY_ENV]: LEGACY })),
    ).toEqual({ key: LEGACY, source: LEGACY_ENCRYPTION_KEY_ENV });
  });

  it("prefers the legacy name when both are set", () => {
    // Deliberately not the other way round: a deployment that has both has
    // ciphertext written under the legacy key, and preferring the new name would
    // open none of it. New deployments set only ENCRYPTION_KEY.
    expect(
      resolveEncryptionKey(
        read({
          [ENCRYPTION_KEY_ENV]: CURRENT,
          [LEGACY_ENCRYPTION_KEY_ENV]: LEGACY,
        }),
      ),
    ).toEqual({ key: LEGACY, source: LEGACY_ENCRYPTION_KEY_ENV });
  });

  it("treats a too-short value as absent under either name", () => {
    // "Misconfigured" reaching the startup check as "unset" is the point: the
    // alternative is booting a server that cannot decrypt what it writes.
    const short = "x".repeat(MIN_ENCRYPTION_KEY_LENGTH - 1);
    expect(
      resolveEncryptionKey(
        read({
          [ENCRYPTION_KEY_ENV]: short,
          [LEGACY_ENCRYPTION_KEY_ENV]: short,
        }),
      ),
    ).toBeNull();
  });

  it("falls through a too-short legacy value to a usable current one", () => {
    expect(
      resolveEncryptionKey(
        read({
          [ENCRYPTION_KEY_ENV]: CURRENT,
          [LEGACY_ENCRYPTION_KEY_ENV]: "short",
        }),
      ),
    ).toEqual({ key: CURRENT, source: ENCRYPTION_KEY_ENV });
  });

  it("is null when neither name is set", () => {
    expect(resolveEncryptionKey(read({}))).toBeNull();
  });
});

describe("logEncryptionKeyStatus", () => {
  const loggerDouble = () =>
    ({ warn: jest.fn(), log: jest.fn() }) as unknown as Logger & {
      warn: jest.Mock;
      log: jest.Mock;
    };

  it("says nothing when no key is configured: the boot refuses that first", () => {
    // `checkClusterBoot` exits before this runs, so a warning here would be
    // a second, contradictory account of a state the server never serves in.
    const logger = loggerDouble();

    logEncryptionKeyStatus(read({}), logger);

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("warns about the rename when the key came from the deprecated name", () => {
    // A rename nobody is told about never happens.
    const logger = loggerDouble();

    logEncryptionKeyStatus(
      read({ [LEGACY_ENCRYPTION_KEY_ENV]: LEGACY }),
      logger,
    );

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(ENCRYPTION_KEY_ENV),
    );
  });

  it("says nothing when the key came from the current name", () => {
    const logger = loggerDouble();

    logEncryptionKeyStatus(read({ [ENCRYPTION_KEY_ENV]: CURRENT }), logger);

    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("missingEncryptionKeyRefusal", () => {
  it("leads with the fix, then says an existing keyless deployment can set one safely", () => {
    const refusal = missingEncryptionKeyRefusal();

    expect(refusal.startsWith(`${ENCRYPTION_KEY_ENV} is not set`)).toBe(true);
    expect(refusal).toContain("openssl rand -hex 32");
    expect(refusal).toContain(String(MIN_ENCRYPTION_KEY_LENGTH));
    expect(refusal).toMatch(/can set one safely/);
    expect(refusal).toMatch(/restore that exact value/);
    expect(refusal).toContain(LEGACY_ENCRYPTION_KEY_ENV);
    expect(refusal).not.toContain("\n");
  });
});

describe("missingEncryptionKeyMessage", () => {
  it("tells a write path's caller the variable, its floor and the generator", () => {
    // Unreachable in a booted server, which refuses to start without a key;
    // what a script or spec constructing the service keyless is told.
    const message = missingEncryptionKeyMessage();

    expect(message).toContain(ENCRYPTION_KEY_ENV);
    expect(message).toContain(String(MIN_ENCRYPTION_KEY_LENGTH));
    expect(message).toContain("openssl rand -hex 32");
    expect(message).toContain(LEGACY_ENCRYPTION_KEY_ENV);
  });
});
