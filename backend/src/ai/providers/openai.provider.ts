import OpenAI from "openai";
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
import {
  contentToPlainText,
  isContentBlocks,
  unsupportedAttachmentNote,
} from "./content-blocks.util";
import { providerFetch } from "./long-running-fetch";
import { unverifiedModelReason } from "./model-verification.util";
import { toolsField } from "./tools-field.util";
import { serverToolsField } from "./web-search-tool.util";

export class OpenAiProvider implements AiProvider {
  readonly name: string = "openai";
  readonly supportsStreaming = true;
  readonly supportsToolUse = true;
  readonly supportsWebSearch: boolean = true;

  protected readonly client: OpenAI;
  protected readonly modelId: string;

  constructor(
    apiKey: string,
    model?: string,
    baseUrl?: string,
    /**
     * The fetch the SDK sends through. It carries the egress policy (which
     * addresses the request may reach) and never follows a redirect; the
     * factory passes the one the config's owner is entitled to, and the
     * default is the strictest.
     */
    fetchImpl: typeof fetch = providerFetch("public-only"),
  ) {
    this.client = new OpenAI({
      apiKey,
      ...(baseUrl && { baseURL: baseUrl }),
      // Inject our long-running fetch wrapper so SDK calls inherit the
      // disabled bodyTimeout/headersTimeout. See long-running-fetch.ts.
      fetch: fetchImpl,
    });
    this.modelId = model || "gpt-4o";
  }

  private toOpenAiMessages(
    messages: AiMessage[],
    systemPrompt: string,
  ): OpenAI.ChatCompletionMessageParam[] {
    const result: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
    ];

    for (const msg of messages) {
      if (msg.role === "user") {
        result.push({
          role: "user",
          content: this.mapUserContent(msg.content),
        });
      } else if (msg.role === "assistant") {
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          result.push({
            role: "assistant",
            content: msg.content || null,
            tool_calls: msg.toolCalls.map((tc) => ({
              id: tc.id,
              type: "function" as const,
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.input),
              },
            })),
          });
        } else {
          result.push({ role: "assistant", content: msg.content });
        }
      } else if (msg.role === "tool") {
        result.push({
          role: "tool",
          tool_call_id: msg.toolCallId,
          content: msg.content,
        });
      }
    }

    return result;
  }

  /**
   * Map a user turn's content to OpenAI's native shape. Plain strings pass
   * through; multimodal blocks become content parts. Images map to `image_url`
   * data URLs. OpenAI's chat.completions has no portable PDF-input path, so a
   * `document` block degrades to a text note telling the model what happened.
   */
  private mapUserContent(
    content: string | AiContentBlock[],
  ): OpenAI.ChatCompletionUserMessageParam["content"] {
    if (!isContentBlocks(content)) {
      return content;
    }
    return content.map((block): OpenAI.ChatCompletionContentPart => {
      if (block.type === "image") {
        return {
          type: "image_url",
          image_url: { url: `data:${block.mediaType};base64,${block.data}` },
        };
      }
      if (block.type === "document") {
        return {
          type: "text",
          text: unsupportedAttachmentNote("PDF", block.filename, this.name),
        };
      }
      return { type: "text", text: block.text };
    });
  }

  private toSimpleMessages(
    messages: AiMessage[],
    systemPrompt: string,
  ): OpenAI.ChatCompletionMessageParam[] {
    return [
      { role: "system", content: systemPrompt },
      ...messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({
          role: m.role as "user" | "assistant",
          content: contentToPlainText(m.content),
        })),
    ];
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResponse> {
    const messages = this.toSimpleMessages(
      request.messages,
      request.systemPrompt,
    );

    const response = await this.client.chat.completions.create({
      model: this.modelId,
      messages,
      max_tokens: request.maxTokens || 1024,
      ...(request.temperature !== undefined && {
        temperature: request.temperature,
      }),
      ...(request.responseFormat === "json" && {
        response_format: { type: "json_object" as const },
      }),
    });

    const choice = response.choices[0];

    return {
      content: choice?.message?.content || "",
      usage: {
        inputTokens: response.usage?.prompt_tokens || 0,
        outputTokens: response.usage?.completion_tokens || 0,
      },
      model: response.model,
      provider: this.name,
    };
  }

  /**
   * One tool-free completion with OpenAI's hosted web search, through the
   * Responses API (chat.completions has no server-side search). The tool type
   * has moved once already (`web_search_preview` -> `web_search`), so a 400
   * rejecting the current type is retried with the older one; if the model
   * takes neither, the request degrades to a plain JSON completion with
   * `searched: false` rather than failing the caller.
   *
   * OpenAI has no `max_uses`; `search.maxUses` is passed as an instruction.
   */
  async completeWithWebSearch(
    request: AiCompletionRequest,
    search: AiWebSearchOptions,
  ): Promise<AiWebSearchResponse> {
    const input: OpenAI.Responses.ResponseInput = request.messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: contentToPlainText(m.content),
      }));
    const instructions = [
      request.systemPrompt,
      `Use the web search tool at most ${search.maxUses} times.`,
    ]
      .filter(Boolean)
      .join("\n\n");

    const send = (toolType: "web_search" | "web_search_preview") =>
      this.client.responses.create({
        model: this.modelId,
        instructions,
        input,
        max_output_tokens: request.maxTokens || 1024,
        ...serverToolsField<OpenAI.Responses.Tool>(
          toolType === "web_search"
            ? {
                type: "web_search",
                ...(search.allowedDomains && search.allowedDomains.length > 0
                  ? { filters: { allowed_domains: search.allowedDomains } }
                  : {}),
              }
            : { type: "web_search_preview" },
        ),
        ...(request.temperature !== undefined && {
          temperature: request.temperature,
        }),
        ...(request.responseFormat === "json" && {
          text: { format: { type: "json_object" as const } },
        }),
      });

    let response: OpenAI.Responses.Response;
    try {
      response = await send("web_search");
    } catch (error) {
      if (!isToolTypeRejection(error)) {
        throw error;
      }
      try {
        response = await send("web_search_preview");
      } catch (retryError) {
        if (!isToolTypeRejection(retryError)) {
          throw retryError;
        }
        const plain = await this.complete({
          ...request,
          responseFormat: "json",
        });
        return { ...plain, searched: false, searchCount: 0 };
      }
    }

    // Same rule as AnthropicProvider.hasWebSearchResults: a search that ran
    // and failed is not a search that answered. Counting it would report
    // `searched: true` for an answer that came from model memory, and the
    // payee lookup reads that as `ai-web-search` -- the one source it trusts
    // with an address and a phone number at any confidence.
    const searchCount = response.output.filter(
      (item) => item.type === "web_search_call" && item.status === "completed",
    ).length;

    return {
      content: response.output_text || "",
      usage: {
        inputTokens: response.usage?.input_tokens || 0,
        outputTokens: response.usage?.output_tokens || 0,
      },
      model: response.model,
      provider: this.name,
      searched: searchCount > 0,
      searchCount,
    };
  }

  async *stream(request: AiCompletionRequest): AsyncIterable<AiStreamChunk> {
    const messages = this.toSimpleMessages(
      request.messages,
      request.systemPrompt,
    );

    const stream = await this.client.chat.completions.create({
      model: this.modelId,
      messages,
      max_tokens: request.maxTokens || 1024,
      stream: true,
      ...(request.temperature !== undefined && {
        temperature: request.temperature,
      }),
      ...(request.responseFormat === "json" && {
        response_format: { type: "json_object" as const },
      }),
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        yield { content: delta, done: false };
      }
    }

    yield { content: "", done: true };
  }

  async completeWithTools(
    request: AiCompletionRequest,
    tools: AiToolDefinition[],
  ): Promise<AiToolResponse> {
    const messages = this.toOpenAiMessages(
      request.messages,
      request.systemPrompt,
    );

    const response = await this.client.chat.completions.create({
      model: this.modelId,
      messages,
      max_tokens: request.maxTokens || 4096,
      ...toolsField(tools, (tool) => ({
        type: "function" as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      })),
      ...(request.temperature !== undefined && {
        temperature: request.temperature,
      }),
    });

    const choice = response.choices[0];
    const toolCalls = (choice?.message?.tool_calls || [])
      .filter(
        (
          tc,
        ): tc is OpenAI.ChatCompletionMessageToolCall & { type: "function" } =>
          tc.type === "function",
      )
      .map((tc) => {
        let input: Record<string, unknown>;
        try {
          input = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch {
          input = {};
        }
        return { id: tc.id, name: tc.function.name, input };
      });

    const finishReason = choice?.finish_reason;
    const stopReason =
      finishReason === "tool_calls"
        ? ("tool_use" as const)
        : finishReason === "length"
          ? ("max_tokens" as const)
          : ("end_turn" as const);

    return {
      content: choice?.message?.content || "",
      toolCalls,
      usage: {
        inputTokens: response.usage?.prompt_tokens || 0,
        outputTokens: response.usage?.completion_tokens || 0,
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
    const messages = this.toOpenAiMessages(
      request.messages,
      request.systemPrompt,
    );

    const stream = await this.client.chat.completions.create({
      model: this.modelId,
      messages,
      max_tokens: request.maxTokens || 4096,
      stream: true,
      stream_options: { include_usage: true },
      ...toolsField(tools, (tool) => ({
        type: "function" as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      })),
      ...(request.temperature !== undefined && {
        temperature: request.temperature,
      }),
    });

    let accumulatedContent = "";
    // Per choice index → per tool-call index → accumulator
    const toolBuffers = new Map<
      number,
      { id: string; name: string; argsBuffer: string }
    >();
    let finishReason: string | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    let modelId = this.modelId;

    for await (const chunk of stream) {
      if (chunk.model) modelId = chunk.model;
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens || 0;
        outputTokens = chunk.usage.completion_tokens || 0;
      }

      const choice = chunk.choices[0];
      if (!choice) continue;

      const delta = choice.delta;
      if (delta?.content) {
        accumulatedContent += delta.content;
        yield { type: "text", text: delta.content };
      }

      if (delta?.tool_calls) {
        for (const tcDelta of delta.tool_calls) {
          const idx = tcDelta.index;
          let buffer = toolBuffers.get(idx);
          if (!buffer) {
            buffer = { id: "", name: "", argsBuffer: "" };
            toolBuffers.set(idx, buffer);
          }
          if (tcDelta.id) buffer.id = tcDelta.id;
          if (tcDelta.function?.name) buffer.name = tcDelta.function.name;
          if (tcDelta.function?.arguments) {
            buffer.argsBuffer += tcDelta.function.arguments;
          }
        }
      }

      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }
    }

    const toolCalls = Array.from(toolBuffers.values()).map((buf) => {
      let input: Record<string, unknown>;
      try {
        input = buf.argsBuffer
          ? (JSON.parse(buf.argsBuffer) as Record<string, unknown>)
          : {};
      } catch {
        input = {};
      }
      return { id: buf.id, name: buf.name, input };
    });

    const stopReason: "end_turn" | "tool_use" | "max_tokens" =
      finishReason === "tool_calls"
        ? "tool_use"
        : finishReason === "length"
          ? "max_tokens"
          : "end_turn";

    yield {
      type: "done",
      content: accumulatedContent,
      toolCalls,
      usage: { inputTokens, outputTokens },
      model: modelId,
      stopReason,
    };
  }

  async isAvailable(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        await this.client.models.list();
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
      await this.client.models.retrieve(this.modelId, {
        signal: controller.signal,
      });
      return { ok: true, model: this.modelId };
    } catch (error) {
      const status = (error as { status?: number })?.status;
      if (status === 404) {
        return {
          ok: false,
          model: this.modelId,
          reason: `Model "${this.modelId}" was not found. Check the model id for typos, or confirm your API key has access to it.`,
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

/**
 * A 400 whose message names the search tool type is the model declining the
 * tool, not the request; anything else (auth, rate limit, a bad model id) is
 * rethrown as-is.
 */
function isToolTypeRejection(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status;
  if (status !== 400) return false;
  const message = error instanceof Error ? error.message : String(error);
  return /web_search/.test(message);
}
