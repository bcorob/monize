import { AnthropicProvider } from "./anthropic.provider";
import type { AiToolStreamChunk, AiMessage } from "./ai-provider.interface";

const mockCreate = jest.fn().mockResolvedValue({
  content: [{ type: "text", text: "Hello from Claude" }],
  usage: { input_tokens: 10, output_tokens: 20 },
  model: "claude-sonnet-4-20250514",
});

const mockStreamEvents = [
  { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } },
  {
    type: "content_block_delta",
    delta: { type: "text_delta", text: " world" },
  },
  { type: "message_stop" },
];

const mockStream = jest.fn().mockReturnValue({
  [Symbol.asyncIterator]: () => {
    let idx = 0;
    return {
      next: () => {
        if (idx < mockStreamEvents.length) {
          return Promise.resolve({
            value: mockStreamEvents[idx++],
            done: false,
          });
        }
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  },
});

const mockList = jest.fn().mockResolvedValue({ data: [] });
const mockRetrieve = jest.fn();

jest.mock("@anthropic-ai/sdk", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    messages: {
      create: mockCreate,
      stream: mockStream,
    },
    models: {
      list: mockList,
      retrieve: mockRetrieve,
    },
  })),
}));

describe("AnthropicProvider", () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    provider = new AnthropicProvider(
      "test-api-key",
      "claude-sonnet-4-20250514",
    );
  });

  it("has correct provider properties", () => {
    expect(provider.name).toBe("anthropic");
    expect(provider.supportsStreaming).toBe(true);
    expect(provider.supportsToolUse).toBe(true);
  });

  it("maps multimodal user content to image/document/text blocks", async () => {
    const messages: AiMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "document",
            mediaType: "application/pdf",
            data: "JVBERi0=",
            filename: "a.pdf",
          },
          { type: "image", mediaType: "image/png", data: "iVBORw0=" },
          { type: "text", text: "extract this" },
        ],
      },
    ];

    await provider.completeWithTools({ systemPrompt: "sys", messages }, []);

    const sent = mockCreate.mock.calls[0][0].messages;
    expect(sent[0].content).toEqual([
      {
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: "JVBERi0=",
        },
      },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "iVBORw0=" },
      },
      { type: "text", text: "extract this" },
    ]);
  });

  it("constructs the SDK client with the long-running fetch wrapper", () => {
    // Regression: the SDK uses Node fetch (undici) under the hood, which
    // defaults bodyTimeout to 5 minutes. The provider must inject the
    // long-running fetch wrapper so SDK calls inherit disabled timeouts.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Anthropic = require("@anthropic-ai/sdk").default;
    const sdkOptions = Anthropic.mock.calls[Anthropic.mock.calls.length - 1][0];
    expect(typeof sdkOptions.fetch).toBe("function");
    expect(sdkOptions.fetch).not.toBe(global.fetch);
  });

  it("hands the SDK the egress-policy fetch the factory passes", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Anthropic = require("@anthropic-ai/sdk").default;
    const egressFetch = jest.fn() as unknown as typeof fetch;
    new AnthropicProvider("sk-test", "claude-sonnet-4-20250514", egressFetch);
    expect(Anthropic).toHaveBeenLastCalledWith(
      expect.objectContaining({ fetch: egressFetch }),
    );
  });

  describe("complete()", () => {
    it("returns formatted response", async () => {
      const result = await provider.complete({
        systemPrompt: "You are helpful.",
        messages: [{ role: "user", content: "Hello" }],
      });

      expect(result.content).toBe("Hello from Claude");
      expect(result.usage.inputTokens).toBe(10);
      expect(result.usage.outputTokens).toBe(20);
      expect(result.provider).toBe("anthropic");
      expect(result.model).toBe("claude-sonnet-4-20250514");
    });

    it("sends the system prompt as a cached text block for prompt caching", async () => {
      await provider.complete({
        systemPrompt: "You are helpful.",
        messages: [{ role: "user", content: "Hello" }],
      });

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.system).toEqual([
        {
          type: "text",
          text: "You are helpful.",
          cache_control: { type: "ephemeral" },
        },
      ]);
    });
  });

  describe("stream()", () => {
    it("yields text delta chunks and a final done chunk", async () => {
      const chunks: { content: string; done: boolean }[] = [];
      for await (const chunk of provider.stream({
        systemPrompt: "Be helpful.",
        messages: [{ role: "user", content: "Hi" }],
      })) {
        chunks.push(chunk);
      }

      expect(chunks).toEqual([
        { content: "Hello", done: false },
        { content: " world", done: false },
        { content: "", done: true },
      ]);
      expect(mockStream).toHaveBeenCalled();
    });
  });

  describe("completeWithTools()", () => {
    it("omits the tools field entirely when handed no tools", async () => {
      // The AI Assistant's final synthesis pass withdraws the tools to force
      // a text answer. An empty array is not the same request as no field.
      await provider.completeWithTools(
        {
          systemPrompt: "sys",
          messages: [{ role: "user", content: "summarize" }],
        },
        [],
      );

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs).not.toHaveProperty("tools");
    });

    it("sends the tools field when there are tools", async () => {
      await provider.completeWithTools(
        { systemPrompt: "sys", messages: [{ role: "user", content: "hi" }] },
        [
          {
            name: "get_account_balances",
            description: "balances",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      );

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.tools).toEqual([
        {
          name: "get_account_balances",
          description: "balances",
          input_schema: { type: "object", properties: {} },
        },
      ]);
    });

    it("returns text content and tool calls", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [
          { type: "text", text: "I'll categorize that." },
          {
            type: "tool_use",
            id: "tu_1",
            name: "categorize",
            input: { category: "food" },
          },
        ],
        usage: { input_tokens: 15, output_tokens: 25 },
        model: "claude-sonnet-4-20250514",
        stop_reason: "end_turn",
      });

      const result = await provider.completeWithTools(
        {
          systemPrompt: "Categorize.",
          messages: [{ role: "user", content: "Pizza" }],
        },
        [
          {
            name: "categorize",
            description: "Categorize a transaction",
            inputSchema: {
              type: "object",
              properties: { category: { type: "string" } },
            },
          },
        ],
      );

      expect(result.content).toBe("I'll categorize that.");
      expect(result.toolCalls).toEqual([
        { id: "tu_1", name: "categorize", input: { category: "food" } },
      ]);
      expect(result.usage.inputTokens).toBe(15);
      expect(result.usage.outputTokens).toBe(25);
      expect(result.provider).toBe("anthropic");
      expect(result.stopReason).toBe("end_turn");

      // The cached system block also caches the tools prefix that renders
      // before it, so multi-turn tool-use conversations hit the prompt cache.
      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.system[0].cache_control).toEqual({ type: "ephemeral" });
    });

    it("maps stop_reason tool_use correctly", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [
          {
            type: "tool_use",
            id: "tu_2",
            name: "get_balance",
            input: {},
          },
        ],
        usage: { input_tokens: 10, output_tokens: 15 },
        model: "claude-sonnet-4-20250514",
        stop_reason: "tool_use",
      });

      const result = await provider.completeWithTools(
        {
          systemPrompt: "test",
          messages: [{ role: "user", content: "balance?" }],
        },
        [
          {
            name: "get_balance",
            description: "Get balance",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      );

      expect(result.stopReason).toBe("tool_use");
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].id).toBe("tu_2");
    });

    it("handles multi-turn messages with tool results", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [
          { type: "text", text: "Based on the data, your balance is $5,000." },
        ],
        usage: { input_tokens: 50, output_tokens: 30 },
        model: "claude-sonnet-4-20250514",
        stop_reason: "end_turn",
      });

      await provider.completeWithTools(
        {
          systemPrompt: "You are helpful.",
          messages: [
            { role: "user", content: "My balance?" },
            {
              role: "assistant",
              content: "Let me check.",
              toolCalls: [{ id: "tu_1", name: "get_balance", input: {} }],
            },
            {
              role: "tool",
              toolCallId: "tu_1",
              name: "get_balance",
              content: '{"balance": 5000}',
            },
          ],
        },
        [
          {
            name: "get_balance",
            description: "Get balance",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      );

      // Verify the messages were correctly formatted for Anthropic
      const createCall = mockCreate.mock.calls[0][0];
      const messages = createCall.messages;

      // user + assistant with tool_use block + user with tool_result block
      expect(messages).toHaveLength(3);
      expect(messages[0].role).toBe("user");
      expect(messages[1].role).toBe("assistant");
      expect(messages[1].content).toEqual([
        { type: "text", text: "Let me check." },
        { type: "tool_use", id: "tu_1", name: "get_balance", input: {} },
      ]);
      expect(messages[2].role).toBe("user");
      expect(messages[2].content).toEqual([
        {
          type: "tool_result",
          tool_use_id: "tu_1",
          content: '{"balance": 5000}',
        },
      ]);
    });
  });

  describe("streamWithTools()", () => {
    type AnthropicEvent = Record<string, unknown>;
    type FinalMessage = Record<string, unknown>;

    const buildStream = (
      events: AnthropicEvent[],
      finalMessage: FinalMessage,
    ) => {
      const stream = {
        [Symbol.asyncIterator]: () => {
          let idx = 0;
          return {
            next: () => {
              if (idx < events.length) {
                return Promise.resolve({ value: events[idx++], done: false });
              }
              return Promise.resolve({ value: undefined, done: true });
            },
          };
        },
        finalMessage: jest.fn().mockResolvedValue(finalMessage),
      };
      return stream;
    };

    const tools = [
      {
        name: "get_account_balances",
        description: "Get balances",
        inputSchema: { type: "object", properties: {} },
      },
    ];

    it("yields text deltas as text chunks then a done chunk with end_turn", async () => {
      mockStream.mockReturnValueOnce(
        buildStream(
          [
            {
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "Your " },
            },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "balance is $5,000." },
            },
            { type: "content_block_stop", index: 0 },
            { type: "message_stop" },
          ],
          {
            content: [{ type: "text", text: "Your balance is $5,000." }],
            usage: { input_tokens: 30, output_tokens: 12 },
            model: "claude-sonnet-4-20250514",
            stop_reason: "end_turn",
          },
        ),
      );

      const chunks: AiToolStreamChunk[] = [];
      for await (const chunk of provider.streamWithTools(
        {
          systemPrompt: "Be brief.",
          messages: [{ role: "user", content: "balance?" }],
        },
        tools,
      )) {
        chunks.push(chunk);
      }

      expect(
        chunks
          .filter((c) => c.type === "text")
          .map((c) => (c.type === "text" ? c.text : "")),
      ).toEqual(["Your ", "balance is $5,000."]);
      const doneChunk = chunks[chunks.length - 1];
      expect(doneChunk.type).toBe("done");
      if (doneChunk.type === "done") {
        expect(doneChunk.content).toBe("Your balance is $5,000.");
        expect(doneChunk.toolCalls).toEqual([]);
        expect(doneChunk.stopReason).toBe("end_turn");
        expect(doneChunk.usage.inputTokens).toBe(30);
        expect(doneChunk.usage.outputTokens).toBe(12);
      }
    });

    it("emits accumulated tool calls from finalMessage with tool_use stop reason", async () => {
      mockStream.mockReturnValueOnce(
        buildStream(
          [
            {
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "Let me check." },
            },
            { type: "content_block_stop", index: 0 },
            {
              type: "content_block_start",
              index: 1,
              content_block: {
                type: "tool_use",
                id: "tu_1",
                name: "get_account_balances",
                input: {},
              },
            },
            {
              type: "content_block_delta",
              index: 1,
              delta: { type: "input_json_delta", partial_json: '{"days":' },
            },
            {
              type: "content_block_delta",
              index: 1,
              delta: { type: "input_json_delta", partial_json: "30}" },
            },
            { type: "content_block_stop", index: 1 },
            { type: "message_stop" },
          ],
          {
            content: [
              { type: "text", text: "Let me check." },
              {
                type: "tool_use",
                id: "tu_1",
                name: "get_account_balances",
                input: { days: 30 },
              },
            ],
            usage: { input_tokens: 25, output_tokens: 18 },
            model: "claude-sonnet-4-20250514",
            stop_reason: "tool_use",
          },
        ),
      );

      const chunks: AiToolStreamChunk[] = [];
      for await (const chunk of provider.streamWithTools(
        {
          systemPrompt: "test",
          messages: [{ role: "user", content: "balance?" }],
        },
        tools,
      )) {
        chunks.push(chunk);
      }

      const doneChunk = chunks[chunks.length - 1];
      expect(doneChunk.type).toBe("done");
      if (doneChunk.type === "done") {
        expect(doneChunk.stopReason).toBe("tool_use");
        expect(doneChunk.toolCalls).toEqual([
          { id: "tu_1", name: "get_account_balances", input: { days: 30 } },
        ]);
        expect(doneChunk.content).toBe("Let me check.");
      }
    });

    it("maps stop_reason max_tokens correctly", async () => {
      mockStream.mockReturnValueOnce(
        buildStream(
          [
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "truncated" },
            },
          ],
          {
            content: [{ type: "text", text: "truncated" }],
            usage: { input_tokens: 10, output_tokens: 4096 },
            model: "claude-sonnet-4-20250514",
            stop_reason: "max_tokens",
          },
        ),
      );

      const chunks: AiToolStreamChunk[] = [];
      for await (const chunk of provider.streamWithTools(
        { systemPrompt: "test", messages: [{ role: "user", content: "hi" }] },
        tools,
      )) {
        chunks.push(chunk);
      }

      const doneChunk = chunks[chunks.length - 1];
      if (doneChunk.type === "done") {
        expect(doneChunk.stopReason).toBe("max_tokens");
      }
    });
  });

  describe("isAvailable()", () => {
    it("returns true when API responds", async () => {
      const result = await provider.isAvailable();
      expect(result).toBe(true);
    });

    it("returns false when API throws", async () => {
      mockList.mockRejectedValueOnce(new Error("Unauthorized"));
      const result = await provider.isAvailable();
      expect(result).toBe(false);
    });
  });

  describe("verifyModel()", () => {
    it("returns ok when models.retrieve succeeds", async () => {
      mockRetrieve.mockResolvedValueOnce({ id: "claude-sonnet-4-20250514" });
      const result = await provider.verifyModel();
      expect(result).toEqual({
        ok: true,
        model: "claude-sonnet-4-20250514",
      });
      expect(mockRetrieve).toHaveBeenCalledWith(
        "claude-sonnet-4-20250514",
        undefined,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it("reports a not-found reason when retrieve returns 404", async () => {
      const err = Object.assign(new Error("not found"), { status: 404 });
      mockRetrieve.mockRejectedValueOnce(err);
      const result = await provider.verifyModel();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.model).toBe("claude-sonnet-4-20250514");
        expect(result.reason).toMatch(/not found/i);
      }
    });

    it("reports an auth-failure reason on 401", async () => {
      const err = Object.assign(new Error("Unauthorized"), { status: 401 });
      mockRetrieve.mockRejectedValueOnce(err);
      const result = await provider.verifyModel();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/authentication/i);
      }
    });

    it("falls back to a generic reason for other errors", async () => {
      mockRetrieve.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
      const result = await provider.verifyModel();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).not.toContain("ECONNREFUSED");
        expect(result.reason).toMatch(/could not verify the configured model/i);
      }
    });

    it("falls back to a generic reason for non-Error rejections", async () => {
      mockRetrieve.mockRejectedValueOnce("string-error");
      const result = await provider.verifyModel();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).not.toContain("string-error");
        expect(result.reason).toMatch(/could not verify the configured model/i);
      }
    });
  });

  // ─── Branch coverage extras ─────────────────────────────────────────

  describe("toAnthropicMessages", () => {
    it("groups consecutive tool results into a single user block", async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: "end_turn",
        model: "claude-sonnet-4-20250514",
      });
      await provider.completeWithTools(
        {
          systemPrompt: "s",
          messages: [
            { role: "user", content: "u" },
            {
              role: "assistant",
              content: "thinking",
              toolCalls: [
                { id: "t1", name: "n1", input: { x: 1 } },
                { id: "t2", name: "n2", input: { x: 2 } },
              ],
            },
            { role: "tool", content: "r1", toolCallId: "t1", name: "n1" },
            { role: "tool", content: "r2", toolCallId: "t2", name: "n2" },
          ],
        },
        [
          {
            name: "n1",
            description: "",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      );
      const args = mockCreate.mock.calls[0][0];
      const messages = args.messages;
      // Last message is a single user message containing both tool_results
      const last = messages[messages.length - 1];
      expect(last.role).toBe("user");
      expect(Array.isArray(last.content)).toBe(true);
      expect(last.content.length).toBe(2);
    });

    it("appends new user msg when assistant has no toolCalls (else branch)", async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: "end_turn",
        model: "claude-sonnet-4-20250514",
      });
      await provider.completeWithTools(
        {
          systemPrompt: "s",
          messages: [
            { role: "assistant", content: "hi" },
            { role: "tool", content: "r1", toolCallId: "t1", name: "n1" },
          ],
        },
        [
          {
            name: "n1",
            description: "",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      );
      const args = mockCreate.mock.calls[0][0];
      // assistant→string content branch covered
      expect(
        args.messages.find(
          (m: Record<string, unknown>) => m.role === "assistant",
        ).content,
      ).toBe("hi");
    });

    it("emits assistant text block when content present alongside toolCalls", async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: "end_turn",
        model: "claude-sonnet-4-20250514",
      });
      await provider.completeWithTools(
        {
          systemPrompt: "s",
          messages: [
            {
              role: "assistant",
              content: "I will search",
              toolCalls: [{ id: "t1", name: "n1", input: { x: 1 } }],
            },
          ],
        },
        [
          {
            name: "n1",
            description: "",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      );
      const args = mockCreate.mock.calls[0][0];
      const assistant = args.messages.find(
        (m: Record<string, unknown>) => m.role === "assistant",
      );
      expect(Array.isArray(assistant.content)).toBe(true);
      expect(assistant.content[0].type).toBe("text");
    });
  });

  describe("completeWithTools stop_reason mapping", () => {
    it("returns max_tokens stop reason", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "x" }],
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: "max_tokens",
        model: "claude-sonnet-4-20250514",
      });
      const r = await provider.completeWithTools(
        { systemPrompt: "s", messages: [{ role: "user", content: "u" }] },
        [
          {
            name: "n",
            description: "",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      );
      expect(r.stopReason).toBe("max_tokens");
    });

    it("falls back to end_turn for unknown stop reasons", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "x" }],
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: "stop_sequence",
        model: "claude-sonnet-4-20250514",
      });
      const r = await provider.completeWithTools(
        { systemPrompt: "s", messages: [{ role: "user", content: "u" }] },
        [
          {
            name: "n",
            description: "",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      );
      expect(r.stopReason).toBe("end_turn");
    });

    it("uses default maxTokens when not provided", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "x" }],
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: "end_turn",
        model: "claude-sonnet-4-20250514",
      });
      await provider.complete({
        systemPrompt: "s",
        messages: [{ role: "user", content: "u" }],
      });
      expect(mockCreate.mock.calls[0][0].max_tokens).toBe(1024);
    });

    it("propagates temperature when provided", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "x" }],
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: "end_turn",
        model: "claude-sonnet-4-20250514",
      });
      await provider.complete({
        systemPrompt: "s",
        messages: [{ role: "user", content: "u" }],
        temperature: 0.5,
      });
      expect(mockCreate.mock.calls[0][0].temperature).toBe(0.5);
    });

    it("omits temperature for a model that rejects sampling parameters", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "x" }],
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: "end_turn",
        model: "claude-sonnet-5-5",
      });
      await new AnthropicProvider("k", "claude-sonnet-5-5").complete({
        systemPrompt: "s",
        messages: [{ role: "user", content: "u" }],
        temperature: 0.1,
      });
      expect(mockCreate.mock.calls[0][0]).not.toHaveProperty("temperature");
    });
  });

  describe("streamWithTools error paths", () => {
    it("logs and rethrows when stream() throws (Error)", async () => {
      mockStream.mockImplementationOnce(() => {
        throw new Error("boom");
      });
      await expect(
        (async () => {
          const it = provider.streamWithTools(
            {
              systemPrompt: "s",
              messages: [{ role: "user", content: "u" }],
            },
            [
              {
                name: "n",
                description: "",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          );
          for await (const _ of it) void _;
        })(),
      ).rejects.toThrow("boom");
    });

    it("logs and rethrows when stream() throws (non-Error)", async () => {
      mockStream.mockImplementationOnce(() => {
        throw "string boom";
      });
      await expect(
        (async () => {
          const it = provider.streamWithTools(
            {
              systemPrompt: "s",
              messages: [{ role: "user", content: "u" }],
            },
            [
              {
                name: "n",
                description: "",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          );
          for await (const _ of it) void _;
        })(),
      ).rejects.toBe("string boom");
    });

    it("logs and rethrows when iteration throws (non-Error)", async () => {
      mockStream.mockReturnValueOnce({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.reject("iter-err"),
        }),
        finalMessage: jest.fn(),
      });
      await expect(
        (async () => {
          const it = provider.streamWithTools(
            {
              systemPrompt: "s",
              messages: [{ role: "user", content: "u" }],
            },
            [
              {
                name: "n",
                description: "",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          );
          for await (const _ of it) void _;
        })(),
      ).rejects.toBe("iter-err");
    });
  });
});

describe("AnthropicProvider.completeWithWebSearch", () => {
  const request = {
    systemPrompt: "Find contact details.",
    messages: [{ role: "user" as const, content: 'Business name: "Acme"' }],
    temperature: 0,
    maxTokens: 600,
  };

  const searchedResponse = (overrides: Record<string, unknown> = {}) => ({
    content: [
      {
        type: "server_tool_use",
        id: "srvtoolu_1",
        name: "web_search",
        input: { query: "Acme official site" },
      },
      {
        type: "web_search_tool_result",
        tool_use_id: "srvtoolu_1",
        content: [
          {
            type: "web_search_result",
            title: "Acme",
            url: "https://acme.example",
            encrypted_content: "x",
            page_age: null,
          },
        ],
      },
      { type: "text", text: '{"website":"https://acme.example"}' },
    ],
    stop_reason: "end_turn",
    usage: {
      input_tokens: 40,
      output_tokens: 12,
      server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 },
    },
    model: "claude-sonnet-4-6",
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("declares the capability", () => {
    expect(
      new AnthropicProvider("k", "claude-sonnet-4-6").supportsWebSearch,
    ).toBe(true);
  });

  it("sends the 2026 variant with max_uses for a modern model, through the simple message path", async () => {
    mockCreate.mockResolvedValueOnce(searchedResponse());
    const provider = new AnthropicProvider("k", "claude-sonnet-4-6");

    const result = await provider.completeWithWebSearch(request, {
      maxUses: 3,
    });

    const body = mockCreate.mock.calls[0][0];
    expect(body.tools).toEqual([
      { type: "web_search_20260209", name: "web_search", max_uses: 3 },
    ]);
    expect(body.messages).toEqual([
      { role: "user", content: 'Business name: "Acme"' },
    ]);
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(600);
    expect(result).toEqual({
      content: '{"website":"https://acme.example"}',
      usage: { inputTokens: 40, outputTokens: 12 },
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      searched: true,
      searchCount: 1,
    });
  });

  it("sends the 2025 variant for an older model", async () => {
    mockCreate.mockResolvedValueOnce(searchedResponse());
    const provider = new AnthropicProvider("k", "claude-sonnet-4-20250514");

    await provider.completeWithWebSearch(request, { maxUses: 2 });

    expect(mockCreate.mock.calls[0][0].tools[0].type).toBe(
      "web_search_20250305",
    );
  });

  it("retries once with the other variant when the API rejects the tool type", async () => {
    const rejection = Object.assign(
      new Error("tools.0.type: web_search_20260209 is not supported"),
      { status: 400 },
    );
    mockCreate
      .mockRejectedValueOnce(rejection)
      .mockResolvedValueOnce(searchedResponse());
    const provider = new AnthropicProvider("k", "claude-sonnet-4-6");

    const result = await provider.completeWithWebSearch(request, {
      maxUses: 3,
    });

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockCreate.mock.calls[0][0].tools[0].type).toBe(
      "web_search_20260209",
    );
    expect(mockCreate.mock.calls[1][0].tools[0].type).toBe(
      "web_search_20250305",
    );
    expect(result.searched).toBe(true);
  });

  it("rethrows a 400 that is not about the tool type, without retrying", async () => {
    const rejection = Object.assign(new Error("model: not found"), {
      status: 400,
    });
    mockCreate.mockRejectedValueOnce(rejection);
    const provider = new AnthropicProvider("k", "claude-sonnet-4-6");

    await expect(
      provider.completeWithWebSearch(request, { maxUses: 3 }),
    ).rejects.toBe(rejection);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("reports searched=false when the only search result is an error object", async () => {
    mockCreate.mockResolvedValueOnce(
      searchedResponse({
        content: [
          {
            type: "web_search_tool_result",
            tool_use_id: "srvtoolu_1",
            content: {
              type: "web_search_tool_result_error",
              error_code: "max_uses_exceeded",
            },
          },
          { type: "text", text: "{}" },
        ],
      }),
    );
    const provider = new AnthropicProvider("k", "claude-sonnet-4-6");

    const result = await provider.completeWithWebSearch(request, {
      maxUses: 3,
    });

    expect(result.searched).toBe(false);
    expect(result.searchCount).toBe(1);
  });

  it("reports searched=false when no search ran", async () => {
    mockCreate.mockResolvedValueOnce(
      searchedResponse({
        content: [{ type: "text", text: "{}" }],
        usage: { input_tokens: 5, output_tokens: 2, server_tool_use: null },
      }),
    );
    const provider = new AnthropicProvider("k", "claude-sonnet-4-6");

    const result = await provider.completeWithWebSearch(request, {
      maxUses: 3,
    });

    expect(result).toMatchObject({ searched: false, searchCount: 0 });
  });

  it("resumes a pause_turn once, sending the paused content back as the assistant turn", async () => {
    const paused = searchedResponse({
      content: [
        {
          type: "server_tool_use",
          id: "srvtoolu_1",
          name: "web_search",
          input: { query: "Acme" },
        },
      ],
      stop_reason: "pause_turn",
      usage: {
        input_tokens: 10,
        output_tokens: 3,
        server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 },
      },
    });
    mockCreate
      .mockResolvedValueOnce(paused)
      .mockResolvedValueOnce(searchedResponse());
    const provider = new AnthropicProvider("k", "claude-sonnet-4-6");

    const result = await provider.completeWithWebSearch(request, {
      maxUses: 3,
    });

    expect(mockCreate).toHaveBeenCalledTimes(2);
    const second = mockCreate.mock.calls[1][0];
    expect(second.messages).toEqual([
      { role: "user", content: 'Business name: "Acme"' },
      { role: "assistant", content: paused.content },
    ]);
    expect(result.content).toBe('{"website":"https://acme.example"}');
    expect(result.usage).toEqual({ inputTokens: 50, outputTokens: 15 });
    expect(result.searchCount).toBe(2);
  });

  it("stops after one continuation when the server pauses again", async () => {
    const paused = searchedResponse({
      content: [],
      stop_reason: "pause_turn",
      usage: { input_tokens: 1, output_tokens: 1, server_tool_use: null },
    });
    mockCreate.mockResolvedValueOnce(paused).mockResolvedValueOnce(paused);
    const provider = new AnthropicProvider("k", "claude-sonnet-4-6");

    const result = await provider.completeWithWebSearch(request, {
      maxUses: 3,
    });

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ content: "", searched: false });
  });
});
