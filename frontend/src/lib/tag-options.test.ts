import { describe, it, expect } from 'vitest';
import { buildTagOptions, RECENT_TAG_COUNT } from './tag-options';
import type { Tag, TagUsageMap } from '@/types/tag';

const tag = (id: string, name: string): Tag => ({
  id,
  userId: 'user-1',
  name,
  color: null,
  icon: null,
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-01-01T00:00:00Z',
});

const labels = (options: ReturnType<typeof buildTagOptions>) => options.map((o) => o.label);

describe('buildTagOptions', () => {
  it('is plain A-Z, case-insensitive, with no rule when nothing has been used', () => {
    const options = buildTagOptions(
      [tag('1', 'travel'), tag('2', 'Groceries'), tag('3', 'business')],
      {},
    );

    expect(labels(options)).toEqual(['business', 'Groceries', 'travel']);
    expect(options.some((o) => o.separatorAfter)).toBe(false);
  });

  it('puts recently used tags first and a stale project tag in the A-Z list (discussion #708)', () => {
    const tags = [
      tag('h08', 'Holiday 2008'),
      tag('h26', 'Holiday 2026'),
      tag('gro', 'Groceries'),
      tag('aaa', 'Art'),
    ];
    const usage: TagUsageMap = {
      // Heavily used, but long ago: recency outranks frequency.
      h08: { lastUsed: '2008-12-24', count: 500 },
      h26: { lastUsed: '2026-10-01', count: 3 },
      gro: { lastUsed: '2026-09-15', count: 80 },
    };

    const options = buildTagOptions(tags, usage);

    expect(labels(options)).toEqual(['Holiday 2026', 'Groceries', 'Holiday 2008', 'Art']);
    expect(options.filter((o) => o.separatorAfter).map((o) => o.label)).toEqual(['Holiday 2008']);
  });

  it('breaks a tie on date by use count, then by name', () => {
    const tags = [tag('c', 'Charlie'), tag('b', 'bravo'), tag('a', 'Alpha'), tag('z', 'Zulu')];
    const usage: TagUsageMap = {
      a: { lastUsed: '2026-10-01', count: 2 },
      b: { lastUsed: '2026-10-01', count: 2 },
      c: { lastUsed: '2026-10-01', count: 9 },
    };

    expect(labels(buildTagOptions(tags, usage))).toEqual(['Charlie', 'Alpha', 'bravo', 'Zulu']);
  });

  it(`keeps only ${RECENT_TAG_COUNT} in the recent group and lists the overflow A-Z`, () => {
    const names = ['K', 'J', 'I', 'H', 'G', 'F', 'E', 'D', 'C', 'B'];
    const tags = names.map((name) => tag(name, name));
    // K is newest, B oldest: one day apart each.
    const usage: TagUsageMap = Object.fromEntries(
      names.map((name, index) => [name, { lastUsed: `2026-09-${String(20 - index).padStart(2, '0')}`, count: 1 }]),
    );

    const options = buildTagOptions([...tags, tag('A', 'A')], usage);

    expect(labels(options)).toEqual(['K', 'J', 'I', 'H', 'G', 'F', 'E', 'D', 'A', 'B', 'C']);
    expect(options.findIndex((o) => o.separatorAfter)).toBe(RECENT_TAG_COUNT - 1);
  });

  it('draws no rule when every tag is in the recent group', () => {
    const options = buildTagOptions([tag('a', 'A'), tag('b', 'B')], {
      a: { lastUsed: '2026-01-01', count: 1 },
      b: { lastUsed: '2026-02-01', count: 1 },
    });

    expect(labels(options)).toEqual(['B', 'A']);
    expect(options.some((o) => o.separatorAfter)).toBe(false);
  });

  it('ignores usage for a tag that is not in the list', () => {
    const options = buildTagOptions([tag('a', 'A')], { gone: { lastUsed: '2026-01-01', count: 1 } });

    expect(options).toEqual([{ value: 'a', label: 'A' }]);
  });

  it('does not reorder the caller\'s array', () => {
    const tags = [tag('b', 'B'), tag('a', 'A')];

    buildTagOptions(tags, { a: { lastUsed: '2026-01-01', count: 1 } });

    expect(tags.map((t) => t.id)).toEqual(['b', 'a']);
  });
});
