import {
  anthropicModelAcceptsTemperature,
  anthropicTemperatureField,
} from "./anthropic-sampling.util";

describe("anthropicModelAcceptsTemperature", () => {
  it.each([
    "claude-sonnet-4-20250514",
    "claude-opus-4-1",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
    "claude-3-5-haiku-latest",
  ])("accepts temperature on %s", (model) => {
    expect(anthropicModelAcceptsTemperature(model)).toBe(true);
  });

  it.each([
    "claude-opus-4-7",
    "claude-opus-4-8",
    "claude-opus-5",
    "claude-opus-5-5",
    "claude-sonnet-5",
    "claude-sonnet-5-5",
    "claude-haiku-5-5",
    "claude-fable-5-1",
    "claude-sonnet-5-5-20261001",
  ])("rejects temperature on %s", (model) => {
    expect(anthropicModelAcceptsTemperature(model)).toBe(false);
  });
});

describe("anthropicTemperatureField", () => {
  it("carries the temperature for a model that accepts it", () => {
    expect(anthropicTemperatureField("claude-sonnet-4-6", 0.1)).toEqual({
      temperature: 0.1,
    });
  });

  it("keeps a zero temperature", () => {
    expect(anthropicTemperatureField("claude-sonnet-4-6", 0)).toEqual({
      temperature: 0,
    });
  });

  it("omits the field for a model that rejects sampling parameters", () => {
    expect(anthropicTemperatureField("claude-sonnet-5-5", 0.1)).toEqual({});
  });

  it("omits the field when no temperature was requested", () => {
    expect(anthropicTemperatureField("claude-sonnet-4-6", undefined)).toEqual(
      {},
    );
  });
});
