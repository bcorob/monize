import { describe, it, expect } from 'vitest';
import {
  transferCsvLabel,
  transferDirection,
  transferPayeeCsvLabel,
  transferPayeeParams,
} from './transfer-label';

describe('transferDirection', () => {
  it('reads money leaving the account as a transfer to the counterpart', () => {
    expect(transferDirection(-200)).toBe('to');
  });

  it('reads money arriving as a transfer from the counterpart', () => {
    expect(transferDirection(200)).toBe('from');
  });

  it('answers from a decimal string, which is what the API sends', () => {
    // `decimal(20,4)` crosses the wire as a string; `'-67.9900' < 0` is false
    // in JS, so a helper comparing without coercing labels every debit "from".
    expect(transferDirection('-67.9900')).toBe('to');
    expect(transferDirection('67.9900')).toBe('from');
  });

  it('gives a zero amount the same answer as the register does', () => {
    // A placeholder amount has no direction to read. What matters is that one
    // rule answers it everywhere rather than each surface guessing.
    expect(transferDirection(0)).toBe('from');
  });
});

describe('transferCsvLabel', () => {
  it('names the counterpart and which way the money went', () => {
    expect(transferCsvLabel('Savings', -200)).toBe('Transfer To Savings');
    expect(transferCsvLabel('Chequing', 200)).toBe('Transfer From Chequing');
  });

  it('carries an account name a spreadsheet would otherwise evaluate', () => {
    // The label puts the name behind "Transfer", so the cell no longer opens
    // with a character the CSV writer's formula guard reacts to.
    expect(transferCsvLabel('-Old Savings', -200)).toBe(
      'Transfer To -Old Savings',
    );
  });
});

describe('transferPayeeParams (issue #1214)', () => {
  const blankTransfer = {
    payeeName: null,
    payee: null,
    isTransfer: true,
    amount: '-250.0000',
    linkedTransaction: { account: { name: 'Savings' } },
  };

  it('resolves a blank-payee transfer leg from its linked account', () => {
    expect(transferPayeeParams(blankTransfer)).toEqual({
      direction: 'to',
      name: 'Savings',
    });
    expect(
      transferPayeeParams({ ...blankTransfer, amount: '250.0000' }),
    ).toEqual({ direction: 'from', name: 'Savings' });
  });

  it('defers to a stored payee, denormalized or linked', () => {
    expect(
      transferPayeeParams({ ...blankTransfer, payeeName: 'Landlord' }),
    ).toBeNull();
    expect(
      transferPayeeParams({ ...blankTransfer, payee: { name: 'Landlord' } }),
    ).toBeNull();
  });

  it('returns null for a non-transfer or an unloaded counterpart', () => {
    expect(transferPayeeParams({ ...blankTransfer, isTransfer: false })).toBeNull();
    expect(
      transferPayeeParams({ ...blankTransfer, linkedTransaction: null }),
    ).toBeNull();
    expect(
      transferPayeeParams({ ...blankTransfer, linkedTransaction: {} }),
    ).toBeNull();
  });
});

describe('transferPayeeCsvLabel (issue #1214)', () => {
  it('writes the same English text the pre-#1214 writers stamped', () => {
    expect(
      transferPayeeCsvLabel({
        payeeName: null,
        payee: null,
        isTransfer: true,
        amount: '-250.0000',
        linkedTransaction: { account: { name: 'Savings' } },
      }),
    ).toBe('Transfer to Savings');
    expect(
      transferPayeeCsvLabel({
        payeeName: null,
        payee: null,
        isTransfer: true,
        amount: '250.0000',
        linkedTransaction: { account: { name: 'Chequing' } },
      }),
    ).toBe('Transfer from Chequing');
  });

  it('returns null when the row keeps its stored payee', () => {
    expect(
      transferPayeeCsvLabel({
        payeeName: 'Transfer to Old Name',
        payee: null,
        isTransfer: true,
        amount: '-250.0000',
        linkedTransaction: { account: { name: 'Savings' } },
      }),
    ).toBeNull();
  });
});
