import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PUSH_TRANSPORTS } from './push';

/**
 * The push transports are mirrored by hand across the layers (nothing compiles
 * the frontend against the backend). The backend's `PUSH_TRANSPORTS` is what the
 * DTO validates against and what `push-transport.contract.spec.ts` holds equal
 * to the database CHECK; this test closes the chain to the client, so a wire
 * added on the server fails here until the device panel and the matrix have
 * decided how to render it -- rather than arriving as a `transport` value the
 * client's union does not name and its `?? 'webpush'` fallback misreads.
 */
const BACKEND_ENTITY = resolve(
  __dirname,
  '../../../backend/src/push/entities/push-subscription.entity.ts',
);

function parseBackendTransports(): string[] {
  const source = readFileSync(BACKEND_ENTITY, 'utf8');
  const block = source.match(/PUSH_TRANSPORTS\s*=\s*\[([^\]]*)\]\s*as const/);
  if (!block) throw new Error('backend PUSH_TRANSPORTS not found');
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe('push transport contract', () => {
  it('names exactly the transports the backend does, in order', () => {
    expect([...PUSH_TRANSPORTS]).toEqual(parseBackendTransports());
  });

  it('keeps webpush as a member, because an absent transport is read as webpush', () => {
    expect(PUSH_TRANSPORTS).toContain('webpush');
  });
});
