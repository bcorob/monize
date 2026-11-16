#!/usr/bin/env node
// The blocking half of the NPM Audit job: fail the build on a high-severity
// advisory in a runtime dependency, and only on that. The decision it applies
// lives in scripts/lib/npm-audit-gate.mjs, which the self-test drives.
//
// Run: node scripts/npm-audit-gate.mjs [dir ...]   (default: backend frontend)

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { AUDIT_TARGETS, auditAll } from './lib/npm-audit-gate.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

// `--json` is what makes an outage distinguishable from a finding; the audit
// level and the prod-only scope are the gate's actual policy.
function runAudit(cwd) {
  const result = spawnSync(
    'npm',
    ['audit', '--audit-level=high', '--omit=dev', '--json'],
    {
      cwd: join(REPO_ROOT, cwd),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  // A spawn that never ran npm produced no report, which classifies as a
  // no-answer -- the same as an endpoint that did not reply.
  if (result.error) {
    return {
      status: 1,
      stdout: JSON.stringify({ message: String(result.error.message) }),
    };
  }
  return { status: result.status, stdout: result.stdout ?? '' };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const targets = process.argv.slice(2);
const ok = await auditAll(targets.length ? targets : AUDIT_TARGETS, {
  run: runAudit,
  wait: sleep,
});
process.exit(ok ? 0 : 1);
