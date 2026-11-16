import { IsIn, IsOptional } from "class-validator";
import {
  BANK_SYNC_PROVIDERS,
  type BankSyncProviderName,
} from "../bank-sync.constants";

/** Omission preserves the existing Enable Banking API contract. */
export class BankSyncProviderQueryDto {
  @IsOptional()
  @IsIn(BANK_SYNC_PROVIDERS)
  provider?: BankSyncProviderName;
}
