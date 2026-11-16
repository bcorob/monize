import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEMO_USER_EMAIL, DEMO_USER_PASSWORD } from './demo-credentials';

/**
 * The demo login is asked on both sides of the wire -- the server seeds it,
 * the client pre-fills it -- so one answer. Modelled on
 * `default-currency.contract.test.ts`: a per-file read is correct on its own
 * and wrong against its sibling, which is why the check has to span them.
 */
const frontendRoot = join(__dirname, '..');
const repoRoot = join(__dirname, '..', '..', '..');

/** Every `.ts`/`.tsx` under `src/`, tests and the module itself excluded. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    if (/\.(test|spec)\.tsx?$/.test(entry)) continue;
    if (full.endsWith(join('lib', 'demo-credentials.ts'))) continue;
    out.push(full);
  }
  return out;
}

describe('the demo login', () => {
  it('is spelled once on the client', () => {
    const offenders = sourceFiles(frontendRoot)
      .filter((file) => {
        const source = readFileSync(file, 'utf8');
        return (
          source.includes(DEMO_USER_EMAIL) || source.includes(DEMO_USER_PASSWORD)
        );
      })
      .map((file) => file.slice(frontendRoot.length + 1));
    expect(offenders).toEqual([]);
  });

  it('matches what the server seeds', () => {
    // A form that pre-fills a password the seed no longer sets is a demo
    // nobody can enter, and nothing else compares the two.
    const backend = readFileSync(
      join(repoRoot, 'backend/src/database/demo-credentials.ts'),
      'utf8',
    );
    const email = backend.match(/export const DEMO_USER_EMAIL = "([^"]+)";/);
    const password = backend.match(
      /export const DEMO_USER_PASSWORD = "([^"]+)";/,
    );
    expect(email).not.toBeNull();
    expect(password).not.toBeNull();
    expect(email![1]).toBe(DEMO_USER_EMAIL);
    expect(password![1]).toBe(DEMO_USER_PASSWORD);
  });
});
