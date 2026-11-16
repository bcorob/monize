import { Column, Entity, JoinColumn, OneToOne, PrimaryColumn } from "typeorm";

import { AiRelayAttachment } from "./ai-relay-attachment.entity";

/**
 * The bytes of a relay attachment, in their own table.
 *
 * The same split `attachment_blobs` makes over `transaction_attachments`, for
 * the same reason: the metadata lookups -- which run on every agent read and on
 * every sweep -- must never pull a BYTEA column with them.
 *
 * The cascade is what reclaims the bytes: deleting the metadata row takes them,
 * so the relay sweep has nothing outside PostgreSQL to leak and no ordering
 * between a row and an object to get wrong.
 */
@Entity("ai_relay_attachment_blobs")
export class AiRelayAttachmentBlob {
  @PrimaryColumn({ type: "uuid", name: "attachment_id" })
  attachmentId: string;

  // Declared so the entity-derived schema the integration harness builds
  // carries the same ON DELETE CASCADE schema.sql does.
  @OneToOne(() => AiRelayAttachment, { onDelete: "CASCADE" })
  @JoinColumn({ name: "attachment_id" })
  attachment?: AiRelayAttachment;

  /** `select: false`, so a careless `find` cannot drag megabytes with it. */
  @Column({ type: "bytea", select: false })
  data: Buffer;
}
