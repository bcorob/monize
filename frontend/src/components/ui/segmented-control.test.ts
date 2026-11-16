import { describe, it, expect } from 'vitest';
import {
  SEGMENTED_GROUP_CLASS,
  SEGMENTED_TOOLBAR_GROUP_CLASS,
  segmentClass,
  toolbarSegmentClass,
} from './segmented-control';

describe('segmented-control', () => {
  // A list toolbar's filter lands on a line of its own under the search on a
  // phone, and a pill sized to its words left most of that line empty.
  it('fills the phone line with the toolbar pill and keeps its own width from sm up', () => {
    const tokens = SEGMENTED_TOOLBAR_GROUP_CLASS.split(' ');
    expect(SEGMENTED_TOOLBAR_GROUP_CLASS.startsWith(SEGMENTED_GROUP_CLASS)).toBe(true);
    expect(tokens).toContain('w-full');
    expect(tokens).toContain('sm:w-auto');
  });

  it('spreads the toolbar segments across the phone line and not beyond it from sm up', () => {
    for (const isActive of [true, false]) {
      const tokens = toolbarSegmentClass(isActive).split(' ');
      expect(toolbarSegmentClass(isActive).startsWith(segmentClass(isActive))).toBe(true);
      expect(tokens).toContain('grow');
      expect(tokens).toContain('sm:grow-0');
    }
  });

  it('leaves the plain pill its own width at every size', () => {
    expect(SEGMENTED_GROUP_CLASS.split(' ')).not.toContain('w-full');
    expect(segmentClass(true).split(' ')).not.toContain('grow');
  });
});
