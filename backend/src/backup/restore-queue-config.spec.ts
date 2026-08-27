import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_RESTORE_QUEUE_CONFIG,
  RESTORE_QUEUE_KNOBS,
  RESTORE_RETRY_AFTER_SECONDS,
  resolveRestoreQueueConfig,
} from "./restore-queue-config";

/** `.env.example` lives at the repository root, two levels above `backend/src`. */
const envExample = () =>
  readFileSync(join(__dirname, "..", "..", "..", ".env.example"), "utf8");

describe("resolveRestoreQueueConfig", () => {
  it("uses the declared defaults when nothing is set", () => {
    expect(resolveRestoreQueueConfig({})).toEqual(DEFAULT_RESTORE_QUEUE_CONFIG);
  });

  it("reads an operator override", () => {
    expect(
      resolveRestoreQueueConfig({
        BACKUP_RESTORE_QUEUE_LIMIT: "9",
        BACKUP_RESTORE_QUEUE_WAIT_MS: "30000",
      }),
    ).toEqual({ queueLimit: 9, waitTimeoutMs: 30_000 });
  });

  it("treats an empty value as unset, without complaining", () => {
    const onInvalid = jest.fn();
    expect(
      resolveRestoreQueueConfig({ BACKUP_RESTORE_QUEUE_LIMIT: "  " }, onInvalid)
        .queueLimit,
    ).toBe(RESTORE_QUEUE_KNOBS.queueLimit.default);
    expect(onInvalid).not.toHaveBeenCalled();
  });

  /**
   * The distinction `resolvePositiveInt` exists for: an unset variable is not a
   * deployment mistake, and a typo is. A silent fallback is how an operator sets
   * a knob to "ten" and spends an afternoon wondering why nothing changed.
   */
  it.each([
    ["not a number", "ten"],
    ["zero, which is not a queue", "0"],
    ["a negative", "-3"],
    ["a fraction", "2.5"],
  ])("falls back and reports %s", (_label, raw) => {
    const onInvalid = jest.fn();
    const config = resolveRestoreQueueConfig(
      { BACKUP_RESTORE_QUEUE_LIMIT: raw },
      onInvalid,
    );
    expect(config.queueLimit).toBe(RESTORE_QUEUE_KNOBS.queueLimit.default);
    expect(onInvalid).toHaveBeenCalledTimes(1);
    expect(onInvalid.mock.calls[0][0]).toContain("BACKUP_RESTORE_QUEUE_LIMIT");
  });

  it("resolves each knob independently", () => {
    const onInvalid = jest.fn();
    const config = resolveRestoreQueueConfig(
      {
        BACKUP_RESTORE_QUEUE_LIMIT: "nope",
        BACKUP_RESTORE_QUEUE_WAIT_MS: "45",
      },
      onInvalid,
    );
    // One bad knob must not take a good one down with it.
    expect(config).toEqual({
      queueLimit: RESTORE_QUEUE_KNOBS.queueLimit.default,
      waitTimeoutMs: 45,
    });
    expect(onInvalid).toHaveBeenCalledTimes(1);
  });
});

/**
 * The knob table and `.env.example` are checked against each other in both
 * directions, the way `query-budgets.spec.ts` does it: a knob nobody documented
 * is a knob nobody can find, and a documented `BACKUP_RESTORE_QUEUE_*` line the
 * code does not read is a promise the deployment cannot keep.
 */
describe("the declared knobs and their documentation", () => {
  it("documents every knob with its current default", () => {
    const text = envExample();
    for (const spec of Object.values(RESTORE_QUEUE_KNOBS)) {
      expect(text).toContain(`# ${spec.envVar}=${spec.default}`);
    }
  });

  it("does not document a restore-queue variable the code never reads", () => {
    const declared = new Set(
      Object.values(RESTORE_QUEUE_KNOBS).map((spec) => spec.envVar),
    );
    const documented = [
      ...envExample().matchAll(/^#?\s*(BACKUP_RESTORE_QUEUE_[A-Z_]+)=/gm),
    ].map((match) => match[1]);

    expect(documented.length).toBeGreaterThan(0);
    for (const name of documented) expect(declared).toContain(name);
  });

  it("gives every knob a description a warning can quote", () => {
    for (const spec of Object.values(RESTORE_QUEUE_KNOBS)) {
      expect(spec.description.trim().length).toBeGreaterThan(10);
    }
  });

  it("keeps one Retry-After for every transient restore refusal", () => {
    // The upload gate and the processing queue refuse for different reasons but
    // state the same fact, so the number is written once. Both refusals quote
    // this constant; the zero-capacity 503 deliberately quotes nothing.
    const admission = readFileSync(
      join(__dirname, "restore-upload-admission.ts"),
      "utf8",
    );
    expect(admission).toContain("RESTORE_RETRY_AFTER_SECONDS");
    expect(RESTORE_RETRY_AFTER_SECONDS).toBeGreaterThan(0);
  });
});
