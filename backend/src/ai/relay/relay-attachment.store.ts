import { Injectable } from "@nestjs/common";
import { randomUUID } from "crypto";
import { DataSource, EntityManager } from "typeorm";

import { AttachmentDto } from "../query/dto/ai-query.dto";
import { validateAttachments } from "../query/attachment-validation";
import { RelayAttachmentRef } from "./ai-relay.types";
import { RelayAttachmentKind } from "./entities/ai-relay-attachment.entity";
import { affectedRowCount, returnedRows } from "../../common/db/query-result";
import {
  runOutsideActiveScopedManager,
  withScopedDb,
} from "../../common/db/scoped-db";

/** URI scheme the agent reads to fetch a relayed attachment as an MCP resource. */
export const ATTACHMENT_URI_SCHEME = "monize-attachment";

/** Build the `monize-attachment://<id>` resource URI for an attachment id. */
export function attachmentUri(id: string): string {
  return `${ATTACHMENT_URI_SCHEME}://${id}`;
}

/**
 * How long a stored attachment is retained before the relay sweep reclaims it.
 * Matched to the relay broker's HARD_WAIT_MS so an attachment always outlives
 * the longest a prompt can stay in flight (the agent can still read it right up
 * to the moment the browser gives up).
 */
export const ATTACHMENT_TTL_MS = 20 * 60 * 1000; // 20 minutes

/** A validated attachment, with the bytes read back. */
export interface StoredAttachment {
  id: string;
  userId: string;
  kind: RelayAttachmentKind;
  mediaType: string;
  filename: string;
  /** Decoded bytes (validated for size and magic-byte signature on upload). */
  data: Buffer;
}

/** The metadata row plus its bytes, as the lookup reads them back. */
interface AttachmentRow {
  id: string;
  filename: string;
  kind: RelayAttachmentKind;
  mime: string;
  data: Buffer;
}

/**
 * Attachments uploaded with a relayed prompt.
 *
 * Rows, not a per-process `Map`: the browser uploads to whichever replica
 * served its POST and the agent reads the file through whichever replica served
 * its MCP request, and in memory those are two different pods.
 *
 * Not `ATTACHMENT_STORAGE_PROVIDER` either, which the plan proposed: the
 * provider's `database` implementation writes `attachment_blobs`, whose primary
 * key is a foreign key to `transaction_attachments` and whose policy reads the
 * owner from that row, so a relay attachment -- which has no transaction --
 * cannot be stored there at all. Branching on the bound provider's name would
 * be the generic solution that looks fine in isolation and wrong in place. The
 * table pair here mirrors `transaction_attachments`/`attachment_blobs` instead,
 * and buys something the provider cannot: bytes and metadata commit or roll
 * back together, with no window where one exists without the other, and the
 * cascade reclaims the bytes so the sweep has nothing external to leak.
 *
 * A cross-user read stays structurally impossible: every statement filters on
 * `user_id` as well as the id, so the id alone never addresses a file.
 */
@Injectable()
export class RelayAttachmentStore {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Validate and persist attachments for a user, returning lightweight refs (no
   * bytes) to carry on the queued prompt. Re-runs the shared
   * `validateAttachments` (size limits + magic bytes) so the client is never
   * trusted, exactly like the native query path.
   *
   * One transaction for the whole batch: a rejected file leaves nothing behind,
   * and a prompt never reaches the agent referring to a file that is missing.
   */
  async store(
    userId: string,
    attachments: AttachmentDto[],
  ): Promise<RelayAttachmentRef[]> {
    if (attachments.length === 0) {
      return [];
    }
    validateAttachments(attachments);

    const prepared = attachments.map((att) => ({
      id: randomUUID(),
      filename: att.filename,
      kind: att.kind,
      mediaType: att.mediaType,
      // Strip any stray whitespace/newlines from the base64 before decoding.
      data: Buffer.from(att.data.replace(/\s+/g, ""), "base64"),
    }));

    return this.outside(async (manager) => {
      for (const item of prepared) {
        await manager.query(
          `INSERT INTO ai_relay_attachments
             (id, user_id, filename, kind, mime, size, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6,
                   CURRENT_TIMESTAMP + ($7::numeric / 1000 * INTERVAL '1 second'))`,
          [
            item.id,
            userId,
            item.filename,
            item.kind,
            item.mediaType,
            item.data.length,
            ATTACHMENT_TTL_MS,
          ],
        );
        await manager.query(
          `INSERT INTO ai_relay_attachment_blobs (attachment_id, data)
           VALUES ($1, $2)`,
          [item.id, item.data],
        );
      }
      return prepared.map((item) => ({
        id: item.id,
        filename: item.filename,
        mediaType: item.mediaType,
        kind: item.kind,
        uri: attachmentUri(item.id),
      }));
    });
  }

  /**
   * Look up a stored attachment for a user, or undefined if it is unknown,
   * expired, or somebody else's. The owner filter is in the statement, so an id
   * the agent guessed resolves to nothing rather than to another user's file.
   */
  async get(userId: string, id: string): Promise<StoredAttachment | undefined> {
    const [row] = returnedRows<AttachmentRow>(
      await this.outside((manager) =>
        manager.query(
          `SELECT a.id, a.filename, a.kind, a.mime, b.data
             FROM ai_relay_attachments a
             JOIN ai_relay_attachment_blobs b ON b.attachment_id = a.id
            WHERE a.id = $1 AND a.user_id = $2
              AND a.expires_at > CURRENT_TIMESTAMP`,
          [id, userId],
        ),
      ),
    );
    if (!row) {
      return undefined;
    }
    return {
      id: row.id,
      userId,
      kind: row.kind,
      mediaType: row.mime,
      filename: row.filename,
      data: row.data,
    };
  }

  /**
   * Drop a settled prompt's attachments. The TTL and the relay sweep are the
   * backstop; this just reclaims the space sooner. Missing ids are ignored, and
   * an id belonging to somebody else is one of them.
   */
  async releaseForPrompt(userId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await this.outside((manager) =>
      manager.query(
        // The blobs go with them: the foreign key cascades.
        `DELETE FROM ai_relay_attachments
          WHERE user_id = $1 AND id = ANY($2::uuid[])`,
        [userId, ids],
      ),
    );
  }

  /**
   * Take every attachment past its TTL, whatever prompt it belonged to. Called
   * by the relay sweep inside its transaction; returns how many rows went.
   *
   * Nothing to order against an object store, because there is none: the bytes
   * are a cascading child row, so they are gone exactly when the metadata is,
   * or not at all.
   */
  async sweepExpired(manager: EntityManager): Promise<number> {
    return affectedRowCount(
      await manager.query(
        `DELETE FROM ai_relay_attachments
          WHERE expires_at <= CURRENT_TIMESTAMP`,
      ),
    );
  }

  /**
   * Every statement runs in its own short transaction, outside whatever
   * transaction the caller is in -- the same rule `AiRelayService` follows, and
   * for the same reason: an attachment the browser just uploaded has to be
   * visible to an agent polling another replica the moment the prompt is
   * queued.
   */
  private outside<T>(fn: (manager: EntityManager) => Promise<T>): Promise<T> {
    return runOutsideActiveScopedManager(() =>
      withScopedDb(this.dataSource, fn),
    );
  }
}
