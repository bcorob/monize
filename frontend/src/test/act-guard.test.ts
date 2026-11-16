import { readFileSync } from 'fs';
import { join } from 'path';

import { describe, expect, it } from 'vitest';

import { failOnActWarnings, pendingActWarnings, recordIfActWarning } from './act-guard';

// React's real message, verbatim, including the printf placeholder that carries
// the component name as a separate argument.
const REACT_ACT_WARNING =
  'An update to %s inside a test was not wrapped in act(...).\n\n' +
  'When testing, code that causes React state updates should be wrapped into act(...):';

describe('act-guard', () => {
  it('recognizes React act warnings and nothing else', () => {
    expect(recordIfActWarning([REACT_ACT_WARNING, 'TransactionsPage'])).toBe(true);
    expect(recordIfActWarning(['<path> attribute d: Expected number'])).toBe(false);
    expect(recordIfActWarning(['[useTransactionSelection]', 'Save failed'])).toBe(false);
    expect(recordIfActWarning([new Error('boom')])).toBe(false);
    // Only the first was recognised, so only it is pending. Draining here keeps
    // it from failing the next test in this file.
    expect(pendingActWarnings()).toHaveLength(1);
    expect(() => failOnActWarnings()).toThrow();
  });

  // Regression: CI run #2875 turned `main` red on `DividendIncomeReport`, a test
  // nothing had changed. React's environment message is a different condition,
  // it names no component, and it fires from teardown timing the suite does not
  // control -- so it is not a test failure. See the note in `act-guard.ts`.
  it('does not fail a test on the "environment is not configured" message', () => {
    const envMessage =
      'Warning: The current testing environment is not configured to support act(...)';
    expect(recordIfActWarning([envMessage])).toBe(false);
    expect(pendingActWarnings()).toHaveLength(0);
    expect(() => failOnActWarnings()).not.toThrow();
  });

  // Classifying and recording are one call, so a message the guard does not
  // recognise cannot be recorded by a second door and fail a test anyway.
  it('records only what it recognises', () => {
    recordIfActWarning(['some unrelated console.error']);
    expect(pendingActWarnings()).toHaveLength(0);
  });

  it('fails the test, naming the component React named', () => {
    recordIfActWarning([REACT_ACT_WARNING, 'TransactionsPage']);
    expect(pendingActWarnings()).toHaveLength(1);

    expect(() => failOnActWarnings()).toThrow(/An update to TransactionsPage inside a test/);
  });

  it('reports once per distinct warning, and resets so it fails only the test that earned it', () => {
    recordIfActWarning([REACT_ACT_WARNING, 'DateInput']);
    recordIfActWarning([REACT_ACT_WARNING, 'DateInput']);
    recordIfActWarning([REACT_ACT_WARNING, 'SecurityList']);

    expect(() => failOnActWarnings()).toThrow(/2 act\(\) warnings/);
    // Reported once: a warning left in the buffer would fail every later test
    // in the file and hide which one actually produced it.
    expect(pendingActWarnings()).toHaveLength(0);
    expect(() => failOnActWarnings()).not.toThrow();
  });

  it('says nothing when nothing was recorded', () => {
    expect(() => failOnActWarnings()).not.toThrow();
  });

  // A guard nothing calls is not a guard. `setup.ts` is the only wiring, and it
  // is a side-effecting file that cannot be imported twice to assert on -- so
  // the wiring is checked by reading it.
  describe('setup.ts wiring', () => {
    const setup = readFileSync(join(__dirname, 'setup.ts'), 'utf8');

    it('routes console.error through the guard', () => {
      expect(setup).toMatch(/recordIfActWarning\(args\)/);
    });

    it('fails after every test and after the last one', () => {
      // In `afterEach`, after `cleanup()`: an update React commits while
      // unmounting belongs to the test that mounted the tree.
      expect(setup).toMatch(/cleanup\(\);[\s\S]*?failOnActWarnings\(\);[\s\S]*?\}\);/);
      // `afterAll` gained a second guard (intl), so it is a block rather than a
      // bare reference. Match the call inside it, not the old exact spelling --
      // otherwise this asserts the formatting rather than the wiring.
      expect(setup).toMatch(/afterAll\(\(\) => \{[\s\S]*?failOnActWarnings\(\);[\s\S]*?\}\)/);
    });

    it('does not suppress act warnings anywhere else', () => {
      // Any second mention of act() in a console filter would be a silencer.
      const filtered = setup.match(/msg\.includes\('([^']*)'\)/g) ?? [];
      expect(filtered.some((m) => /act/i.test(m))).toBe(false);
    });
  });
});
