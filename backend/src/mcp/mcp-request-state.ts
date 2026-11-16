import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash } from "crypto";
import {
  createRequestStateCodec,
  type RequestStateCodec,
  type ServerContext,
} from "@modelcontextprotocol/server";

/**
 * What a confirmation carries between the two rounds of a 2026-07-28 write.
 *
 * The server holds nothing between them: the whole exchange is one result the
 * client echoes back. `fingerprint` is what the user was shown, so the round
 * that writes can prove it is committing the change that was approved rather
 * than whatever the second call happens to describe.
 */
export interface McpConfirmState {
  v: 1;
  /** The `inputRequests` keys this confirmation asked about, in order. */
  keys: string[];
  /** Hash of the action set the user was asked to approve. */
  fingerprint: string;
}

/**
 * The seal on a multi round-trip confirmation.
 *
 * `requestState` round-trips through the client, so it comes back as
 * attacker-controlled input. The SDK applies no integrity protection of its own
 * and hands the raw string to the handler unless a verifier is configured; this
 * codec is that verifier, and the seam runs it BEFORE the handler, refusing a
 * bad or expired state with `-32602` rather than letting a tool read it.
 *
 * Two properties matter beyond the MAC:
 *
 * - **It is bound to the credential and the method**, so a state minted for one
 *   caller cannot be replayed by another, or against a different tool. That is
 *   INV-MCP-001 applied to a confirmation: the credential on the round that
 *   writes must be the credential that was asked.
 * - **It is signed, not encrypted.** The client can read the payload, so it
 *   holds a fingerprint and nothing else -- no row ids, no amounts, no names.
 *
 * The key is derived from `JWT_SECRET` with its own label, like
 * `AiActionSigningService`: `JWT_SECRET` is enforced at startup, so this path
 * cannot silently lose its integrity on a deployment that configured no other
 * secret. The hash makes it 32 bytes whatever the secret's length, which the
 * codec requires.
 */
@Injectable()
export class McpRequestStateCodec {
  private readonly codec: RequestStateCodec<McpConfirmState>;

  constructor(private readonly configService: ConfigService) {
    const secret = this.configService.get<string>("JWT_SECRET") ?? "";
    this.codec = createRequestStateCodec<McpConfirmState>({
      key: createHash("sha256")
        .update(`${secret}:mcp-request-state-v1`)
        .digest(),
      // The window a human has to answer. It matches the AI Assistant's own
      // confirmation card (AI_ACTION_TTL_MS), because it is the same decision
      // asked in a different place.
      ttlSeconds: 600,
      bind: (ctx) =>
        `${ctx.mcpReq.method} ${ctx.http?.authInfo?.clientId ?? ""}`,
    });
  }

  mint(payload: McpConfirmState, ctx: ServerContext): Promise<string> {
    return this.codec.mint(payload, ctx);
  }

  /** Drop-in for `ServerOptions.requestState.verify`. */
  get verify(): (
    state: string,
    ctx: ServerContext,
  ) => Promise<McpConfirmState> {
    return (state, ctx) => this.codec.verify(state, ctx);
  }
}
