import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  ScheduleFrequency,
  advanceDate,
  getPeriodsPerYear,
  maxPaymentsForHorizon,
} from '@/lib/loan-schedule';
import {
  MORTGAGE_PAYMENT_FREQUENCIES,
  PAYMENT_FREQUENCIES,
  toMortgagePaymentFrequency,
} from '@/types/account';
import enAccounts from '@/i18n/messages/en/accounts.json';
import { advanceByFrequency } from '@/lib/frequency';
import type { FrequencyType } from '@/types/scheduled-transaction';

/**
 * `accounts.payment_frequency` holds whichever spelling wrote it, and two paths
 * write it: the mortgage path stores the mortgage enum's value, the loan-payment
 * setup dialog stores the scheduled-transaction recurrence's. `ScheduleFrequency`
 * has to accept every one of them, because `buildLoanProjectionInput` reaches the
 * engine through a cast (`account.paymentFrequency as ScheduleFrequency`) and
 * `getPeriodsPerYear` answers an unrecognized value with its monthly default.
 *
 * That is what happened to semi-monthly: the dialog stores `SEMIMONTHLY`,
 * `ScheduleFrequency` spelled it `SEMI_MONTHLY`, and the loan detail page, the
 * overpayment simulator, both loan reports and `useLoanProjection` all projected
 * 12 periods a year instead of 24 -- roughly double the remaining interest and a
 * payoff date twice as far out.
 *
 * A cast cannot be type-checked, so this is the scan that checks it: it reads the
 * options out of the setup dialog's source rather than trusting a copy here.
 */
function dialogFrequencies(): string[] {
  const source = readFileSync(
    join(
      __dirname,
      '..',
      'components',
      'accounts',
      'LoanPaymentSetupDialog.tsx',
    ),
    'utf8',
  );
  const values = [...source.matchAll(/\{\s*value:\s*'([A-Z_]+)'/g)].map(
    (m) => m[1],
  );
  if (values.length === 0) {
    throw new Error(
      'LoanPaymentSetupDialog.tsx no longer declares its frequency options as ' +
        "{ value: '...' } literals; update this guard to read whatever offers them now",
    );
  }
  return values;
}

/**
 * The cadences the Add/Edit Account form's loan section offers.
 *
 * A second list existed here and was missing SEMIMONTHLY, so a loan could be
 * given that cadence by the setup dialog but never created with it -- and this
 * guard read only the dialog, so nothing failed. `LoanFields.tsx` derives its
 * options from `PAYMENT_FREQUENCIES` now, and the label key for each is a
 * `Record` over the same union; this reads that table so a value silently
 * dropped from the map is a failure here rather than a missing option nobody
 * notices.
 */
function loanFormFrequencies(): string[] {
  const source = readFileSync(
    join(__dirname, '..', 'components', 'accounts', 'LoanFields.tsx'),
    'utf8',
  );
  const table = /LOAN_FREQUENCY_LABEL_KEY:\s*Record<[^>]*>\s*=\s*\{([^}]*)\}/.exec(
    source,
  );
  if (!table) {
    throw new Error(
      'LoanFields.tsx no longer declares LOAN_FREQUENCY_LABEL_KEY; update this ' +
        'guard to read whatever names its frequency options now',
    );
  }
  return [...table[1].matchAll(/^\s*([A-Z_]+):/gm)].map((m) => m[1]);
}

/** The same table read as frequency -> catalog key. */
function loanFormLabelKeys(): Record<string, string> {
  const source = readFileSync(
    join(__dirname, '..', 'components', 'accounts', 'LoanFields.tsx'),
    'utf8',
  );
  const table = /LOAN_FREQUENCY_LABEL_KEY:\s*Record<[^>]*>\s*=\s*\{([^}]*)\}/.exec(
    source,
  );
  if (!table) {
    throw new Error(
      'LoanFields.tsx no longer declares LOAN_FREQUENCY_LABEL_KEY; update this ' +
        'guard to read whatever names its frequency options now',
    );
  }
  return Object.fromEntries(
    [...table[1].matchAll(/^\s*([A-Z_]+):\s*'([A-Za-z]+)'/gm)].map((m) => [
      m[1],
      m[2],
    ]),
  );
}

describe('loan payment frequency contract', () => {
  it('reads a non-empty option set out of the setup dialog', () => {
    const offered = dialogFrequencies();
    expect(offered.length).toBeGreaterThan(0);
    expect(offered).toContain('MONTHLY');
    // The spelling that used to be missing.
    expect(offered).toContain('SEMIMONTHLY');
  });

  it('gives every offered frequency its own period count', () => {
    // Declared here rather than compared against `frequency.ts`'s
    // OCCURRENCES_PER_YEAR: that table is calendar-average (52.18 weeks a year)
    // for restating amounts, while a payment schedule counts exact periods. Each
    // value is asserted against its own expected count, so a wrong case fails as
    // well as a missing one -- the failure mode is a silent fall-through to 12.
    const expected: Record<string, number> = {
      WEEKLY: 52,
      BIWEEKLY: 26,
      SEMIMONTHLY: 24,
      MONTHLY: 12,
      QUARTERLY: 4,
      YEARLY: 1,
    };
    for (const frequency of dialogFrequencies()) {
      expect(expected[frequency]).toBeDefined();
      expect(getPeriodsPerYear(frequency as ScheduleFrequency)).toBe(
        expected[frequency],
      );
    }
  });

  it('lands a year out after one year of steps, for every frequency', () => {
    // The period count and the date stepping are two halves of one claim, and
    // `advanceDate` has the same monthly default `getPeriodsPerYear` has -- so a
    // frequency it does not recognize dates the rows a month apart however
    // correct its count is. Stepping `periods` times must therefore land about a
    // year out: 52 weekly steps and 26 biweekly ones give 364 days, 24
    // semi-monthly and 12 monthly a little over a calendar year. A monthly
    // fall-through would overshoot wildly (52 months is four and a half years).
    const start = new Date(2026, 0, 1);
    for (const frequency of dialogFrequencies()) {
      const periods = getPeriodsPerYear(frequency as ScheduleFrequency);
      let cursor = start;
      for (let i = 0; i < periods; i++) {
        const next = advanceDate(cursor, frequency as ScheduleFrequency);
        expect(next.getTime()).toBeGreaterThan(cursor.getTime());
        cursor = next;
      }
      const days = Math.round(
        (cursor.getTime() - start.getTime()) / (1000 * 60 * 60 * 24),
      );
      expect(days).toBeGreaterThanOrEqual(360);
      expect(days).toBeLessThanOrEqual(380);
    }
  });

  it('has a label for every frequency an account can store', () => {
    // The loan detail page builds its label by template from
    // account.paymentFrequency, so a stored value with no catalog key renders the
    // raw key path and next-intl logs MISSING_MESSAGE. The parity suite cannot
    // catch it -- every locale is equally missing a key nobody added -- so the
    // check is here, against the two lists the column can hold.
    const labels = Object.keys(enAccounts.loanDetail.frequency);
    for (const frequency of [
      ...PAYMENT_FREQUENCIES,
      ...MORTGAGE_PAYMENT_FREQUENCIES,
    ]) {
      expect(labels).toContain(frequency);
    }
  });

  it('gives every account-storable frequency a period count', () => {
    // Both lists reach `buildLoanProjectionInput`'s cast, so both must be real
    // cases rather than the monthly default.
    const expected: Record<string, number> = {
      WEEKLY: 52,
      ACCELERATED_WEEKLY: 52,
      BIWEEKLY: 26,
      ACCELERATED_BIWEEKLY: 26,
      SEMIMONTHLY: 24,
      SEMI_MONTHLY: 24,
      MONTHLY: 12,
      QUARTERLY: 4,
      YEARLY: 1,
    };
    for (const frequency of [
      ...PAYMENT_FREQUENCIES,
      ...MORTGAGE_PAYMENT_FREQUENCIES,
    ]) {
      expect(getPeriodsPerYear(frequency as ScheduleFrequency)).toBe(
        expected[frequency],
      );
    }
  });

  it('offers every storable cadence on the account form, not a subset', () => {
    // Both surfaces write accounts.payment_frequency, and `optionalEnum` maps an
    // unlisted value to undefined -- so a form list missing a cadence does not
    // merely hide it, it ERASES that frequency from any loan the other surface
    // created, the first time somebody edits the account.
    expect(loanFormFrequencies()).toEqual([...PAYMENT_FREQUENCIES]);
  });

  it('gives each account-form cadence its own catalog key', () => {
    // Two halves a name check alone would miss: a key the catalog does not hold
    // renders the key path with a MISSING_MESSAGE in the console, and a key
    // REUSED by two cadences renders one of them under the other's name --
    // "Semi-Monthly" offered as a second "Monthly" is a wrong option, not a
    // missing one, and it is the shape a hand-edited table produces.
    const keys = loanFormLabelKeys();
    const catalog = Object.keys(enAccounts.loanFields.frequencyOptions);
    for (const key of Object.values(keys)) {
      expect(catalog).toContain(key);
    }
    expect(new Set(Object.values(keys)).size).toBe(
      Object.keys(keys).length,
    );
  });

  it('offers only frequencies the account type list can store', () => {
    // The dialog writes its value onto accounts.payment_frequency, which
    // UpdateAccountDto validates against the same list -- so an option outside it
    // creates an account that cannot be saved again.
    for (const frequency of dialogFrequencies()) {
      expect(PAYMENT_FREQUENCIES as readonly string[]).toContain(frequency);
    }
  });

  it('steps every cadence exactly as the recurrence engine does', () => {
    // The projection's row dates and the scheduler's posting dates are the same
    // calendar to a borrower, so they are the same calendar in code:
    // `advanceDate` delegates to `advanceByFrequency` through one Record.
    //
    // This walk is what stops a second calendar reappearing. Only semi-monthly
    // used to be aligned; the month cadences stepped with `Date.setMonth(+1)`,
    // which OVERFLOWS -- 31 January to 3 March, February skipped -- while the
    // backend clamped to 28 February, so a loan paid on the 31st had every
    // projected row three days off the schedule its payoff date bounded.
    //
    // The anchors are chosen to make a clamp mandatory: the 31st visits every
    // month too short to hold it, and 29 February 2028 is the leap day a yearly
    // cadence must clamp on its anniversary.
    const ANCHORS = [
      new Date(2026, 0, 1),
      new Date(2026, 0, 15),
      new Date(2026, 0, 31), // month-end, where overflow and clamp disagree
      new Date(2026, 1, 28),
      new Date(2028, 1, 29), // leap day
      new Date(2026, 10, 30),
    ];
    const RECURRENCE_OF: Record<string, FrequencyType> = {
      WEEKLY: 'WEEKLY',
      ACCELERATED_WEEKLY: 'WEEKLY',
      BIWEEKLY: 'BIWEEKLY',
      ACCELERATED_BIWEEKLY: 'BIWEEKLY',
      SEMI_MONTHLY: 'SEMIMONTHLY',
      SEMIMONTHLY: 'SEMIMONTHLY',
      MONTHLY: 'MONTHLY',
      QUARTERLY: 'QUARTERLY',
      YEARLY: 'YEARLY',
    };

    for (const frequency of Object.keys(RECURRENCE_OF) as ScheduleFrequency[]) {
      for (const anchor of ANCHORS) {
        let mine = anchor;
        let theirs = anchor;
        // Long enough that an accumulating clamp difference has to show: 40
        // monthly steps cross three Februaries, 40 weekly ones a year and a bit.
        for (let step = 0; step < 40; step++) {
          mine = advanceDate(mine, frequency);
          theirs = advanceByFrequency(theirs, RECURRENCE_OF[frequency]);
          expect(
            `${frequency}@${anchor.toDateString()}+${step + 1}: ${mine.toDateString()}`,
          ).toBe(
            `${frequency}@${anchor.toDateString()}+${step + 1}: ${theirs.toDateString()}`,
          );
        }
      }
    }
  });

  it('maps every account-storable frequency onto a recurrence the engine has', () => {
    // The Record inside `loan-schedule.ts` is the browser twin of the backend's
    // two tables, and the walk above proves it agrees with the engine only for
    // the cadences it names. This asserts it names them all: a value the account
    // column can hold but the Record omits falls to the `?? 'MONTHLY'` runtime
    // fallback, which is the semi-monthly defect again.
    for (const frequency of [
      ...PAYMENT_FREQUENCIES,
      ...MORTGAGE_PAYMENT_FREQUENCIES,
    ]) {
      const start = new Date(2026, 0, 31);
      const stepped = advanceDate(start, frequency as ScheduleFrequency);
      // Monthly is the fallback's answer, so a genuinely monthly cadence cannot
      // be told from a missing one by the date alone -- assert against the
      // period count, which the same list already pins.
      const periods = getPeriodsPerYear(frequency as ScheduleFrequency);
      const monthlyAnswer = advanceDate(start, 'MONTHLY');
      if (periods !== 12) {
        expect(stepped.getTime()).not.toBe(monthlyAnswer.getTime());
      } else {
        expect(stepped.getTime()).toBe(monthlyAnswer.getTime());
      }
    }
  });

  it('agrees with the backend about which cadences a mortgage can hold', () => {
    // `toMortgagePaymentFrequency` exists on both sides: the server refuses a
    // cadence its mortgage helpers cannot express (400), and the setup dialog
    // must not OFFER one. Two copies of a refusal is exactly how a form comes to
    // present a choice the server rejects, so the browser copy is checked
    // against the backend switch rather than trusted.
    // The only cross-package source read in this suite, so it says so when the
    // sibling tree is not there: a frontend-only checkout, a sparse clone or an
    // extracted package would otherwise fail this file with an ENOENT that reads
    // like a broken guard rather than a missing dependency.
    const backendPath = join(
      __dirname,
      '..',
      '..',
      '..',
      'backend',
      'src',
      'accounts',
      'payment-frequency.util.ts',
    );
    if (!existsSync(backendPath)) {
      throw new Error(
        `${backendPath} is not present: this guard compares the browser copy of ` +
          'toMortgagePaymentFrequency against the backend original, so it needs ' +
          'the full repository checkout, not just frontend/',
      );
    }
    const backendSource = readFileSync(backendPath, 'utf8');
    const body = backendSource.slice(
      backendSource.indexOf('export function toMortgagePaymentFrequency'),
    );
    if (!body.startsWith('export function toMortgagePaymentFrequency')) {
      throw new Error(
        'backend toMortgagePaymentFrequency not found -- update this guard to read whatever replaced it',
      );
    }
    const switchBody = body.slice(0, body.indexOf('\n}'));
    const passThrough = [...switchBody.matchAll(/case "([A-Z_]+)":/g)].map(
      (m) => m[1],
    );
    expect(passThrough.length).toBeGreaterThan(0);

    // The one case that returns something OTHER than its own name: the backend
    // spells it `case "SEMIMONTHLY": return "SEMI_MONTHLY";`, and it is exactly
    // the pair the two spellings exist for.
    const rewritten = /case "([A-Z_]+)":\s*\n\s*return "([A-Z_]+)";/.exec(
      switchBody,
    );
    expect(rewritten).not.toBeNull();

    // What each side MAPS to, not merely which it accepts. Checking non-null
    // alone would pass while the browser copy answered 'BIWEEKLY' for
    // SEMIMONTHLY -- still accepted, still offered, and the server would then
    // split that mortgage at 26 periods a year instead of 24.
    for (const frequency of passThrough) {
      // A pass-through case returns its own name; the rewritten one is checked
      // against the value the backend actually returns.
      const expected =
        rewritten && rewritten[1] === frequency ? rewritten[2] : frequency;
      expect([frequency, toMortgagePaymentFrequency(frequency)]).toEqual([
        frequency,
        expected,
      ]);
    }
    // And every value the account column can hold gets the same verdict on both
    // sides: accepted iff the backend names it.
    for (const frequency of [
      ...PAYMENT_FREQUENCIES,
      ...MORTGAGE_PAYMENT_FREQUENCIES,
    ]) {
      expect([frequency, toMortgagePaymentFrequency(frequency) !== null]).toEqual([
        frequency,
        passThrough.includes(frequency),
      ]);
    }
  });

  it('treats both spellings of semi-monthly identically', () => {
    // Both are persisted, by different paths, so neither may be the odd one out.
    expect(getPeriodsPerYear('SEMI_MONTHLY')).toBe(24);
    expect(getPeriodsPerYear('SEMIMONTHLY')).toBe(24);
    expect(maxPaymentsForHorizon('SEMIMONTHLY')).toBe(
      maxPaymentsForHorizon('SEMI_MONTHLY'),
    );
    const start = new Date(2026, 0, 1);
    expect(advanceDate(start, 'SEMIMONTHLY').getTime()).toBe(
      advanceDate(start, 'SEMI_MONTHLY').getTime(),
    );
  });
});
