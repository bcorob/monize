/**
 * Opus 4.7+, Sonnet 5+, Haiku 5+ and the Fable family reject sampling
 * parameters: a request carrying a non-default `temperature` fails with
 * 400 "`temperature` is deprecated for this model". Older models (Opus/Sonnet
 * 4.6, Haiku 4.5, `claude-sonnet-4-20250514`, Claude 3.x) still honour it.
 *
 * Callers pass a temperature regardless of provider, so the Anthropic provider
 * drops it for the model ids matched here. Dated snapshot suffixes and
 * `-latest` aliases are tolerated because the match is on family and version.
 */
const NO_SAMPLING_MODEL_PATTERNS: readonly RegExp[] = [
  /^claude-opus-4-(?:[7-9]|[1-9]\d)(?:-|$)/,
  /^claude-[a-z]+-(?:[5-9]|\d\d)(?:-|$)/,
];

export function anthropicModelAcceptsTemperature(modelId: string): boolean {
  return !NO_SAMPLING_MODEL_PATTERNS.some((pattern) => pattern.test(modelId));
}

/**
 * The `temperature` field for an Anthropic request: present only when the
 * caller set one and the model accepts it. A spread helper so provider
 * sources keep the field out of their own literals.
 */
export function anthropicTemperatureField(
  modelId: string,
  temperature: number | undefined,
): { temperature?: number } {
  return temperature !== undefined && anthropicModelAcceptsTemperature(modelId)
    ? { temperature }
    : {};
}
