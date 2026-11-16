// Self-test for scripts/lib/npm-audit-gate.mjs -- the decision that separates
// "you shipped a vulnerability" from "npmjs is down".
//
// Run: node --test scripts/npm-audit-gate.test.mjs
//
// The cases below are weighted toward the two ways this gate can be worse than
// useless: retrying (and so possibly swallowing) a real advisory, or reading an
// unanswered endpoint as a clean audit. Both would be a green check over
// dependencies nobody audited.
//
// The payloads are not invented. CLEAN_REPORT and ENDPOINT_FAILURE are the
// literal shapes `npm audit --json` emitted on this repository: a clean run in
// backend/, and a run pointed at a dead registry. The observed CI failures
// carried the same no-metadata shape behind `npm error audit endpoint returned
// an error`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ATTEMPTS,
  auditAll,
  auditDirectory,
  backoffMs,
  classifyAuditResult,
  formatCounts,
} from './lib/npm-audit-gate.mjs';

const CLEAN_REPORT = {
  auditReportVersion: 2,
  vulnerabilities: {},
  metadata: {
    vulnerabilities: {
      info: 0,
      low: 0,
      moderate: 0,
      high: 0,
      critical: 0,
      total: 0,
    },
    dependencies: {
      prod: 396,
      dev: 532,
      optional: 31,
      peer: 1,
      peerOptional: 0,
      total: 930,
    },
  },
};

// npm audit --json --registry=http://127.0.0.1:9, verbatim.
const ENDPOINT_FAILURE = {
  message:
    'request to http://127.0.0.1:9/-/npm/v1/security/audits/quick failed, reason: connect ECONNREFUSED 127.0.0.1:9',
  error: { summary: '', detail: '' },
};

const ADVISORY_REPORT = {
  auditReportVersion: 2,
  vulnerabilities: {
    'some-package': {
      name: 'some-package',
      severity: 'high',
      via: [
        { title: 'Prototype pollution', url: 'https://example.test/advisory' },
      ],
    },
  },
  metadata: {
    vulnerabilities: {
      info: 0,
      low: 0,
      moderate: 0,
      high: 1,
      critical: 0,
      total: 1,
    },
    dependencies: {
      prod: 396,
      dev: 0,
      optional: 0,
      peer: 0,
      peerOptional: 0,
      total: 396,
    },
  },
};

const said = (status, body) => ({
  status,
  stdout: typeof body === 'string' ? body : JSON.stringify(body),
});

/** A runner that replays a scripted sequence, and records how often it ran. */
function scriptedRunner(...results) {
  const calls = [];
  const run = (cwd) => {
    calls.push(cwd);
    return results[Math.min(calls.length - 1, results.length - 1)];
  };
  return { run, calls };
}

/** Collects log lines instead of printing them. */
function recorder() {
  const lines = [];
  return {
    log: (line) => lines.push(line),
    lines,
    text: () => lines.join('\n'),
  };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

test('a report with no findings and exit 0 is clean', () => {
  const outcome = classifyAuditResult(said(0, CLEAN_REPORT));
  assert.equal(outcome.kind, 'clean');
  assert.equal(outcome.counts.total, 0);
});

test('a report with findings and exit 1 is advisories, not an outage', () => {
  const outcome = classifyAuditResult(said(1, ADVISORY_REPORT));
  assert.equal(outcome.kind, 'advisories');
  assert.equal(outcome.counts.high, 1);
});

test('an endpoint failure is a no-answer, and names the cause', () => {
  const outcome = classifyAuditResult(said(1, ENDPOINT_FAILURE));
  assert.equal(outcome.kind, 'no-answer');
  assert.match(outcome.reason, /ECONNREFUSED/);
});

// The discriminator is the report's presence, not the error's. An npm release
// that renames `error` must not thereby turn an outage into a clean audit.
test('an unrecognised failure shape is a no-answer, never clean', () => {
  const outcome = classifyAuditResult(
    said(1, { somethingNew: 'npmjs is down' }),
  );
  assert.equal(outcome.kind, 'no-answer');
});

test('non-JSON output is a no-answer, never clean', () => {
  const outcome = classifyAuditResult(
    said(1, 'npm error audit endpoint returned an error'),
  );
  assert.equal(outcome.kind, 'no-answer');
  assert.match(outcome.reason, /not JSON/);
});

test('empty output is a no-answer, never clean', () => {
  assert.equal(classifyAuditResult(said(1, '')).kind, 'no-answer');
});

// Exit 0 with no report would be the worst possible pass: nothing was audited.
test('exit 0 with no report is still a no-answer', () => {
  assert.equal(
    classifyAuditResult(said(0, ENDPOINT_FAILURE)).kind,
    'no-answer',
  );
});

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

test('a clean audit passes on the first attempt, with no retry', async () => {
  const { run, calls } = scriptedRunner(said(0, CLEAN_REPORT));
  const log = recorder();
  assert.equal(await auditDirectory('backend', { run, log: log.log }), true);
  assert.equal(calls.length, 1);
});

// The property this whole gate exists for: a finding fails NOW. A retry could
// see a later attempt fail to reach the endpoint and report an outage instead.
test('an advisory fails immediately and is never retried', async () => {
  const { run, calls } = scriptedRunner(said(1, ADVISORY_REPORT));
  const log = recorder();
  assert.equal(await auditDirectory('backend', { run, log: log.log }), false);
  assert.equal(calls.length, 1);
  assert.match(log.text(), /::error::backend: high-severity advisories/);
  // The names, not just the count -- the reader has to know what to fix.
  assert.match(log.text(), /some-package/);
});

test('a no-answer is retried, and a later answer decides', async () => {
  const { run, calls } = scriptedRunner(
    said(1, ENDPOINT_FAILURE),
    said(0, CLEAN_REPORT),
  );
  const log = recorder();
  assert.equal(await auditDirectory('backend', { run, log: log.log }), true);
  assert.equal(calls.length, 2);
  assert.match(
    log.text(),
    /::warning::backend: npm advisories endpoint did not answer \(attempt 1\/3\)/,
  );
});

test('an advisory found after a no-answer still fails', async () => {
  const { run, calls } = scriptedRunner(
    said(1, ENDPOINT_FAILURE),
    said(1, ADVISORY_REPORT),
  );
  assert.equal(
    await auditDirectory('backend', { run, log: recorder().log }),
    false,
  );
  assert.equal(calls.length, 2);
});

// An outage that outlasts the retries is NOT a pass: "we could not verify" is
// not "verified clean". It fails, and it says which endpoint and how often.
test('a persistent no-answer fails after the attempt budget, saying so', async () => {
  const { run, calls } = scriptedRunner(said(1, ENDPOINT_FAILURE));
  const log = recorder();
  assert.equal(await auditDirectory('backend', { run, log: log.log }), false);
  assert.equal(calls.length, MAX_ATTEMPTS);
  assert.match(log.text(), /were NOT audited/);
  assert.match(log.text(), /ECONNREFUSED/);
});

test('the backoff grows and is never zero', () => {
  assert.ok(backoffMs(1) > 0);
  assert.ok(backoffMs(2) > backoffMs(1));
});

// ---------------------------------------------------------------------------
// Every target is audited
// ---------------------------------------------------------------------------

test('a failure in one directory does not skip the next', async () => {
  const calls = [];
  const run = (cwd) => {
    calls.push(cwd);
    return cwd === 'backend' ? said(1, ADVISORY_REPORT) : said(0, CLEAN_REPORT);
  };
  const ok = await auditAll(['backend', 'frontend'], {
    run,
    log: recorder().log,
  });
  assert.equal(ok, false);
  assert.deepEqual(calls, ['backend', 'frontend']);
});

test('both directories clean passes', async () => {
  const run = () => said(0, CLEAN_REPORT);
  assert.equal(
    await auditAll(['backend', 'frontend'], { run, log: recorder().log }),
    true,
  );
});

test('formatCounts lists every severity', () => {
  assert.equal(formatCounts({ high: 1, critical: 0 }), 'high: 1, critical: 0');
});
