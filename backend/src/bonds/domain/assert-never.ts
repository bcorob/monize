/**
 * Closes an exhaustive switch over a primitive's `type`: adding a union member
 * without an engine case fails to compile here.
 */
/* istanbul ignore next -- unreachable by construction; the type checker is the test */
export function assertNever(value: never): never {
  throw new RangeError(`Unhandled primitive: ${JSON.stringify(value)}`);
}
