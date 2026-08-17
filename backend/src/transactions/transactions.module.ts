import { Module, forwardRef } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Transaction } from "./entities/transaction.entity";
import { TransactionSplit } from "./entities/transaction-split.entity";
import { Category } from "../categories/entities/category.entity";
import { Payee } from "../payees/entities/payee.entity";
import { InvestmentTransaction } from "../securities/entities/investment-transaction.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { TransactionsService } from "./transactions.service";
import { TransactionSplitService } from "./transaction-split.service";
import { TransactionTransferService } from "./transaction-transfer.service";
import { TransactionReconciliationService } from "./transaction-reconciliation.service";
import { TransactionAnalyticsService } from "./transaction-analytics.service";
import { TransactionBulkUpdateService } from "./transaction-bulk-update.service";
import { TransactionToolPrepService } from "./transaction-tool-prep.service";
import { JointRegisterService } from "./joint-register.service";
import { TransactionsController } from "./transactions.controller";
import { AccountsModule } from "../accounts/accounts.module";
import { PayeesModule } from "../payees/payees.module";
import { TagsModule } from "../tags/tags.module";
import { NetWorthModule } from "../net-worth/net-worth.module";
import { ActionHistoryModule } from "../action-history/action-history.module";
import { SecuritiesModule } from "../securities/securities.module";
import { DelegationModule } from "../delegation/delegation.module";
import { CurrenciesModule } from "../currencies/currencies.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Transaction,
      TransactionSplit,
      Category,
      Payee,
      InvestmentTransaction,
      UserPreference,
    ]),
    forwardRef(() => AccountsModule),
    forwardRef(() => NetWorthModule),
    forwardRef(() => SecuritiesModule),
    PayeesModule,
    TagsModule,
    ActionHistoryModule,
    DelegationModule,
    // Transfers resolve a cross-currency rate server-side rather than posting
    // at 1:1 when the request omits one (audit P5-002).
    CurrenciesModule,
  ],
  providers: [
    TransactionsService,
    TransactionSplitService,
    TransactionTransferService,
    TransactionReconciliationService,
    TransactionAnalyticsService,
    TransactionBulkUpdateService,
    TransactionToolPrepService,
    JointRegisterService,
  ],
  controllers: [TransactionsController],
  exports: [
    TransactionsService,
    TransactionAnalyticsService,
    TransactionTransferService,
    TransactionToolPrepService,
  ],
})
export class TransactionsModule {}
