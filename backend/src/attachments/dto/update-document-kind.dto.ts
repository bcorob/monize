import { ApiProperty } from "@nestjs/swagger";
import { IsIn } from "class-validator";
import { DOCUMENT_KINDS, DocumentKind } from "../attachment-parent";

/**
 * `PATCH attachments/:id`: what a warranty's document is, changed after
 * upload. The one field is required; a transaction's attachment has no kind
 * to change, which the service refuses.
 */
export class UpdateDocumentKindDto {
  @ApiProperty({
    enum: DOCUMENT_KINDS,
    description:
      "What the document is: receipt, manual, photo, warranty (the certificate) or other",
  })
  @IsIn(DOCUMENT_KINDS)
  documentKind: DocumentKind;
}
