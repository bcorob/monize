import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from "typeorm";

import { User } from "../../../users/entities/user.entity";

/** How the MCP resource must return the file to the agent. */
export type RelayAttachmentKind = "image" | "pdf" | "text";

/**
 * Metadata for a file uploaded with a relayed chat prompt. The bytes are the
 * `AiRelayAttachmentBlob` beside it.
 *
 * Replaces the per-process `Map` in `relay-attachment.store.ts`, which made the
 * reverse relay a single-process feature in its least obvious place: the
 * browser uploads to whichever replica served the POST and the agent reads the
 * `monize-attachment://` resource through whichever replica served its MCP
 * request.
 *
 * Deliberately not `ATTACHMENT_STORAGE_PROVIDER`: its `database` implementation
 * writes `attachment_blobs`, whose primary key is a foreign key to
 * `transaction_attachments` and whose policy reads the owner from that row, so
 * a relay attachment -- which has no transaction -- cannot be stored there.
 *
 * `expires_at` is the whole of the lifetime, and it outlives the longest a
 * prompt can stay in flight, so the agent can still read the file right up to
 * the moment the browser gives up.
 */
@Entity("ai_relay_attachments")
// Declared here as well as in schema.sql, under the same name: the integration
// harness builds its database from this metadata, so a constraint only
// schema.sql carries is one no integration spec can observe.
@Check("ck_ai_relay_attachments_kind", "kind IN ('image', 'pdf', 'text')")
export class AiRelayAttachment {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user?: User;

  @Column({ type: "text" })
  filename: string;

  /**
   * Defaulted in both databases, like `security_documents.document_type`: the
   * RLS enforcement spec's generic seeder invents a `t<n>` string for a NOT
   * NULL text column with no default, which no CHECK-constrained column can
   * accept. Every insert supplies the real value.
   */
  @Column({ type: "text", default: "text" })
  kind: RelayAttachmentKind;

  @Column({ type: "text" })
  mime: string;

  @Column({ type: "int" })
  size: number;

  @Column({
    type: "timestamptz",
    name: "created_at",
    default: () => "CURRENT_TIMESTAMP",
  })
  createdAt: Date;

  @Index("idx_ai_relay_attachments_expiry")
  @Column({ type: "timestamptz", name: "expires_at" })
  expiresAt: Date;
}
