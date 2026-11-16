// Self-test for scripts/lib/ghcr-version-class.jq -- the predicate that decides
// which GHCR package versions the prune sweep DELETES.
//
// Run: node --test scripts/ghcr-version-class.test.mjs
//
// A wrong answer here is not a failed build, it is a published tag that stops
// resolving for everyone who pulls it. The cases below are therefore weighted
// toward the ways "delete the per-PR images" turns destructive: a version can
// carry more than one tag, so `pr-1290` and `beta` on one digest is ONE version
// and pruning it for the first tag unpublishes the second.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const LIB = join(dirname(fileURLToPath(import.meta.url)), 'lib');

/** Run the real classifier over one version object, exactly as the script does. */
function classify(version) {
  return execFileSync(
    'jq',
    ['-L', LIB, '-r', 'include "ghcr-version-class"; version_class'],
    { input: JSON.stringify(version), encoding: 'utf8' },
  ).trim();
}

const tagged = (...tags) => ({ metadata: { container: { tags } } });

test('a version with no tags is untagged', () => {
  assert.equal(classify(tagged()), 'untagged');
  // The API omits the key entirely for some versions; `// []` must cover it.
  assert.equal(classify({ metadata: { container: {} } }), 'untagged');
  assert.equal(classify({ metadata: {} }), 'untagged');
  assert.equal(classify({}), 'untagged');
});

test('a version whose every tag is a per-PR tag is prunable', () => {
  assert.equal(classify(tagged('pr-1290')), 'per-pr');
  assert.equal(classify(tagged('pr-731')), 'per-pr');
  // Two PRs resolving to one digest is unlikely but not impossible.
  assert.equal(classify(tagged('pr-1290', 'pr-1291')), 'per-pr');
});

test('a live tag is kept', () => {
  assert.equal(classify(tagged('latest')), 'keep');
  assert.equal(classify(tagged('beta')), 'keep');
  assert.equal(classify(tagged('1.15.1')), 'keep');
  assert.equal(classify(tagged('latest', '1.15.1')), 'keep');
});

test('a per-PR tag never drags a live tag down with it', () => {
  // The whole reason the predicate is "all" and not "any". Each of these is a
  // single version, and pruning it would unpublish the live tag beside it.
  assert.equal(classify(tagged('pr-1290', 'beta')), 'keep');
  assert.equal(classify(tagged('beta', 'pr-1290')), 'keep');
  assert.equal(classify(tagged('pr-1290', 'latest', '1.15.1')), 'keep');
});

test('the per-PR pattern is anchored and numeric', () => {
  // A tag that merely starts with or contains "pr-" is not a per-PR image.
  for (const tag of ['pr-abc', 'pr-', 'pr', 'preview', 'xpr-1', 'pr-1290-rc1', 'PR-1290']) {
    assert.equal(classify(tagged(tag)), 'keep', `${tag} must be kept`);
  }
});
