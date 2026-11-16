import { describe, it, expect } from 'vitest';
import { toSafeExternalUrl, externalUrlLabel } from './external-url';

describe('toSafeExternalUrl', () => {
  it('passes through http and https addresses', () => {
    expect(toSafeExternalUrl('https://example.com')).toBe('https://example.com');
    expect(toSafeExternalUrl('http://example.com')).toBe('http://example.com');
    expect(toSafeExternalUrl('HTTPS://example.com')).toBe('HTTPS://example.com');
  });

  it('rejects a scheme that would run something on click', () => {
    // The whole point: a javascript: href executes when the link is clicked,
    // so an unchecked stored string must never reach an anchor.
    expect(toSafeExternalUrl('javascript:alert(1)')).toBeNull();
    expect(toSafeExternalUrl('JaVaScRiPt:alert(1)')).toBeNull();
    expect(toSafeExternalUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(toSafeExternalUrl('vbscript:msgbox(1)')).toBeNull();
  });

  it('rejects a schemeless address, which an anchor resolves relatively', () => {
    expect(toSafeExternalUrl('example.com')).toBeNull();
    expect(toSafeExternalUrl('/settings')).toBeNull();
    expect(toSafeExternalUrl('//example.com')).toBeNull();
  });

  it('treats absent and empty as nothing to link', () => {
    expect(toSafeExternalUrl(null)).toBeNull();
    expect(toSafeExternalUrl(undefined)).toBeNull();
    expect(toSafeExternalUrl('')).toBeNull();
  });
});

describe('externalUrlLabel', () => {
  it('shortens to the hostname, without a leading www', () => {
    expect(externalUrlLabel('https://www.starbucks.com/menu')).toBe('starbucks.com');
    expect(externalUrlLabel('https://investor.apple.com')).toBe('investor.apple.com');
  });

  it('keeps the raw value when it will not parse', () => {
    expect(externalUrlLabel('https://')).toBe('https://');
  });
});
