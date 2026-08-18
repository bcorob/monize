import { describe, it, expect } from 'vitest';
import { isNavSectionActive } from './nav-section';

describe('isNavSectionActive', () => {
  it('marks the section a detail page belongs to', () => {
    // Opening an account from the Accounts page used to unlight the tab the
    // user had just come through.
    expect(isNavSectionActive('/accounts/abc-123', '/accounts')).toBe(true);
    expect(isNavSectionActive('/payees/abc-123', '/payees')).toBe(true);
    expect(isNavSectionActive('/reports/investment/abc-123', '/reports')).toBe(true);
  });

  it('marks the list page itself', () => {
    expect(isNavSectionActive('/accounts', '/accounts')).toBe(true);
  });

  it('marks nothing else', () => {
    expect(isNavSectionActive('/transactions', '/accounts')).toBe(false);
    expect(isNavSectionActive('/dashboard', '/accounts')).toBe(false);
  });

  it('needs the slash, so one section never claims another that starts the same', () => {
    expect(isNavSectionActive('/accounts-archive', '/accounts')).toBe(false);
    expect(isNavSectionActive('/reportsomething', '/reports')).toBe(false);
  });
});
