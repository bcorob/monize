import { Module, forwardRef } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { TransactionRule } from "./transaction-rule.entity";
import { TransactionRuleApplication } from "./transaction-rule-application.entity";
import { ActionHistoryModule } from "../action-history/action-history.module";
import { AiReviewModule } from "../ai-review/ai-review.module";
import { TagsModule } from "../tags/tags.module";
import { TransactionRulesApplierService } from "./transaction-rules-applier.service";
import { TransactionRulesRunService } from "./transaction-rules-run.service";
import { TransactionRulesMatchService } from "./transaction-rules-match.service";
import { TransactionRuleApplicationsRetentionService } from "./transaction-rule-applications-retention.service";
import { TransactionRulesService } from "./transaction-rules.service";
import { TransactionRulesController } from "./transaction-rules.controller";
import { TransactionRuleToolPrepService } from "./rule-tool-prep.service";
import { AccountsModule } from "../accounts/accounts.module";
import { PayeesModule } from "../payees/payees.module";
import { NetWorthModule } from "../net-worth/net-worth.module";
import { TransactionsModule } from "../transactions/transactions.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([TransactionRule, TransactionRuleApplication]),
    // forwardRef: TagsModule reaches back here through DelegationModule.
    forwardRef(() => TagsModule),
    // forwardRef: AiReviewModule imports NotificationsModule, which reaches
    // this module back through ScheduledTransactionsModule.
    forwardRef(() => AiReviewModule),
    ActionHistoryModule,
    // Name resolution for the assistant and MCP rule tools. forwardRef: both
    // modules reach this one back through TransactionsModule.
    forwardRef(() => AccountsModule),
    forwardRef(() => PayeesModule),
    // The structural actions write through the split service and refresh net
    // worth after a manual run. forwardRef: TransactionsModule imports this
    // module for create()'s rules step.
    forwardRef(() => TransactionsModule),
    forwardRef(() => NetWorthModule),
  ],
  providers: [
    TransactionRulesService,
    TransactionRulesApplierService,
    TransactionRulesRunService,
    TransactionRulesMatchService,
    TransactionRuleToolPrepService,
    TransactionRuleApplicationsRetentionService,
  ],
  controllers: [TransactionRulesController],
  exports: [
    TransactionRulesService,
    TransactionRulesApplierService,
    TransactionRulesRunService,
    TransactionRuleToolPrepService,
  ],
})
export class TransactionRulesModule {}
