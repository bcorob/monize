import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A published image upgrades its base OS packages, because the base tag's
 * rebuild cadence is not the security cadence.
 *
 * `node:24-alpine` is rebuilt when Node releases, so between rebuilds it ships
 * whatever Alpine packages were current when the tag was cut. Every open Trivy
 * alert on this repository was that lag and nothing else: ten OpenSSL CVEs in
 * libcrypto3/libssl3, each reported twice per image, none of them in code we
 * wrote and none in an npm dependency. Nothing in the repository failed, so
 * the only signal was the Security tab, which no gate reads -- the scan
 * uploads SARIF and fails the build on CRITICAL only.
 *
 * Refreshing the packages at build time takes the fix from the same Alpine
 * branch the base image already pins, so it clears the class rather than
 * today's ten CVEs, and it recurs correctly: the next advisory is fixed by the
 * next build instead of by waiting on an upstream rebuild. `ignore-unfixed:
 * true` on the scan is what makes that claim checkable -- an alert surviving
 * the upgrade is one Alpine has published no fix for.
 *
 * Only the `production` stage is scanned. `development` is never published,
 * and the `node:24-slim` builder/deps stages contribute no layers to the final
 * image, so an upgrade there would cost build time and change nothing.
 */
const REPO_ROOT = join(__dirname, '..', '..', '..');

const PUBLISHED_DOCKERFILES = ['backend/Dockerfile', 'frontend/Dockerfile'];

/** The stage `docker build --target production` selects. */
const PUBLISHED_STAGE = 'production';

const APK_UPGRADE = /\bapk\s+upgrade\b/;
const APK_ADD = /\bapk\s+add\b/;

/**
 * Blank out `#` comments, keeping line numbering, so the scan reads
 * INSTRUCTIONS.
 *
 * The rule is about what the image build does, and a comment explaining the
 * rule is free to name the command it is explaining -- a `# do not remove the
 * apk upgrade below` is the obvious one. A raw-text scan is then satisfied by
 * the explanation alone, and goes on passing after someone deletes the
 * instruction the explanation describes. This repository has already paid for
 * the mirror of that once (prose tripping a ban, in `loan-history.guard.test`);
 * this direction is worse, because a guard that cannot fail reports nothing
 * rather than reporting the wrong thing.
 *
 * Deliberately crude -- a `#` inside a quoted string in a RUN would be blanked
 * too. That direction is safe: it can only hide an instruction from the scan,
 * and the negative controls below fail if the scan stops seeing a real one.
 */
function withoutComments(dockerfile: string): string {
  return dockerfile
    .split('\n')
    .map((line) => (line.trimStart().startsWith('#') ? ' '.repeat(line.length) : line))
    .join('\n');
}

/**
 * The instruction lines of one build stage, with `\` continuations folded into
 * the line that opened them -- a RUN's later commands are part of that RUN, not
 * separate instructions, and the ordering assertion below compares commands
 * within one.
 */
function stageInstructions(dockerfile: string, stage: string): string[] {
  const lines = withoutComments(dockerfile).split('\n');
  const instructions: string[] = [];
  let inStage = false;

  for (const line of lines) {
    const from = /^\s*FROM\s+\S+\s+AS\s+(\S+)/i.exec(line);
    if (from) {
      inStage = from[1] === stage;
      continue;
    }
    if (!inStage || line.trim().length === 0) continue;

    const continuing = instructions.length > 0 && instructions[instructions.length - 1].endsWith('\\');
    instructions[continuing ? instructions.length - 1 : instructions.length] = continuing
      ? `${instructions[instructions.length - 1].slice(0, -1)} ${line.trim()}`
      : line.trim();
  }

  return instructions;
}

describe('a published image refreshes its base OS packages', () => {
  it('strips comments but still sees instructions', () => {
    // The stripper is load-bearing in both directions, so it is tested in both.
    const stripped = withoutComments(
      ['# RUN apk upgrade --no-cache', '    # apk upgrade', 'RUN apk upgrade --no-cache'].join('\n'),
    ).split('\n');

    expect(APK_UPGRADE.test(stripped[0])).toBe(false);
    expect(APK_UPGRADE.test(stripped[1])).toBe(false);
    expect(APK_UPGRADE.test(stripped[2])).toBe(true);
    // Line numbering must survive, or an offender report points at the wrong line.
    expect(stripped).toHaveLength(3);
  });

  it('reads the production stage and not the stages around it', () => {
    // Negative control for the parser: an instruction in another stage must not
    // count, or a builder-stage upgrade would satisfy a rule about the image.
    const synthetic = [
      'FROM node:24-alpine AS development',
      'RUN apk upgrade --no-cache',
      'FROM node:24-alpine AS production',
      'RUN apk add --no-cache dumb-init',
      'USER nobody',
    ].join('\n');

    expect(stageInstructions(synthetic, PUBLISHED_STAGE)).toEqual([
      'RUN apk add --no-cache dumb-init',
      'USER nobody',
    ]);
    expect(stageInstructions(synthetic, PUBLISHED_STAGE).some((i) => APK_UPGRADE.test(i))).toBe(false);
  });

  it('folds a continuation into the instruction that opened it', () => {
    const synthetic = ['FROM node:24-alpine AS production', 'RUN apk upgrade --no-cache && \\', '    apk add --no-cache dumb-init'].join('\n');

    expect(stageInstructions(synthetic, PUBLISHED_STAGE)).toEqual([
      'RUN apk upgrade --no-cache &&  apk add --no-cache dumb-init',
    ]);
  });

  it.each(PUBLISHED_DOCKERFILES)('%s upgrades OS packages in its production stage', (file) => {
    const instructions = stageInstructions(readFileSync(join(REPO_ROOT, file), 'utf8'), PUBLISHED_STAGE);

    // Sanity: an empty stage would make every assertion below vacuously true.
    expect(instructions.length).toBeGreaterThan(0);

    expect(
      instructions.some((instruction) => APK_UPGRADE.test(instruction)),
      `${file}: the ${PUBLISHED_STAGE} stage runs no "apk upgrade", so the image ships whatever ` +
        'libcrypto3/libssl3 the base tag was built with. Add it to the stage\'s existing RUN.',
    ).toBe(true);
  });

  it.each(PUBLISHED_DOCKERFILES)('%s upgrades before it installs', (file) => {
    const instructions = stageInstructions(readFileSync(join(REPO_ROOT, file), 'utf8'), PUBLISHED_STAGE);

    const upgradeAt = instructions.findIndex((instruction) => APK_UPGRADE.test(instruction));
    const addAt = instructions.findIndex((instruction) => APK_ADD.test(instruction));
    if (addAt === -1) return; // A stage that installs nothing has nothing to order.

    // Within one folded RUN, compare the commands rather than the instructions.
    const [first] = [upgradeAt, addAt].sort((a, b) => a - b);
    const order =
      upgradeAt === addAt
        ? instructions[first].search(APK_UPGRADE) < instructions[first].search(APK_ADD)
        : upgradeAt < addAt;

    expect(
      order,
      `${file}: "apk add" runs before "apk upgrade", so the installed package is resolved ` +
        'against the stale index the upgrade is about to replace.',
    ).toBe(true);
  });
});
