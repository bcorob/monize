import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Institution } from "./entities/institution.entity";
import { Account } from "../accounts/entities/account.entity";
import { InstitutionsService } from "./institutions.service";
import { InstitutionsController } from "./institutions.controller";
import { ActionHistoryModule } from "../action-history/action-history.module";
import { FaviconModule } from "../common/favicon/favicon.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([Institution, Account]),
    ActionHistoryModule,
    FaviconModule,
  ],
  providers: [InstitutionsService],
  controllers: [InstitutionsController],
  exports: [InstitutionsService],
})
export class InstitutionsModule {}
