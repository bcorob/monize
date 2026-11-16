import { ApiProperty } from "@nestjs/swagger";
import { IsUUID } from "class-validator";

/**
 * The two legs a person confirmed are one transfer.
 *
 * Ids only. Every other condition -- same security, same day, same shares,
 * opposite actions, two accounts, neither already linked -- is re-checked on
 * the stored rows inside the transaction that links them, because a body that
 * restated them would be a second opinion the server would have to reconcile.
 */
export class LinkTransferPairDto {
  @ApiProperty({ description: "The leg that released the shares" })
  @IsUUID()
  outTransactionId: string;

  @ApiProperty({ description: "The leg that received them" })
  @IsUUID()
  inTransactionId: string;
}
