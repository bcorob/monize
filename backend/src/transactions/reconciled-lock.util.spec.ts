import { ConflictException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import {
  assertReconciledIdsMutable,
  assertReconciledRowsMutable,
  isReconciledLockEnabled,
} from "./reconciled-lock.util";
import { TransactionStatus } from "./entities/transaction.entity";

/**
 * A manager whose preference read is observable, so the tests can assert the
 * guard does not pay for a lookup it does not need.
 */
function managerWith(
  lockEnabled: boolean | undefined,
  queryRows: unknown[] = [],
) {
  const findOne = jest
    .fn()
    .mockResolvedValue(
      lockEnabled === undefined
        ? null
        : { userId: "user-1", lockReconciledTransactions: lockEnabled },
    );
  const query = jest.fn().mockResolvedValue(queryRows);
  const manager = {
    getRepository: jest.fn().mockReturnValue({ findOne }),
    query,
  } as unknown as EntityManager;
  return { manager, findOne, query };
}

describe("isReconciledLockEnabled", () => {
  it("is true only for an explicit true", async () => {
    const { manager } = managerWith(true);
    await expect(isReconciledLockEnabled(manager, "user-1")).resolves.toBe(
      true,
    );
  });

  it("is false when the row says false", async () => {
    const { manager } = managerWith(false);
    await expect(isReconciledLockEnabled(manager, "user-1")).resolves.toBe(
      false,
    );
  });

  it("is false when there is no preferences row at all", async () => {
    // A user with no row has not opted in. Defaulting the other way would lock
    // a ledger nobody asked to lock, with no visible setting explaining it.
    const { manager } = managerWith(undefined);
    await expect(isReconciledLockEnabled(manager, "user-1")).resolves.toBe(
      false,
    );
  });
});

describe("assertReconciledRowsMutable", () => {
  it("refuses when a reconciled row is in the set and the lock is on", async () => {
    const { manager } = managerWith(true);
    await expect(
      assertReconciledRowsMutable(manager, "user-1", [
        { status: TransactionStatus.RECONCILED },
      ]),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("allows the same write when the lock is off", async () => {
    const { manager } = managerWith(false);
    await expect(
      assertReconciledRowsMutable(manager, "user-1", [
        { status: TransactionStatus.RECONCILED },
      ]),
    ).resolves.toBeUndefined();
  });

  it("refuses a mixed set on the strength of its one reconciled row", async () => {
    // A transfer's two legs, or a bulk selection: one protected row refuses the
    // whole command, because half-applying it is the divergent state the
    // transfer and split routes exist to prevent.
    const { manager } = managerWith(true);
    await expect(
      assertReconciledRowsMutable(manager, "user-1", [
        { status: TransactionStatus.CLEARED },
        { status: TransactionStatus.RECONCILED },
      ]),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("does not read the preference when no row is reconciled", async () => {
    const { manager, findOne } = managerWith(true);
    await expect(
      assertReconciledRowsMutable(manager, "user-1", [
        { status: TransactionStatus.CLEARED },
        { status: TransactionStatus.VOID },
        { status: null },
      ]),
    ).resolves.toBeUndefined();
    expect(findOne).not.toHaveBeenCalled();
  });

  it("allows an empty set without a lookup", async () => {
    const { manager, findOne } = managerWith(true);
    await expect(
      assertReconciledRowsMutable(manager, "user-1", []),
    ).resolves.toBeUndefined();
    expect(findOne).not.toHaveBeenCalled();
  });
});

describe("assertReconciledIdsMutable", () => {
  it("refuses when the selection contains a reconciled row", async () => {
    const { manager } = managerWith(true, [
      { status: TransactionStatus.RECONCILED },
    ]);
    await expect(
      assertReconciledIdsMutable(manager, "user-1", ["a", "b"]),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("allows a selection the query found no reconciled row in", async () => {
    const { manager } = managerWith(true, []);
    await expect(
      assertReconciledIdsMutable(manager, "user-1", ["a", "b"]),
    ).resolves.toBeUndefined();
  });

  it("scopes the lookup to the caller and to reconciled rows", async () => {
    const { manager, query } = managerWith(true, []);
    await assertReconciledIdsMutable(manager, "user-1", ["a", "a", "b"]);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("user_id = $2");
    // Duplicates collapse: the id list is a set, so a batch that names the same
    // row twice does not widen the array parameter.
    expect(params).toEqual([
      ["a", "b"],
      "user-1",
      TransactionStatus.RECONCILED,
    ]);
  });

  it("issues no query for an empty id list", async () => {
    const { manager, query } = managerWith(true, []);
    await assertReconciledIdsMutable(manager, "user-1", []);
    expect(query).not.toHaveBeenCalled();
  });
});
