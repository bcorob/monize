import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Payee } from "./entities/payee.entity";
import { PayeeAlias } from "./entities/payee-alias.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { Category } from "../categories/entities/category.entity";
import { PayeesService } from "./payees.service";
import { PayeeDetailService } from "./payee-detail.service";
import { PayeeToolPrepService } from "./payee-tool-prep.service";
import { PayeeAutoMergeService } from "./payee-auto-merge.service";
import { PayeesController } from "./payees.controller";
import { ActionHistoryModule } from "../action-history/action-history.module";
import { FaviconModule } from "../common/favicon/favicon.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Payee,
      PayeeAlias,
      Transaction,
      ScheduledTransaction,
      Category,
    ]),
    ActionHistoryModule,
    FaviconModule,
  ],
  providers: [
    PayeesService,
    PayeeDetailService,
    PayeeToolPrepService,
    PayeeAutoMergeService,
  ],
  controllers: [PayeesController],
  exports: [PayeesService, PayeeToolPrepService],
})
export class PayeesModule {}
