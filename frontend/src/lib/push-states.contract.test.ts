import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import enSettings from '@/i18n/messages/en/settings.json';

/**
 * Three lists say the same thing about a push device, in three places that
 * cannot see each other: the backend enum a response carries, the union this
 * layer declares, and the catalog keys the panel renders.
 *
 * Drift is silent in the direction that matters. A reason the server starts
 * sending and the union does not know is a `t()` on a key that does not exist,
 * which renders an error where the repair instruction should be -- on the one
 * row whose whole job is to say why a device stopped working. This is the same
 * shape as `default-currency.contract.test.ts`: a list that means something is
 * checked where it can be checked, rather than written out three times and
 * hoped over.
 */

const repoRoot = resolve(__dirname, '../../..');

function backendUnion(file: string, name: string): string[] {
  const source = readFileSync(resolve(repoRoot, file), 'utf8');
  const body = new RegExp(`export enum ${name} \\{([\\s\\S]*?)\\n\\}`).exec(
    source,
  );
  if (!body) throw new Error(`enum ${name} not found in ${file}`);
  return [...body[1].matchAll(/^\s*([A-Z_]+)\s*=/gm)].map((m) => m[1]).sort();
}

function frontendUnion(file: string, name: string): string[] {
  const source = readFileSync(resolve(repoRoot, file), 'utf8');
  const body = new RegExp(`export type ${name} =([\\s\\S]*?);`).exec(source);
  if (!body) throw new Error(`type ${name} not found in ${file}`);
  return [...body[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
}

describe('push device states are one list, checked where it can be checked', () => {
  const disabledReasons = backendUnion(
    'backend/src/push/entities/push-subscription.entity.ts',
    'PushDisabledReason',
  );

  it('finds the backend enum, so the check cannot pass over an empty set', () => {
    expect(disabledReasons.length).toBeGreaterThan(1);
  });

  it('declares the same disabled reasons on both sides of the API', () => {
    expect(
      frontendUnion('frontend/src/lib/push.ts', 'PushDisabledReason'),
    ).toEqual(disabledReasons);
  });

  // Every reason needs its own copy: the three differ by the repair they ask
  // for, and a shared message would send the reader to the wrong one.
  it('has a settings message for every disabled reason, and no orphan', () => {
    expect(
      Object.keys(enSettings.notifications.push.disabledReason).sort(),
    ).toEqual(disabledReasons);
  });

  // The client answers this one code by unsubscribing and re-subscribing, and
  // must not answer any other 409 that way. A drifted literal would silently
  // turn the recovery off (or, worse, on for the wrong refusal).
  it('agrees with the server on the claimed-endpoint code', () => {
    const backend = /ENDPOINT_CLAIMED_CODE = "([^"]+)"/.exec(
      readFileSync(
        resolve(repoRoot, 'backend/src/push/push-subscription.service.ts'),
        'utf8',
      ),
    )?.[1];
    const frontend = /ENDPOINT_CLAIMED_CODE = '([^']+)'/.exec(
      readFileSync(resolve(repoRoot, 'frontend/src/lib/push.ts'), 'utf8'),
    )?.[1];

    expect(backend).toBeTruthy();
    expect(frontend).toBe(backend);
  });

  it('declares the same send outcomes on both sides of the API', () => {
    const backend = [
      ...readFileSync(
        resolve(repoRoot, 'backend/src/push/web-push-sender.service.ts'),
        'utf8',
      ).matchAll(/\{ status: "([a-z]+)"/g),
    ]
      .map((m) => m[1])
      .filter((value, index, all) => all.indexOf(value) === index)
      .sort();

    expect(backend.length).toBeGreaterThan(1);
    expect(frontendUnion('frontend/src/lib/push.ts', 'PushTestStatus')).toEqual(
      backend,
    );
  });
});

/**
 * The fingerprint's width is the third thing both layers must agree on, and it
 * was mirrored by a comment alone.
 *
 * Drift here is silent AND destructive. The server truncates the endpoint digest
 * to this many characters for the device list; the browser computes its own
 * digest and truncates it the same way to recognise which row is itself. Shorten
 * the backend's copy and `liveFingerprints` never contains `currentFingerprint`,
 * so `classifyPushRegistration` answers `revoked` for a perfectly healthy
 * registration and the settings panel unsubscribes the browser of every user who
 * opens the page -- with both suites green, because each asserts against its own
 * constant.
 */
describe('the endpoint fingerprint has one width', () => {
  function declaredNumber(file: string, name: string): number {
    const source = readFileSync(resolve(repoRoot, file), 'utf8');
    const match = new RegExp(
      `export const ${name}\\s*(?::\\s*number\\s*)?=\\s*([\\d_]+)`,
    ).exec(source);
    if (!match) throw new Error(`${name} not found in ${file}`);
    return Number(match[1].replace(/_/g, ''));
  }

  it('is the same number on both sides of the wire', () => {
    const backend = declaredNumber(
      'backend/src/push/push-subscription.service.ts',
      'ENDPOINT_FINGERPRINT_LENGTH',
    );
    const frontend = declaredNumber(
      'frontend/src/lib/push.ts',
      'ENDPOINT_FINGERPRINT_LENGTH',
    );

    expect(frontend).toBe(backend);
  });

  it('is wide enough to identify a device and narrower than the digest', () => {
    const width = declaredNumber(
      'frontend/src/lib/push.ts',
      'ENDPOINT_FINGERPRINT_LENGTH',
    );
    // A SHA-256 hex digest is 64 characters; a prefix is published so the
    // endpoint itself -- a delivery credential -- never leaves the server.
    expect(width).toBeGreaterThanOrEqual(8);
    expect(width).toBeLessThan(64);
  });
});
