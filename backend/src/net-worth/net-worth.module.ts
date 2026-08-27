import { Module, forwardRef } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { MonthlyAccountBalance } from "./entities/monthly-account-balance.entity";
import { Account } from "../accounts/entities/account.entity";
import { InvestmentTransaction } from "../securities/entities/investment-transaction.entity";
import { SecurityPrice } from "../securities/entities/security-price.entity";
import { Security } from "../securities/entities/security.entity";
import { ExchangeRate } from "../currencies/entities/exchange-rate.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { NetWorthService } from "./net-worth.service";
import { NetWorthController } from "./net-worth.controller";
import { DelegationModule } from "../delegation/delegation.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      MonthlyAccountBalance,
      Account,
      InvestmentTransaction,
      SecurityPrice,
      Security,
      ExchangeRate,
      UserPreference,
    ]),
    // forwardRef: this edge lies on a require cycle, so a bare reference is
    // `undefined` here under some load orders -- see `src/module-graph.spec.ts`.
    forwardRef(() => DelegationModule),
  ],
  providers: [NetWorthService],
  controllers: [NetWorthController],
  exports: [NetWorthService],
})
export class NetWorthModule {}
