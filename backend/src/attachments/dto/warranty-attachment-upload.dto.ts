import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsOptional } from "class-validator";
import { DOCUMENT_KINDS, DocumentKind } from "../attachment-parent";

/**
 * The multipart text field beside `file` (and an optional `original`) on
 * `POST warranties/:warrantyId/attachments`. A transaction's upload takes no
 * body: its attachments are always `other` (W4), so the field exists only on
 * the warranty route.
 */
export class WarrantyAttachmentUploadDto {
  @ApiPropertyOptional({
    enum: DOCUMENT_KINDS,
    description:
      "What the document is: receipt, manual, photo, warranty (the certificate) or other (the default)",
  })
  @IsOptional()
  @IsIn(DOCUMENT_KINDS)
  documentKind?: DocumentKind;
}
