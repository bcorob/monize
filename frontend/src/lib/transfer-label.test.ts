import { describe, it, expect } from 'vitest';
import { transferCsvLabel, transferDirection } from './transfer-label';

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
