import { ApiProperty } from "@nestjs/swagger";
import { TransactionAttachment } from "../entities/transaction-attachment.entity";

/**
 * One attachment as the list routes and the kind update answer it: the row,
 * the id of the scan original behind it, and the name of the warranty it
 * hangs off. A transaction's list carries its own rows and the documents of
 * every warranty linked to it (`attachment-parent.ts`), so `warrantyName` is
 * how a reader tells a receipt on the purchase from a receipt on one of its
 * warranties. `AttachmentsService` builds this shape; the class exists for
 * Swagger.
 */
export class AttachmentListItemDto extends TransactionAttachment {
  @ApiProperty({
    nullable: true,
    description:
      "The id of the unprocessed original behind a scanned document; null for an ordinary upload",
  })
  originalAttachmentId: string | null;

  @ApiProperty({
    nullable: true,
    description:
      "The name of the warranty this document belongs to; null for a transaction's own attachment",
  })
  warrantyName: string | null;
}
