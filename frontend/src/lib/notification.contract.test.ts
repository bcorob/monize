import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SYSTEM_NOTIFICATION_TYPES } from '@/types/notification';
import { notificationFilterCategory } from './notification-filters';

/**
 * The frontend's notification read model, held against the backend entity it
 * mirrors.
 *
 * Two claims, and the codebase has broken both:
 *
 *   * **The field names.** The backend property is `type`, mapped to the
 *     `alert_type` column. The mirror declared `alertType` for one commit, which
 *     type-checked cleanly and read `undefined` for every row -- every
 *     notification rendered with no type, so the bell composed no copy and
 *     routed nowhere. Nothing compiles the two layers against each other, so
 *     this reads the entity and compares the names.
 *   * **The system half of the type partition.** The dismiss-matching endpoint
 *     restricts its UPDATE on the backend's `SYSTEM_NOTIFICATION_TYPES`, and the
 *     panel's category filter (plus the local removal after a delete-all) reads
 *     the frontend mirror. Drift means delete-all removes rows the user's filter
 *     never showed -- or leaves rows it did.
 */
const BACKEND_ENTITY = resolve(
  __dirname,
  '../../../backend/src/notification-center/entities/notification.entity.ts',
);

function parseBackendSystemAlertTypes(): string[] {
  const source = readFileSync(BACKEND_ENTITY, 'utf8');
  const block = source.match(
    /export const SYSTEM_NOTIFICATION_TYPES[^=]*=\s*\[([\s\S]*?)\];/,
  );
  if (!block) {
    throw new Error(
      'SYSTEM_NOTIFICATION_TYPES not found in the backend entity -- this guard has lost its subject',
    );
  }
  return [...block[1].matchAll(/NotificationType\.([A-Z_]+)/g)].map(
    (m) => m[1],
  );
}

describe('the system half of the type partition', () => {
  const backend = parseBackendSystemAlertTypes();

  it('parses the backend set it is checked against', () => {
    expect(backend.length).toBeGreaterThan(0);
  });

  it('mirrors the backend set exactly', () => {
    expect([...SYSTEM_NOTIFICATION_TYPES].sort()).toEqual([...backend].sort());
  });

  it('classifies every backend NotificationType, so a new type cannot fall between the layers', () => {
    const source = readFileSync(BACKEND_ENTITY, 'utf8');
    const enumBlock = source.match(
      /export enum NotificationType \{([\s\S]*?)\n\}/,
    );
    expect(enumBlock).toBeTruthy();
    const allTypes = [...enumBlock![1].matchAll(/^\s*([A-Z_]+)\s*=/gm)].map(
      (m) => m[1],
    );
    expect(allTypes.length).toBeGreaterThan(0);
    for (const type of allTypes) {
      // Membership decides the category; both answers must be reachable.
      expect(['system', 'financial']).toContain(
        notificationFilterCategory(type as (typeof SYSTEM_NOTIFICATION_TYPES)[number]),
      );
    }
    // And the frontend set names nothing the backend enum does not have.
    for (const type of SYSTEM_NOTIFICATION_TYPES) {
      expect(allTypes).toContain(type);
    }
  });
});

/**
 * The properties the entity persists, in declaration order -- which is what the
 * API serializes, since the controller returns the row.
 *
 * Relations (`@ManyToOne` + `@JoinColumn`) are deliberately not collected: they
 * are hydrated objects, not fields the read model mirrors.
 */
function parseBackendColumns(): string[] {
  const source = readFileSync(BACKEND_ENTITY, 'utf8');
  const classBody = source.match(
    /@Entity\("notifications"\)\s*export class Notification \{([\s\S]*)\n\}/,
  );
  if (!classBody) {
    throw new Error(
      'the Notification entity class was not found -- this guard has lost its subject',
    );
  }
  const decorator =
    /@(?:Column|PrimaryGeneratedColumn|CreateDateColumn|UpdateDateColumn)\(/g;
  const declared = [...classBody[1].matchAll(decorator)].length;
  const parsed = [
    ...classBody[1].matchAll(
      /@(?:Column|PrimaryGeneratedColumn|CreateDateColumn|UpdateDateColumn)\([\s\S]*?\)\s*(\w+)[?!]?\s*:/g,
    ),
  ].map((m) => m[1]);
  // The lazy `)` stops at the decorator's own closing paren, which holds only
  // while no decorator argument contains one. `@Column({ transformer: f() })`
  // would silently drop that property from the list and quietly narrow every
  // comparison below, so the count is checked rather than trusted.
  if (parsed.length !== declared) {
    throw new Error(
      `parsed ${parsed.length} of ${declared} column decorators -- a decorator ` +
        'argument now contains a parenthesis and the parser needs widening, ' +
        'not a smaller expectation',
    );
  }
  return parsed;
}

/** The field names the frontend read model declares. */
function parseFrontendFields(): string[] {
  const source = readFileSync(
    resolve(__dirname, '../types/notification.ts'),
    'utf8',
  );
  const block = source.match(/export interface Notification \{([\s\S]*?)\n\}/);
  if (!block) {
    throw new Error(
      'the Notification interface was not found -- this guard has lost its subject',
    );
  }
  // Comments blanked first: a `/** ... */` above a field can hold a colon, and
  // prose naming a field must not be read as declaring one.
  const body = block[1]
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  return [...body.matchAll(/^\s*(\w+)\??\s*:/gm)].map((m) => m[1]);
}

/**
 * Fields one side has on purpose. Each needs a reason that is not "we forgot",
 * because that is exactly what this guard exists to catch.
 */
const BACKEND_ONLY: Readonly<Record<string, string>> = {
  dismissedAt:
    'the list endpoint returns only live rows, so it is always null on the wire',
};

const FRONTEND_ONLY: Readonly<Record<string, string>> = {
  category:
    'derived from the type by the read model -- there is deliberately no column',
};

describe('the frontend read model mirrors the entity field for field', () => {
  const backend = parseBackendColumns();
  const frontend = parseFrontendFields();

  it('parses both sides, so the comparison is not vacuous', () => {
    // A regex that stops matching would otherwise make every assertion below
    // trivially true.
    expect(backend).toContain('type');
    expect(backend).toContain('periodStart');
    expect(backend.length).toBeGreaterThan(10);
    expect(frontend).toContain('type');
    expect(frontend.length).toBeGreaterThan(10);
  });

  it('declares every persisted field the API sends', () => {
    const missing = backend
      .filter((field) => !frontend.includes(field))
      .filter((field) => !(field in BACKEND_ONLY));
    expect(missing).toEqual([]);
  });

  it('names no field the entity does not have', () => {
    const extra = frontend
      .filter((field) => !backend.includes(field))
      .filter((field) => !(field in FRONTEND_ONLY));
    expect(extra).toEqual([]);
  });

  it('keeps every exemption real, on the side that claims it', () => {
    // An exemption for a field that has since appeared on both sides is a
    // permission nobody needs, and it hides the next mismatch in that name.
    for (const [field, reason] of Object.entries(BACKEND_ONLY)) {
      expect(backend).toContain(field);
      expect(frontend).not.toContain(field);
      expect(reason.length).toBeGreaterThan(20);
    }
    for (const [field, reason] of Object.entries(FRONTEND_ONLY)) {
      expect(frontend).toContain(field);
      expect(backend).not.toContain(field);
      expect(reason.length).toBeGreaterThan(20);
    }
  });
});
