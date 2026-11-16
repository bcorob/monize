import { Injectable } from "@nestjs/common";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { RelayAttachmentStore } from "../../ai/relay/relay-attachment.store";
import { extractPdfText } from "../../common/pdf-text";
import { resolveUserContext, hasScope } from "../mcp-context";

/**
 * Serves attachments a user uploaded with a relayed chat prompt. The browser's
 * upload puts the bytes through the attachment storage provider and the relayed prompt
 * (get_next_prompt) hands the agent a `monize-attachment://<id>` URI per file;
 * the agent reads that URI here before answering. Images are returned as a
 * base64 blob; text/CSV and text-extractable PDFs are returned as text. A PDF
 * with no text layer (scanned/image-only) or one pdf.js cannot read falls
 * back to a base64 blob, exactly like an image, so a vision-capable client or
 * model can still read it.
 *
 * Security: the owning userId always comes from the session context, never from
 * the URI. The `{id}` is only half the lookup -- every statement in the store
 * filters on `user_id` too -- so a forged or guessed id can never resolve
 * another user's file.
 */
@Injectable()
export class McpRelayAttachmentResource {
  constructor(private readonly attachmentStore: RelayAttachmentStore) {}

  register(server: McpServer) {
    server.registerResource(
      "relay-attachment",
      // Templated, with no list callback: attachments are ephemeral and
      // per-prompt, so they must not appear in resources/list.
      new ResourceTemplate("monize-attachment://{id}", { list: undefined }),
      {
        // Live data: a cached answer here is a stale figure, not a stale name.
        cacheHint: { ttlMs: 0, cacheScope: "private" },
        title: "Chat attachment",
        description:
          "A file the user uploaded with their current chat prompt. Read the monize-attachment:// URI from get_next_prompt's attachments to view an image or PDF.",
      },
      async (uri, variables, ctx) => {
        const user = resolveUserContext(ctx);
        if (!user) {
          return {
            contents: [{ uri: uri.href, text: "Error: No user context" }],
          };
        }
        if (!hasScope(user.scopes, "read")) {
          return {
            contents: [
              {
                uri: uri.href,
                text: 'Error: Insufficient scope. Requires "read" scope.',
              },
            ],
          };
        }

        // Template vars may be string | string[]; an attachment id is a single
        // value.
        const rawId = variables.id;
        const id = Array.isArray(rawId) ? rawId[0] : rawId;
        const attachment = id
          ? await this.attachmentStore.get(user.userId, id)
          : undefined;
        if (!attachment) {
          return {
            contents: [
              {
                uri: uri.href,
                text: "Error: attachment not found or expired",
              },
            ],
          };
        }

        // Text/CSV is returned as text the agent can read directly.
        if (attachment.kind === "text") {
          return {
            contents: [
              {
                uri: uri.href,
                mimeType: attachment.mediaType,
                text: attachment.data.toString("utf-8"),
              },
            ],
          };
        }

        // PDFs are preferentially returned as extracted text, not a binary
        // blob: handing the agent's MCP client a raw application/pdf blob makes
        // it fall back to a local PDF handler that prompts the user to install
        // extra tooling. Returning text lets the agent read the PDF just like a
        // CSV. But a scanned/image-only PDF (no text layer) or one pdf.js
        // cannot read yields no usable text -- in that case fall through to the
        // raw bytes as a blob below, like an image, so a vision-capable client
        // or model can still read it.
        if (attachment.kind === "pdf") {
          try {
            const extracted = (await extractPdfText(attachment.data)).trim();
            if (extracted.length > 0) {
              return {
                contents: [
                  { uri: uri.href, mimeType: "text/plain", text: extracted },
                ],
              };
            }
            // No extractable text: fall through to the binary blob below.
          } catch {
            // pdf.js could not read the bytes: fall through to the binary
            // blob below rather than failing the read outright.
          }
        }

        // Images -- and PDFs with no extractable text -- are returned as a
        // base64 blob the agent's client renders or relays multimodally.
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: attachment.mediaType,
              blob: attachment.data.toString("base64"),
            },
          ],
        };
      },
    );
  }
}
