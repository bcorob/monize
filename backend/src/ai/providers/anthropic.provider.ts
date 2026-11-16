import Anthropic from "@anthropic-ai/sdk";
import { Logger } from "@nestjs/common";
import {
  AiProvider,
  AiCompletionRequest,
  AiCompletionResponse,
  AiStreamChunk,
  AiToolDefinition,
  AiToolResponse,
  AiToolStreamChunk,
  AiMessage,
  AiContentBlock,
  AiWebSearchOptions,
  AiWebSearchResponse,
  ModelVerificationResult,
} from "./ai-provider.interface";
import { anthropicTemperatureField } from "./anthropic-sampling.util";
import { contentToPlainText, isContentBlocks } from "./content-blocks.util";
import { providerFetch } from "./long-running-fetch";
import { unverifiedModelReason } from "./model-verification.util";
import { toolsField } from "./tools-field.util";
import {
  anthropicWebSearchTool,
  AnthropicWebSearchVariant,
  isUnsupportedWebSearchVariantError,
  otherAnthropicWebSearchVariant,
  preferredAnthropicWebSearchVariant,
  serverToolsField,
} from "./web-search-tool.util";

/**
 * How many times a `pause_turn` (the server-side search loop yielding control
 * before it is done) is resumed before the turn is treated as unanswered.
 */
const MAX_WEB_SEARCH_CONTINUATIONS = 1;

export class AnthropicProvider implements AiProvider {
  readonly name = "anthropic";
  readonly supportsStreaming = true;
  readonly supportsToolUse = true;
  readonly supportsWebSearch = true;

  private readonly logger = new Logger(AnthropicProvider.name);
  private readonly client: Anthropic;
  private readonly modelId: string;

  constructor(
    apiKey: string,
    model?: string,
    /** The egress-policy fetch; see `OpenAiProvider`'s constructor. */
    fetchImpl: typeof fetch = providerFetch("public-only"),
  ) {
    this.client = new Anthropic({
      apiKey,
      // Inject our long-running fetch wrapper so SDK calls inherit the
      // disabled bodyTimeout/headersTimeout. See long-running-fetch.ts.
      fetch: fetchImpl,
    });
    this.modelId = model || "claude-sonnet-4-20250514";
  }

  private toAnthropicMessages(messages: AiMessage[]): Anthropic.MessageParam[] {
    const result: Anthropic.MessageParam[] = [];

    for (const msg of messages) {
      if (msg.role === "user") {
        result.push({
          role: "user",
          content: this.mapUserContent(msg.content),
        });
      } else if (msg.role === "assistant") {
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          const content: Anthropic.ContentBlockParam[] = [];
          if (msg.content) {
            content.push({ type: "text", text: msg.content });
          }
          for (const tc of msg.toolCalls) {
            content.push({
              type: "tool_use",
              id: tc.id,
              name: tc.name,
              input: tc.input,
            });
          }
          result.push({ role: "assistant", content });
        } else {
          result.push({ role: "assistant", content: msg.content });
        }
      } else if (msg.role === "tool") {
        // Anthropic expects tool results as user messages with tool_result blocks
        // Group consecutive tool results into a single user message
        const lastResult = result[result.length - 1];
        const toolResultBlock: Anthropic.ToolResultBlockParam = {
          type: "tool_result",
          tool_use_id: msg.toolCallId,
          content: msg.content,
        };

        if (
          lastResult &&
          lastResult.role === "user" &&
          Array.isArray(lastResult.content) &&
          lastResult.content.length > 0 &&
          (lastResult.content[0] as Anthropic.ToolResultBlockParam).type ===
            "tool_result"
        ) {
          (lastResult.content as Anthropic.ToolResultBlockParam[]).push(
            toolResultBlock,
          );
        } else {
          result.push({ role: "user", content: [toolResultBlock] });
        }
      }
    }

    return result;
  }

  /**
   * Map a user turn's content to Anthropic's native shape. Plain strings pass
   * through; multimodal blocks become image/document content blocks. All
   * current Claude models support vision and base64 PDFs, so no block type
   * needs to degrade here.
   */
  private mapUserContent(
    content: string | AiContentBlock[],
  ): string | Anthropic.ContentBlockParam[] {
    if (!isContentBlocks(content)) {
      return content;
    }
    return content.map((block): Anthropic.ContentBlockParam => {
      if (block.type === "image") {
        return {
          type: "image",
          source: {
            type: "base64",
            media_type: block.mediaType,
            data: block.data,
          },
        };
      }
      if (block.type === "document") {
        return {
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: block.data,
          },
        };
      }
      return { type: "text", text: block.text };
    });
  }

  private toSimpleMessages(messages: AiMessage[]): Anthropic.MessageParam[] {
    return messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: contentToPlainText(m.content),
      }));
  }

  /**
   * Build the `system` parameter as a single cached text block so the large,
   * stable financial-context prompt (and the tool definitions, which render
   * before `system`) are served from Anthropic's prompt cache on repeated turns
   * of a multi-turn tool-use conversation instead of being re-billed at full
   * input cost every turn. A breakpoint on the last system block caches the
   * tools + system prefix together. Returns the bare string when there is no
   * prompt to cache.
   */
  private toCachedSystem(
    systemPrompt: string,
  ): string | Anthropic.TextBlockParam[] {
    if (!systemPrompt) {
      return systemPrompt;
    }
    return [
      {
        type: "text",
        text: systemPrompt,
        cache_control: { type: "ephemeral" },
      },
    ];
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResponse> {
    const response = await this.client.messages.create({
      model: this.modelId,
      max_tokens: request.maxTokens || 1024,
      system: this.toCachedSystem(request.systemPrompt),
      messages: this.toSimpleMessages(request.messages),
      ...anthropicTemperatureField(this.modelId, request.temperature),
    });

    const textContent = response.content
      .filter((block) => block.type === "text")
      .map((block) => ("text" in block ? block.text : ""))
      .join("");

    return {
      content: textContent,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      model: response.model,
      provider: this.name,
    };
  }

  /**
   * One tool-free completion with Anthropic's server-side web search enabled.
   * The search runs on Anthropic's side: results arrive as
   * `web_search_tool_result` blocks in the same response, and `usage`
   * reports how many searches ran. Two things are handled here rather than
   * left to the caller:
   *
   * - The tool type depends on the model, and the model is user-configured.
   *   The preferred variant is guessed from the id; if the API rejects it,
   *   the request is retried once with the other variant.
   * - `stop_reason: "pause_turn"` means the server paused a long search loop.
   *   The turn is resumed by sending the response content back as the
   *   assistant turn, at most `MAX_WEB_SEARCH_CONTINUATIONS` times.
   *
   * `searched` is true only when at least one search *returned results*: an
   * error result block carries an object (`{ error_code }`) instead of the
   * result array, and a request that never searched has no such block.
   */
  async completeWithWebSearch(
    request: AiCompletionRequest,
    search: AiWebSearchOptions,
  ): Promise<AiWebSearchResponse> {
    const messages = this.toSimpleMessages(request.messages);
    let variant: AnthropicWebSearchVariant = preferredAnthropicWebSearchVariant(
      this.modelId,
    );

    const send = (turns: Anthropic.MessageParam[]) =>
      this.client.messages.create({
        model: this.modelId,
        max_tokens: request.maxTokens || 1024,
        system: this.toCachedSystem(request.systemPrompt),
        messages: turns,
        ...serverToolsField(anthropicWebSearchTool(variant, search)),
        ...anthropicTemperatureField(this.modelId, request.temperature),
      });

    let response: Anthropic.Message;
    try {
      response = await send(messages);
    } catch (error) {
      if (!isUnsupportedWebSearchVariantError(error)) {
        throw error;
      }
      variant = otherAnthropicWebSearchVariant(variant);
      this.logger.log(
        `web search tool variant rejected for model=${this.modelId}; retrying with ${variant}`,
      );
      response = await send(messages);
    }

    let searchCount = response.usage.server_tool_use?.web_search_requests ?? 0;
    let searched = hasWebSearchResults(response.content);
    let inputTokens = response.usage.input_tokens;
    let outputTokens = response.usage.output_tokens;
    let textContent = textOf(response.content);
    let continuations = 0;
    let turns = messages;

    while (
      response.stop_reason === "pause_turn" &&
      continuations < MAX_WEB_SEARCH_CONTINUATIONS
    ) {
      continuations += 1;
      turns = [...turns, { role: "assistant", content: response.content }];
      response = await send(turns);
      searchCount += response.usage.server_tool_use?.web_search_requests ?? 0;
      searched = searched || hasWebSearchResults(response.content);
      inputTokens += response.usage.input_tokens;
      outputTokens += response.usage.output_tokens;
      textContent = textOf(response.content);
    }

    return {
      content: textContent,
      usage: { inputTokens, outputTokens },
      model: response.model,
      provider: this.name,
      searched: searched && searchCount > 0,
      searchCount,
    };
  }

  async *stream(request: AiCompletionRequest): AsyncIterable<AiStreamChunk> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);

    try {
      const stream = this.client.messages.stream(
        {
          model: this.modelId,
          max_tokens: request.maxTokens || 1024,
          system: this.toCachedSystem(request.systemPrompt),
          messages: this.toSimpleMessages(request.messages),
          ...anthropicTemperatureField(this.modelId, request.temperature),
        },
        { signal: controller.signal },
      );

      for await (const event of stream) {
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          yield { content: event.delta.text, done: false };
        }
      }

      yield { content: "", done: true };
    } finally {
      clearTimeout(timeout);
    }
  }

  async completeWithTools(
    request: AiCompletionRequest,
    tools: AiToolDefinition[],
  ): Promise<AiToolResponse> {
    const response = await this.client.messages.create({
      model: this.modelId,
      max_tokens: request.maxTokens || 4096,
      system: this.toCachedSystem(request.systemPrompt),
      messages: this.toAnthropicMessages(request.messages),
      ...toolsField(tools, (tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
      })),
      ...anthropicTemperatureField(this.modelId, request.temperature),
    });

    const textContent = response.content
      .filter((block) => block.type === "text")
      .map((block) => ("text" in block ? block.text : ""))
      .join("");

    const toolCalls = response.content
      .filter((block) => block.type === "tool_use")
      .map((block) => {
        const toolBlock = block as Anthropic.ToolUseBlock;
        return {
          id: toolBlock.id,
          name: toolBlock.name,
          input: toolBlock.input as Record<string, unknown>,
        };
      });

    const stopReason =
      response.stop_reason === "tool_use"
        ? ("tool_use" as const)
        : response.stop_reason === "max_tokens"
          ? ("max_tokens" as const)
          : ("end_turn" as const);

    return {
      content: textContent,
      toolCalls,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      model: response.model,
      provider: this.name,
      stopReason,
    };
  }

  async *streamWithTools(
    request: AiCompletionRequest,
    tools: AiToolDefinition[],
  ): AsyncIterable<AiToolStreamChunk> {
    const requestStart = Date.now();
    this.logger.log(
      `streamWithTools request model=${this.modelId} messages=${request.messages.length} tools=${tools.length}`,
    );

    let stream: ReturnType<Anthropic["messages"]["stream"]>;
    try {
      stream = this.client.messages.stream({
        model: this.modelId,
        max_tokens: request.maxTokens || 4096,
        system: this.toCachedSystem(request.systemPrompt),
        messages: this.toAnthropicMessages(request.messages),
        ...toolsField(tools, (tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
        })),
        ...anthropicTemperatureField(this.modelId, request.temperature),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `streamWithTools open failed model=${this.modelId} after=${Date.now() - requestStart}ms: ${message}`,
      );
      throw error;
    }

    let accumulatedContent = "";
    let firstTokenAt: number | null = null;
    // Per content block index: tool-use metadata + accumulated JSON arg string
    const toolBlocks = new Map<
      number,
      { id: string; name: string; jsonBuffer: string }
    >();

    try {
      for await (const event of stream) {
        if (event.type === "content_block_start") {
          if (event.content_block.type === "tool_use") {
            toolBlocks.set(event.index, {
              id: event.content_block.id,
              name: event.content_block.name,
              jsonBuffer: "",
            });
          }
        } else if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            if (firstTokenAt === null) {
              firstTokenAt = Date.now();
              this.logger.log(
                `streamWithTools first token model=${this.modelId} ttft=${firstTokenAt - requestStart}ms`,
              );
            }
            accumulatedContent += event.delta.text;
            yield { type: "text", text: event.delta.text };
          } else if (event.delta.type === "input_json_delta") {
            const block = toolBlocks.get(event.index);
            if (block) {
              block.jsonBuffer += event.delta.partial_json;
            }
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `streamWithTools stream failed model=${this.modelId} after=${Date.now() - requestStart}ms: ${message}`,
      );
      throw error;
    }

    // Use the SDK helper to get the final message with all metadata.
    const finalMessage = await stream.finalMessage();

    const toolCalls = finalMessage.content
      .filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
      )
      .map((block) => ({
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      }));

    const stopReason: "end_turn" | "tool_use" | "max_tokens" =
      finalMessage.stop_reason === "tool_use"
        ? "tool_use"
        : finalMessage.stop_reason === "max_tokens"
          ? "max_tokens"
          : "end_turn";

    this.logger.log(
      `streamWithTools done model=${finalMessage.model} totalMs=${Date.now() - requestStart} contentChars=${accumulatedContent.length} toolCalls=${toolCalls.length} inputTokens=${finalMessage.usage.input_tokens} outputTokens=${finalMessage.usage.output_tokens} stopReason=${stopReason}`,
    );

    yield {
      type: "done",
      content: accumulatedContent,
      toolCalls,
      usage: {
        inputTokens: finalMessage.usage.input_tokens,
        outputTokens: finalMessage.usage.output_tokens,
      },
      model: finalMessage.model,
      stopReason,
    };
  }

  async isAvailable(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        await this.client.models.list(
          { limit: 1 },
          { signal: controller.signal },
        );
        return true;
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      return false;
    }
  }

  async verifyModel(): Promise<ModelVerificationResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      await this.client.models.retrieve(this.modelId, undefined, {
        signal: controller.signal,
      });
      return { ok: true, model: this.modelId };
    } catch (error) {
      const status = (error as { status?: number })?.status;
      if (status === 404) {
        return {
          ok: false,
          model: this.modelId,
          reason: `Model "${this.modelId}" was not found. Check the model id for typos (e.g. claude-sonnet-4-20250514).`,
        };
      }
      if (status === 401 || status === 403) {
        return {
          ok: false,
          model: this.modelId,
          reason: `Authentication failed (${status}). The API key may be invalid or lack access to this model.`,
        };
      }
      return {
        ok: false,
        model: this.modelId,
        reason: unverifiedModelReason(this.name, this.modelId, error, status),
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function textOf(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => ("text" in block ? block.text : ""))
    .join("");
}

/**
 * A search that returned results carries an array; a failed search carries
 * an error object. Only the array form counts as having searched.
 */
function hasWebSearchResults(content: Anthropic.ContentBlock[]): boolean {
  return content.some(
    (block) =>
      block.type === "web_search_tool_result" && Array.isArray(block.content),
  );
}
