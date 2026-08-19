import { ConflictException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import { readFileSync } from "fs";
import { join } from "path";
import {
  assertReconciledIdsMutable,
  assertReconciledRowsMutable,
  isReconciledLockEnabled,
  isReconciledUndo,
  isWithinReconciledUndoWindow,
  RECONCILED_UNDO_WINDOW_SECONDS,
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
      // The lock did not apply, so the undo window is not "open" -- a caller
      // must never read this verdict as permission it did not get.
    ).resolves.toEqual({ undoWindowOpen: false });
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
    ).resolves.toEqual({ undoWindowOpen: false });
    expect(findOne).not.toHaveBeenCalled();
  });

  it("allows an empty set without a lookup", async () => {
    const { manager, findOne } = managerWith(true);
    await expect(
      assertReconciledRowsMutable(manager, "user-1", []),
    ).resolves.toEqual({ undoWindowOpen: false });
    expect(findOne).not.toHaveBeenCalled();
  });
});

describe("assertReconciledRowsMutable and the undo window", () => {
  it("returns instead of throwing for a row reconciled moments ago", async () => {
    const { manager } = managerWith(true, [{ within_undo_window: true }]);
    await expect(
      assertReconciledRowsMutable(
        manager,
        "user-1",
        [{ status: TransactionStatus.RECONCILED }],
        { undoWindowFor: "tx-1" },
      ),
    ).resolves.toEqual({ undoWindowOpen: true });
  });

  it("still refuses once the row is older than the window", async () => {
    const { manager } = managerWith(true, [{ within_undo_window: false }]);
    await expect(
      assertReconciledRowsMutable(
        manager,
        "user-1",
        [{ status: TransactionStatus.RECONCILED }],
        { undoWindowFor: "tx-1" },
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  // A caller that does not ask for the window must not get it: every other
  // write path -- the ordinary edit, the deletes, the bulk routes -- refuses a
  // reconciled row however recently it was reconciled.
  it("is not consulted unless the caller asks for it", async () => {
    const { manager, query } = managerWith(true, [
      { within_undo_window: true },
    ]);
    await expect(
      assertReconciledRowsMutable(manager, "user-1", [
        { status: TransactionStatus.RECONCILED },
      ]),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(query).not.toHaveBeenCalled();
  });

  it("does not ask about the window when the lock is off", async () => {
    const { manager, query } = managerWith(false, [
      { within_undo_window: true },
    ]);
    await expect(
      assertReconciledRowsMutable(
        manager,
        "user-1",
        [{ status: TransactionStatus.RECONCILED }],
        { undoWindowFor: "tx-1" },
      ),
    ).resolves.toEqual({ undoWindowOpen: false });
    expect(query).not.toHaveBeenCalled();
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

/**
 * The undo window: the one thing the strict lock yields to, and only for the
 * row the user reconciled seconds ago.
 */
describe("isReconciledUndo", () => {
  it("is the transition back off a reconciled row", () => {
    expect(
      isReconciledUndo(
        TransactionStatus.RECONCILED,
        TransactionStatus.UNRECONCILED,
      ),
    ).toBe(true);
    // `unreconcile` lands on CLEARED rather than UNRECONCILED, and it is the
    // same undo -- the window would be half a window if it took only one of
    // the two ways back.
    expect(
      isReconciledUndo(TransactionStatus.RECONCILED, TransactionStatus.CLEARED),
    ).toBe(true);
  });

  // Voiding moves money and reverses shares. A window that exists so a misclick
  // can be taken back must not become a ten-second door into it.
  it("is not a void, and not a re-reconcile", () => {
    expect(
      isReconciledUndo(TransactionStatus.RECONCILED, TransactionStatus.VOID),
    ).toBe(false);
    expect(
      isReconciledUndo(
        TransactionStatus.RECONCILED,
        TransactionStatus.RECONCILED,
      ),
    ).toBe(false);
  });

  it("says nothing about a row that was not reconciled", () => {
    expect(
      isReconciledUndo(
        TransactionStatus.CLEARED,
        TransactionStatus.UNRECONCILED,
      ),
    ).toBe(false);
    expect(isReconciledUndo(null, TransactionStatus.UNRECONCILED)).toBe(false);
  });
});

describe("isWithinReconciledUndoWindow", () => {
  it("asks the database, on the row's own updated_at and its own clock", async () => {
    const { manager, query } = managerWith(true, [
      { within_undo_window: true },
    ]);
    await expect(isWithinReconciledUndoWindow(manager, "tx-1")).resolves.toBe(
      true,
    );
    const [sql, params] = query.mock.calls[0];
    // One clock decides. Comparing a database timestamp against the Node
    // process's clock would make the window as wide as the drift between them.
    expect(sql).toContain("clock_timestamp()");
    expect(sql).toContain("updated_at");
    expect(params).toEqual(["tx-1", RECONCILED_UNDO_WINDOW_SECONDS]);
  });

  it("is false once the row is older than the window", async () => {
    const { manager } = managerWith(true, [{ within_undo_window: false }]);
    await expect(isWithinReconciledUndoWindow(manager, "tx-1")).resolves.toBe(
      false,
    );
  });

  // An absent row is not a fresh one. Answering true would open the window on
  // the strength of a row nobody found.
  it("is false when the row is gone", async () => {
    const { manager } = managerWith(true, []);
    await expect(isWithinReconciledUndoWindow(manager, "tx-1")).resolves.toBe(
      false,
    );
  });

  it("is false for anything that is not an explicit true", async () => {
    const { manager } = managerWith(true, [{ within_undo_window: null }]);
    await expect(isWithinReconciledUndoWindow(manager, "tx-1")).resolves.toBe(
      false,
    );
  });
});

/**
 * The client tells the user how long they have, so it carries the same number.
 * Two constants in two packages is exactly the drift a comment cannot catch:
 * a toast promising ten seconds over a server that allows five is a promise the
 * product breaks on the user's next click.
 */
describe("the window's two homes", () => {
  it("matches the number the frontend prints", () => {
    const source = readFileSync(
      join(
        __dirname,
        "..",
        "..",
        "..",
        "frontend",
        "src",
        "lib",
        "transaction-status-cycle.ts",
      ),
      "utf8",
    );
    const declared = source.match(/RECONCILED_UNDO_WINDOW_SECONDS\s*=\s*(\d+)/);
    expect(declared).not.toBeNull();
    expect(Number(declared![1])).toBe(RECONCILED_UNDO_WINDOW_SECONDS);
  });
});
