import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Category } from "./entities/category.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { Payee } from "../payees/entities/payee.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "../scheduled-transactions/entities/scheduled-transaction-split.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { CategoriesService } from "./categories.service";
import { JointCategoriesService } from "./joint-categories.service";
import { CategoryDetailService } from "./category-detail.service";
import { CategoriesController } from "./categories.controller";
import { ActionHistoryModule } from "../action-history/action-history.module";
import { DelegationModule } from "../delegation/delegation.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Category,
      Transaction,
      TransactionSplit,
      Payee,
      ScheduledTransaction,
      ScheduledTransactionSplit,
      UserPreference,
    ]),
    ActionHistoryModule,
    // A joint grantee creates on the OWNER's ledger; JointAccountsService is
    // the authoritative decision for that (one-directional -- DelegationModule
    // does not import CategoriesModule).
    DelegationModule,
  ],
  providers: [CategoriesService, CategoryDetailService, JointCategoriesService],
  controllers: [CategoriesController],
  exports: [CategoriesService],
})
export class CategoriesModule {}
