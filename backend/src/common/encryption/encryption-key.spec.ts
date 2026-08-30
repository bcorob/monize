import { Logger } from "@nestjs/common";
import {
  ENCRYPTION_KEY_ENV,
  envReaderFromRecord,
  LEGACY_ENCRYPTION_KEY_ENV,
  logEncryptionKeyStatus,
  MISSING_ENCRYPTION_KEY_WARNING_LINES,
  MIN_ENCRYPTION_KEY_LENGTH,
  missingEncryptionKeyMessage,
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

  it("warns on every boot when no key is configured", () => {
    // Deliberately not a refusal in this release: a deployment that never set
    // the variable under its old name would have an upgrade turn into an
    // outage. It is also exactly the state issue #1269 was reported from, so
    // silence is not an option either.
    const logger = loggerDouble();

    logEncryptionKeyStatus(read({}), logger);

    expect(logger.warn).toHaveBeenCalledTimes(
      MISSING_ENCRYPTION_KEY_WARNING_LINES.length,
    );
    for (const line of MISSING_ENCRYPTION_KEY_WARNING_LINES) {
      expect(logger.warn).toHaveBeenCalledWith(line);
    }
  });

  it("says the requirement is coming, what breaks now, and how to fix it", () => {
    // The three things an operator needs from a warning they will otherwise
    // scroll past. Pinned as content rather than as a call count, because a
    // warning that omits any of them is the same as not warning.
    const warning = MISSING_ENCRYPTION_KEY_WARNING_LINES.join(" ");

    expect(warning).toContain("FUTURE RELEASE");
    expect(warning).toContain("refuse to start");
    expect(warning).toContain("UNENCRYPTED");
    expect(warning).toContain("openssl rand -hex 32");
    expect(warning).toContain(ENCRYPTION_KEY_ENV);
    expect(warning).toContain(String(MIN_ENCRYPTION_KEY_LENGTH));
    expect(warning).toContain(LEGACY_ENCRYPTION_KEY_ENV);
  });

  it("carries the log prefix on every line", () => {
    // One warn per line, never one message with newlines in it: this
    // application's log shape is `[Nest] pid - date LEVEL [Context] message`,
    // and an embedded newline drops the prefix from every line but the first.
    for (const line of MISSING_ENCRYPTION_KEY_WARNING_LINES) {
      expect(line).not.toContain("\n");
    }
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

describe("missingEncryptionKeyMessage", () => {
  it("tells a write path's caller the variable, its floor and the generator", () => {
    // The server boots without a key, so this is where an operator meets the
    // problem instead: a request that tried to store a secret and could not.
    const message = missingEncryptionKeyMessage();

    expect(message).toContain(ENCRYPTION_KEY_ENV);
    expect(message).toContain(String(MIN_ENCRYPTION_KEY_LENGTH));
    expect(message).toContain("openssl rand -hex 32");
    expect(message).toContain(LEGACY_ENCRYPTION_KEY_ENV);
  });
});
