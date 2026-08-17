import {
  Injectable,
  BadRequestException,
  Inject,
  NotFoundException,
  forwardRef,
} from "@nestjs/common";
import { DataSource } from "typeorm";
import { Transaction, TransactionStatus } from "./entities/transaction.entity";
import { TransactionSplitService } from "./transaction-split.service";
import {
  assertVoidTransitionAllowedOnRow,
  applyVoidTransitionToMirrorLeg,
} from "./void-status-transition.util";
import { AccountsService } from "../accounts/accounts.service";
import {
  isTransactionInFuture,
  formatDateYMDLocal,
} from "../common/date-utils";
import { tr } from "../i18n/translate";
import { withScopedDb } from "../common/db/scoped-db";
import { lockTransactionRow } from "../common/db/locks";

/** What a transition resolver returns, or it throws to refuse the transition. */
interface ResolvedTransition {
  readonly status: TransactionStatus;
  /** Wipe `reconciled_date`, for the transition that undoes a reconciliation. */
  readonly clearReconciledDate?: boolean;
}

@Injectable()
export class TransactionReconciliationService {
  constructor(
    @Inject(forwardRef(() => AccountsService))
    private accountsService: AccountsService,
    @Inject(forwardRef(() => TransactionSplitService))
    private splitService: TransactionSplitService,
    private dataSource: DataSource,
  ) {}

  /**
   * Apply one status transition as a compare-and-set against the row's own
   * committed status.
   *
   * Every guard these entry points apply -- "not already reconciled", "not
   * void", "must currently be reconciled" -- is a decision about the *current*
   * status, and so is the balance adjustment: crossing into or out of `VOID` is
   * the only transition that moves money. Reading that status from a snapshot
   * loaded before the transaction made both wrong at once. A request holding a
   * `RECONCILED` snapshot could unreconcile a row another request had since
   * voided: `wasVoid` computed from the snapshot said false, `isVoid` said
   * false, so no balance adjustment ran -- while the row went from VOID back to
   * CLEARED, putting its amount back in the ledger with nothing putting it back
   * in the balance.
   *
   * So the resolver runs here, inside the transaction, against the locked row.
   * `oldStatus` is the version this write actually replaces, and a guard that
   * refuses does so before anything is written.
   */
  private async applyStatusTransition(
    userId: string,
    transactionId: string,
    resolve: (current: TransactionStatus) => ResolvedTransition,
  ): Promise<{
    accountId: string;
    balanceMoved: boolean;
    /** Accounts a counterpart or split propagation moved besides the row's own. */
    counterpartAccountIds: string[];
  }> {
    return withScopedDb(this.dataSource, async (m) => {
      const locked = await lockTransactionRow(m, transactionId, userId);
      if (!locked) {
        throw new NotFoundException(
          tr(
            "errors.transactions.notFoundById",
            `Transaction with ID ${transactionId} not found`,
            { id: transactionId },
          ),
        );
      }

      const oldStatus = locked.status as TransactionStatus;
      const { status, clearReconciledDate } = resolve(oldStatus);

      const wasVoid = oldStatus === TransactionStatus.VOID;
      const isVoid = status === TransactionStatus.VOID;
      const balanceMoved = wasVoid !== isVoid;

      // Crossing the VOID boundary carries the same obligations here as on
      // every other route: a split-transfer counterpart leg is refused (the
      // pairing belongs to the parent), a mirror transfer leg takes its
      // counterpart with it, and a split parent takes its children's
      // counterparts. Leaving this endpoint without them made
      // PATCH /transactions/:id/status the one door into the divergent-pair
      // states the transfer, split and bulk routes refuse.
      const counterpartAccountIds: string[] = [];
      if (balanceMoved) {
        await assertVoidTransitionAllowedOnRow(m, transactionId);
      }

      const fields: Partial<Transaction> = { status };
      if (
        status === TransactionStatus.RECONCILED &&
        oldStatus !== TransactionStatus.RECONCILED
      ) {
        fields.reconciledDate = formatDateYMDLocal(new Date());
      } else if (clearReconciledDate) {
        fields.reconciledDate = null;
      }

      if (isTransactionInFuture(locked.transactionDate)) {
        await m.update(Transaction, transactionId, fields);
        if (balanceMoved) {
          await this.accountsService.recalculateCurrentBalance(
            userId,
            locked.accountId,
          );
        }
      } else {
        if (wasVoid && !isVoid) {
          await this.accountsService.updateBalance(
            locked.accountId,
            locked.amount,
          );
        } else if (!wasVoid && isVoid) {
          await this.accountsService.updateBalance(
            locked.accountId,
            -locked.amount,
          );
        }
        await m.update(Transaction, transactionId, fields);
      }

      if (balanceMoved) {
        if (locked.isSplit) {
          for (const affected of await this.splitService.applyParentStatusToTransferCounterparts(
            m,
            transactionId,
            userId,
            status,
          )) {
            counterpartAccountIds.push(affected);
          }
        } else {
          counterpartAccountIds.push(
            ...(await applyVoidTransitionToMirrorLeg(
              m,
              this.accountsService,
              userId,
              locked,
              status,
            )),
          );
        }
      }

      return {
        accountId: locked.accountId,
        balanceMoved,
        counterpartAccountIds,
      };
    });
  }

  async updateStatus(
    userId: string,
    transactionId: string,
    status: TransactionStatus,
    triggerNetWorthRecalc: (accountId: string, userId: string) => void,
    findOne: (userId: string, id: string) => Promise<Transaction>,
  ): Promise<Transaction> {
    const { accountId, balanceMoved, counterpartAccountIds } =
      await this.applyStatusTransition(userId, transactionId, () => ({
        status,
      }));

    if (balanceMoved) {
      triggerNetWorthRecalc(accountId, userId);
      for (const affected of new Set(counterpartAccountIds)) {
        if (affected !== accountId) triggerNetWorthRecalc(affected, userId);
      }
    }

    return findOne(userId, transactionId);
  }

  async markCleared(
    userId: string,
    transactionId: string,
    isCleared: boolean,
    triggerNetWorthRecalc: (accountId: string, userId: string) => void,
    findOne: (userId: string, id: string) => Promise<Transaction>,
  ): Promise<Transaction> {
    const { accountId, balanceMoved } = await this.applyStatusTransition(
      userId,
      transactionId,
      (current) => {
        if (
          current === TransactionStatus.RECONCILED ||
          current === TransactionStatus.VOID
        ) {
          throw new BadRequestException(
            tr(
              "errors.transactions.cannotChangeClearedStatusOfReconciledOrVoid",
              "Cannot change cleared status of reconciled or void transactions",
            ),
          );
        }
        return {
          status: isCleared
            ? TransactionStatus.CLEARED
            : TransactionStatus.UNRECONCILED,
        };
      },
    );

    if (balanceMoved) {
      triggerNetWorthRecalc(accountId, userId);
    }

    return findOne(userId, transactionId);
  }

  async reconcile(
    userId: string,
    transactionId: string,
    triggerNetWorthRecalc: (accountId: string, userId: string) => void,
    findOne: (userId: string, id: string) => Promise<Transaction>,
  ): Promise<Transaction> {
    const { accountId, balanceMoved } = await this.applyStatusTransition(
      userId,
      transactionId,
      (current) => {
        if (current === TransactionStatus.RECONCILED) {
          throw new BadRequestException(
            tr(
              "errors.transactions.alreadyReconciled",
              "Transaction is already reconciled",
            ),
          );
        }
        if (current === TransactionStatus.VOID) {
          throw new BadRequestException(
            tr(
              "errors.transactions.cannotReconcileVoid",
              "Cannot reconcile a void transaction",
            ),
          );
        }
        return { status: TransactionStatus.RECONCILED };
      },
    );

    if (balanceMoved) {
      triggerNetWorthRecalc(accountId, userId);
    }

    return findOne(userId, transactionId);
  }

  async unreconcile(
    userId: string,
    transactionId: string,
    findOne: (userId: string, id: string) => Promise<Transaction>,
  ): Promise<Transaction> {
    await this.applyStatusTransition(userId, transactionId, (current) => {
      if (current !== TransactionStatus.RECONCILED) {
        throw new BadRequestException(
          tr(
            "errors.transactions.notReconciled",
            "Transaction is not reconciled",
          ),
        );
      }
      return { status: TransactionStatus.CLEARED, clearReconciledDate: true };
    });

    return findOne(userId, transactionId);
  }

  async getReconciliationData(
    userId: string,
    accountId: string,
    statementDate: string,
    statementBalance: number,
  ): Promise<{
    transactions: Transaction[];
    reconciledBalance: number;
    clearedBalance: number;
    difference: number;
  }> {
    const [account, transactions, reconciledResult, clearedResult] =
      await withScopedDb(this.dataSource, (m) =>
        Promise.all([
          this.accountsService.findOne(userId, accountId),
          m
            .getRepository(Transaction)
            .createQueryBuilder("transaction")
            .leftJoinAndSelect("transaction.payee", "payee")
            .leftJoinAndSelect("transaction.category", "category")
            .where("transaction.userId = :userId", { userId })
            .andWhere("transaction.accountId = :accountId", { accountId })
            .andWhere("transaction.parentTransactionId IS NULL")
            .andWhere("transaction.status IN (:...statuses)", {
              statuses: [
                TransactionStatus.UNRECONCILED,
                TransactionStatus.CLEARED,
              ],
            })
            .andWhere("transaction.transactionDate <= :statementDate", {
              statementDate,
            })
            .orderBy("transaction.transactionDate", "ASC")
            .addOrderBy("transaction.createdAt", "ASC")
            .getMany(),
          m
            .getRepository(Transaction)
            .createQueryBuilder("transaction")
            .select("SUM(transaction.amount)", "sum")
            .where("transaction.userId = :userId", { userId })
            .andWhere("transaction.accountId = :accountId", { accountId })
            .andWhere("transaction.parentTransactionId IS NULL")
            .andWhere("transaction.status = :status", {
              status: TransactionStatus.RECONCILED,
            })
            .getRawOne(),
          m
            .getRepository(Transaction)
            .createQueryBuilder("transaction")
            .select("SUM(transaction.amount)", "sum")
            .where("transaction.userId = :userId", { userId })
            .andWhere("transaction.accountId = :accountId", { accountId })
            .andWhere("transaction.parentTransactionId IS NULL")
            .andWhere("transaction.status = :status", {
              status: TransactionStatus.CLEARED,
            })
            .andWhere("transaction.transactionDate <= :statementDate", {
              statementDate,
            })
            .getRawOne(),
        ]),
      );

    const reconciledSum = Number(reconciledResult?.sum) || 0;
    const reconciledBalance = Number(account.openingBalance) + reconciledSum;

    const clearedSum = Number(clearedResult?.sum) || 0;
    const clearedBalance = reconciledBalance + clearedSum;

    const difference = statementBalance - clearedBalance;

    return {
      transactions,
      reconciledBalance,
      clearedBalance,
      difference,
    };
  }

  async bulkReconcile(
    userId: string,
    accountId: string,
    transactionIds: string[],
    reconciledDate: string,
  ): Promise<{ reconciled: number }> {
    await this.accountsService.findOne(userId, accountId);

    if (transactionIds.length === 0) {
      return { reconciled: 0 };
    }

    return withScopedDb(this.dataSource, async (m) => {
      // Locked in ascending id order and re-checked here: the VOID exclusion
      // below is a refusal, so it has to be evaluated against the status this
      // statement is about to overwrite, not against one read a moment earlier.
      const transactions = await m
        .getRepository(Transaction)
        .createQueryBuilder("transaction")
        .where("transaction.id IN (:...ids)", { ids: transactionIds })
        .andWhere("transaction.userId = :userId", { userId })
        .andWhere("transaction.accountId = :accountId", { accountId })
        .orderBy("transaction.id", "ASC")
        .setLock("pessimistic_write")
        .getMany();

      if (transactions.length !== transactionIds.length) {
        throw new BadRequestException(
          tr(
            "errors.transactions.bulkReconcileNotFound",
            "Some transactions were not found or do not belong to the specified account",
          ),
        );
      }

      const voidTransactions = transactions.filter(
        (t) => t.status === TransactionStatus.VOID,
      );
      if (voidTransactions.length > 0) {
        throw new BadRequestException(
          tr(
            "errors.transactions.cannotReconcileVoidPlural",
            "Cannot reconcile void transactions",
          ),
        );
      }

      await m
        .getRepository(Transaction)
        .createQueryBuilder()
        .update(Transaction)
        .set({
          status: TransactionStatus.RECONCILED,
          reconciledDate: reconciledDate,
        })
        .where("id IN (:...ids)", { ids: transactionIds })
        .andWhere("userId = :userId", { userId })
        .execute();

      return { reconciled: transactions.length };
    });
  }
}
