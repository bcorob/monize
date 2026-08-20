import { describe, it, expect } from 'vitest';
import { NAV_LINKS, TOOLS_LINKS, AI_LINKS, NAV_ICONS } from './nav-links';

describe('nav-links', () => {
  it('gives every nav route an icon', () => {
    // The drawer and the header dropdowns render NAV_ICONS[href]; a link
    // added without an icon would ship a bare row beside decorated ones.
    const missing = [...NAV_LINKS, ...TOOLS_LINKS, ...AI_LINKS]
      .map((l) => l.href)
      .filter((href) => !NAV_ICONS[href]);
    expect(missing).toEqual([]);
  });

  it('covers the fixed drawer entries outside the arrays', () => {
    for (const href of ['/dashboard', '/admin/users', '/settings']) {
      expect(NAV_ICONS[href], `no icon for ${href}`).toBeTruthy();
    }
  });

  it('keeps hrefs unique across the three arrays', () => {
    const hrefs = [...NAV_LINKS, ...TOOLS_LINKS, ...AI_LINKS].map((l) => l.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});
