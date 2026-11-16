import { describe, expect, it } from 'vitest';

const sources = import.meta.glob('/src/components/reports/SecurityTypeAllocationReport.tsx', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

const dashboardCatalog = import.meta.glob('/src/i18n/messages/en/dashboard.json', {
  eager: true,
  import: 'default',
}) as Record<string, { securityTypeAllocation?: { types?: Record<string, string> } }>;

describe('the known security types are declared once', () => {
  /**
   * `TYPE_COLOURS`' keys ARE the known set: the colour and the translated label
   * are two halves of one agreement, and a sixth type added to one and not the
   * other is visible either way -- a slice captioned with the raw enum name, or
   * one coloured off the fallback ramp. `keyof typeof` holds the source side;
   * this holds the catalog side, which no type can reach.
   */
  function colourKeys(): string[] {
    const source = Object.values(sources)[0];
    const record = /const TYPE_COLOURS = \{([\s\S]*?)\} as const/.exec(source)?.[1];
    expect(record, 'TYPE_COLOURS is no longer a literal record -- update this guard').toBeDefined();
    return [...record!.matchAll(/^\s{2}([A-Z_]+):/gm)].map((m) => m[1]);
  }

  it('does not re-list them beside the colour record', () => {
    // A second literal list of the same codes is the shape this replaced.
    expect(Object.values(sources)[0]).not.toMatch(/const\s+KNOWN_SECURITY_TYPES\b/);
    expect(Object.values(sources)[0]).toContain('type in TYPE_COLOURS');
  });

  it('gives every coloured type a label in the en catalog', () => {
    const keys = colourKeys();
    expect(keys.length).toBeGreaterThan(0);
    const labels = dashboardCatalog['/src/i18n/messages/en/dashboard.json'].securityTypeAllocation
      ?.types;
    expect(labels).toBeDefined();
    expect(keys.filter((key) => !(key in labels!))).toEqual([]);
  });

  it('has no catalog label for a type the report cannot colour', () => {
    // The other direction: a stale label is a translated string nothing renders,
    // and it hides the fact that the type was dropped.
    const keys = new Set(colourKeys());
    const labels = dashboardCatalog['/src/i18n/messages/en/dashboard.json'].securityTypeAllocation
      ?.types;
    expect(Object.keys(labels!).filter((key) => !keys.has(key))).toEqual([]);
  });
});

describe('SecurityTypeAllocationReport translates type and quantity labels', () => {
  it('scans the production component', () => {
    expect(Object.keys(sources)).toEqual([
      '/src/components/reports/SecurityTypeAllocationReport.tsx',
    ]);
  });

  it('gets known security type labels from the existing dashboard catalogue', () => {
    const source = Object.values(sources)[0];

    expect(source).not.toMatch(/const\s+TYPE_LABELS\b/);
    expect(source).toContain("useTranslations('dashboard')");
    expect(source).toContain('tDashboard(`securityTypeAllocation.types.${type}`)');
  });

  it('labels a child quantity as shares, not as the parent holding count', () => {
    const source = Object.values(sources)[0];
    const quantityCell = source.match(
      /<td role="cell" className=\{`\$\{CHILD_CELL_PLACEMENT\.count\}[\s\S]*?<\/td>/,
    )?.[0];

    expect(quantityCell).toBeDefined();
    expect(quantityCell).toContain("t('securityTypeAllocation.colShares')");
    expect(quantityCell).not.toContain('columns.count.label');
  });
});
