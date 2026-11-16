import {
  anthropicWebSearchTool,
  isUnsupportedWebSearchVariantError,
  otherAnthropicWebSearchVariant,
  preferredAnthropicWebSearchVariant,
  serverToolsField,
} from "./web-search-tool.util";

describe("preferredAnthropicWebSearchVariant", () => {
  it.each([
    ["claude-opus-4-6", "web_search_20260209"],
    ["claude-sonnet-4-6", "web_search_20260209"],
    ["claude-opus-4-7", "web_search_20260209"],
    ["claude-opus-4-8", "web_search_20260209"],
    ["claude-opus-4-10", "web_search_20260209"],
    ["claude-sonnet-5", "web_search_20260209"],
    ["claude-opus-5", "web_search_20260209"],
    ["claude-fable-5-1", "web_search_20260209"],
    ["claude-sonnet-4-6-20260301", "web_search_20260209"],
    ["claude-sonnet-4-5", "web_search_20250305"],
    ["claude-sonnet-4-20250514", "web_search_20250305"],
    ["claude-haiku-4-5", "web_search_20250305"],
    ["claude-opus-4-1-20250805", "web_search_20250305"],
    ["claude-3-7-sonnet-latest", "web_search_20250305"],
    ["claude-3-5-haiku-20241022", "web_search_20250305"],
  ])("%s -> %s", (model, variant) => {
    expect(preferredAnthropicWebSearchVariant(model)).toBe(variant);
  });

  it("does not read a dated snapshot suffix as a version", () => {
    // 4-5 snapshot dated 2026 is still a 4.5 model.
    expect(
      preferredAnthropicWebSearchVariant("claude-sonnet-4-5-20260101"),
    ).toBe("web_search_20250305");
  });
});

describe("otherAnthropicWebSearchVariant", () => {
  it("swaps the two variants", () => {
    expect(otherAnthropicWebSearchVariant("web_search_20260209")).toBe(
      "web_search_20250305",
    );
    expect(otherAnthropicWebSearchVariant("web_search_20250305")).toBe(
      "web_search_20260209",
    );
  });
});

describe("anthropicWebSearchTool", () => {
  it("carries the variant, the name and the use cap", () => {
    expect(
      anthropicWebSearchTool("web_search_20250305", { maxUses: 3 }),
    ).toEqual({ type: "web_search_20250305", name: "web_search", max_uses: 3 });
  });

  it("adds allowed_domains only when given", () => {
    expect(
      anthropicWebSearchTool("web_search_20260209", {
        maxUses: 1,
        allowedDomains: ["example.com"],
      }),
    ).toEqual({
      type: "web_search_20260209",
      name: "web_search",
      max_uses: 1,
      allowed_domains: ["example.com"],
    });
    expect(
      anthropicWebSearchTool("web_search_20260209", {
        maxUses: 1,
        allowedDomains: [],
      }),
    ).not.toHaveProperty("allowed_domains");
  });
});

describe("isUnsupportedWebSearchVariantError", () => {
  const apiError = (status: number, message: string) =>
    Object.assign(new Error(message), { status });

  it("recognises a 400 that names a variant", () => {
    expect(
      isUnsupportedWebSearchVariantError(
        apiError(400, "tools.0.type: web_search_20260209 is not supported"),
      ),
    ).toBe(true);
  });

  it("ignores a 400 about something else", () => {
    expect(
      isUnsupportedWebSearchVariantError(apiError(400, "model: not found")),
    ).toBe(false);
  });

  it("ignores a non-400 that names a variant", () => {
    expect(
      isUnsupportedWebSearchVariantError(
        apiError(429, "web_search_20250305 rate limited"),
      ),
    ).toBe(false);
    expect(
      isUnsupportedWebSearchVariantError(new Error("web_search_20250305")),
    ).toBe(false);
  });
});

describe("serverToolsField", () => {
  it("wraps the one server tool in a tools array", () => {
    expect(serverToolsField({ type: "x" })).toEqual({ tools: [{ type: "x" }] });
  });
});
