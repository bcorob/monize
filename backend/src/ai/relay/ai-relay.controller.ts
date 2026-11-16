import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  Request,
  Res,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { Throttle } from "@nestjs/throttler";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Response } from "express";
import {
  AiRelayService,
  RelayStreamClosedError,
  RelayTimeoutError,
} from "./ai-relay.service";
import { RelayQueryDto } from "./dto/relay-query.dto";
import { RelayTunnelStatus } from "./ai-relay.types";
import { PendingAiAction } from "../actions/ai-action.types";
import { tr } from "../../i18n/translate";
import { SSE_HEADERS, sseData } from "../../common/sse.util";

/**
 * Browser side of the reverse MCP relay. The chat posts a prompt here; the
 * request is held open (SSE) until the user's MCP agent answers it through the
 * post_response tool, or it times out. Status is exposed for the tunnel
 * indicator. The agent side lives in the MCP relay tools.
 */
@ApiTags("AI")
@ApiBearerAuth()
@Controller("ai/relay")
@UseGuards(AuthGuard("jwt"))
export class AiRelayController {
  private readonly logger = new Logger(AiRelayController.name);

  constructor(private readonly relayService: AiRelayService) {}

  @Get("status")
  @ApiOperation({ summary: "Reverse MCP relay tunnel status" })
  @Throttle({ default: { ttl: 60000, limit: 120 } })
  status(@Request() req: { user: { id: string } }): Promise<RelayTunnelStatus> {
    return this.relayService.getStatus(req.user.id);
  }

  @Post("query/stream")
  @ApiOperation({
    summary: "Send a chat prompt to the user's MCP agent and stream the answer",
  })
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  async streamQuery(
    @Request() req: { user: { id: string } },
    @Body() dto: RelayQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    for (const [header, value] of Object.entries(SSE_HEADERS)) {
      res.setHeader(header, value);
    }
    res.flushHeaders();

    const userId = req.user.id;
    const start = Date.now();

    const aborted = { value: false };
    // The waiter parks for minutes; a closed socket ends it at once rather than
    // holding a connection and a poll for a browser that is gone. The row is
    // left alone either way, so a late answer is still picked up on return.
    const closed = new AbortController();
    res.on("close", () => {
      aborted.value = true;
      closed.abort();
    });

    // Keepalive: a parked agent may take minutes to answer; comment lines reset
    // proxy body timeouts without disturbing SSE consumers.
    const heartbeat = setInterval(() => {
      if (!aborted.value && !res.writableEnded) {
        res.write(`: heartbeat ${Date.now()}\n\n`);
      }
    }, 15_000);

    const write = (event: Record<string, unknown>): void => {
      if (!aborted.value && !res.writableEnded) {
        // The agent's answer is user-controlled text: escape markup characters
        // before the frame reaches the socket.
        res.write(sseData(event));
      }
    };

    try {
      const history = (dto.conversationHistory ?? []).map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const response = await this.relayService.enqueuePrompt(
        userId,
        dto.query,
        history,
        {
          // Lets a write tool render its confirmation card in this browser
          // stream while the agent is still working on the prompt.
          emit: write,
          // Tell the client its promptId up front so that if the stream dies
          // before the answer arrives it can poll the pickup endpoint for a
          // late answer (Fix 1) instead of showing a hard error.
          onEnqueued: (promptId) => write({ type: "prompt_id", promptId }),
          // Uploaded attachments, exposed to the agent as MCP resources.
          // Validated before the row is written, so a bad upload throws below.
          attachments: dto.attachments,
          signal: closed.signal,
        },
      );
      // Emit `content` (not `assistant_text`): the chat store treats
      // assistant_text as ephemeral "thinking" text and only `content` creates
      // the persisted assistant message, so the answer must arrive as content.
      write({ type: "content", text: response.text });
      write({ type: "done" });
    } catch (error) {
      if (error instanceof RelayStreamClosedError) {
        // The browser left. Nothing to say and nowhere to say it; the answer,
        // if one arrives, waits on the row for the pickup endpoint.
        return;
      }
      const rawMessage =
        error instanceof Error ? error.message : "Unknown error";
      this.logger.warn(
        `Relay stream failed user=${userId} after=${Date.now() - start}ms: ${rawMessage}`,
      );
      // A rejected attachment (oversize/corrupt/mislabelled) is the user's to
      // fix, not a tunnel problem: surface a distinct message rather than the
      // generic timeout copy, before the prompt was ever queued.
      const wentQuiet =
        error instanceof RelayTimeoutError && error.reason === "disconnected";
      const message =
        error instanceof BadRequestException
          ? tr(
              "errors.ai.relayAttachmentRejected",
              "An attachment could not be sent to your assistant. Check the file type and size, then try again.",
            )
          : wentQuiet
            ? tr(
                "errors.ai.relayDisconnected",
                "Your assistant went quiet before answering. If it reconnects, its answer will appear here.",
              )
            : tr(
                "errors.ai.relayTimeout",
                "Your assistant did not respond. Make sure your MCP agent is connected and listening.",
              );
      write({ type: "error", message });
    } finally {
      clearInterval(heartbeat);
      if (!aborted.value && !res.writableEnded) {
        res.end();
      }
    }
  }

  @Get("response/:promptId")
  @ApiOperation({
    summary: "Pick up a late relay answer buffered after the stream gave up",
  })
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  async pickupResponse(
    @Request() req: { user: { id: string } },
    @Param("promptId", ParseUUIDPipe) promptId: string,
  ): Promise<{ text: string | null; pendingActions: PendingAiAction[] }> {
    const buffered = await this.relayService.takeBufferedResponse(
      req.user.id,
      promptId,
    );
    // Confirmation cards composed after the stream gave up are buffered per user
    // (not per prompt), so drain them on the same pickup the client already
    // polls -- the browser renders any cards and keeps polling for the answer.
    const pendingActions = await this.relayService.takeBufferedActions(
      req.user.id,
    );
    return { text: buffered?.text ?? null, pendingActions };
  }
}
