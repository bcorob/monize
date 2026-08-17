import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildCsvContent, exportCsvSections, exportToCsv } from './csv-export';

describe('exportToCsv', () => {
  let createObjectURL: any;
  let revokeObjectURL: any;
  let clickSpy: any;
  let lastLink: HTMLAnchorElement | null;

  beforeEach(() => {
    lastLink = null;
    createObjectURL = vi.fn().mockReturnValue('blob:mock');
    revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, writable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, writable: true });

    clickSpy = vi.fn();
    vi.spyOn(document.body, 'appendChild').mockImplementation((node: any) => {
      lastLink = node;
      // Override click on the anchor element to capture downloads without
      // triggering a real navigation in jsdom.
      if (node && node.tagName === 'A') {
        (node as HTMLAnchorElement).click = clickSpy;
      }
      return node;
    });
    vi.spyOn(document.body, 'removeChild').mockImplementation((node: any) => node);
  });

  it('creates a csv blob with given headers and rows and triggers download', () => {
    exportToCsv('report', ['Name', 'Amount'], [
      ['Apple', 10],
      ['Banana', 20],
    ]);

    expect(createObjectURL).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock');
    expect(lastLink?.download).toBe('report.csv');
  });

  it('does not double the .csv extension', () => {
    exportToCsv('report.csv', ['A'], [['1']]);
    expect(lastLink?.download).toBe('report.csv');
  });

  it('escapes values containing commas', () => {
    exportToCsv('out', ['Name'], [['hello, world']]);
    const blobArg = (createObjectURL.mock.calls[0][0] as Blob);
    return blobArg.text().then((text) => {
      expect(text).toContain('"hello, world"');
    });
  });

  it('escapes values containing quotes by doubling them', () => {
    exportToCsv('out', ['Name'], [['quote "here"']]);
    const blobArg = (createObjectURL.mock.calls[0][0] as Blob);
    return blobArg.text().then((text) => {
      expect(text).toContain('"quote ""here"""');
    });
  });

  it('handles values with newlines', () => {
    exportToCsv('out', ['Name'], [['line1\nline2']]);
    const blobArg = (createObjectURL.mock.calls[0][0] as Blob);
    return blobArg.text().then((text) => {
      expect(text).toContain('"line1\nline2"');
    });
  });

  it('handles null and undefined as empty strings', () => {
    exportToCsv('out', ['A', 'B'], [[null, undefined]]);
    const blobArg = (createObjectURL.mock.calls[0][0] as Blob);
    return blobArg.text().then((text) => {
      expect(text).toContain('A,B');
      expect(text).toContain('\r\n,');
    });
  });

  it('prevents formula injection by prefixing dangerous characters with tab', () => {
    exportToCsv('out', ['F'], [['=cmd|run']]);
    const blobArg = (createObjectURL.mock.calls[0][0] as Blob);
    return blobArg.text().then((text) => {
      // Tab prefix forces it to be a quoted value (since tab is dangerous char list)
      expect(text).toContain('\t=cmd|run');
    });
  });

  it('handles boolean and number values', () => {
    exportToCsv('out', ['A', 'B'], [[true, 42]]);
    const blobArg = (createObjectURL.mock.calls[0][0] as Blob);
    return blobArg.text().then((text) => {
      expect(text).toContain('true,42');
    });
  });

  it('writes negative numbers as plain numeric values without tab or quotes', () => {
    exportToCsv('out', ['A', 'B'], [[-100, -1.5]]);
    const blobArg = (createObjectURL.mock.calls[0][0] as Blob);
    return blobArg.text().then((text) => {
      expect(text).toContain('-100,-1.5');
      expect(text).not.toContain('"\t-100"');
      expect(text).not.toContain('"-100"');
    });
  });

  it('still applies formula-injection guard to string values starting with -', () => {
    exportToCsv('out', ['F'], [['-1+cmd|run']]);
    const blobArg = (createObjectURL.mock.calls[0][0] as Blob);
    return blobArg.text().then((text) => {
      expect(text).toContain('\t-1+cmd|run');
    });
  });

  it('writes an API decimal string as a number, not as guarded text', async () => {
    // Issue #1134: a `decimal(20,4)` column reaches the client as a string, so
    // every negative amount took the string path and landed in the spreadsheet
    // as text with a leading tab. Excel then refuses to add the column up.
    exportToCsv('out', ['Amount'], [['-67.9900']]);
    const text = await (createObjectURL.mock.calls[0][0] as Blob).text();

    expect(text).toContain('\r\n-67.9900');
    expect(text).not.toContain('\t');
    expect(text).not.toContain('"');
  });
});

describe('formula-injection guard', () => {
  /** One cell, so the assertion is about that cell and nothing else. */
  const cell = (value: string) => buildCsvContent([{ rows: [[value]] }]);

  // Values a spreadsheet reads as a number. Prefixing one makes the cell text,
  // which is the whole of issue #1134 -- the column stops adding up, and the
  // only visible symptom is a leading space nobody thinks to delete.
  it.each([
    ['-67.9900', 'an API decimal string'],
    ['-1652.7300', 'a four-figure debit'],
    ['38.5700', 'a credit'],
    ['-100', 'a whole negative'],
    ['-0.5', 'a fraction'],
    ['+42', 'an explicit plus'],
    ['-$1,652.73', 'formatted currency'],
    ['-1 652,73 €', 'formatted currency, French grouping'],
    ['-12.34%', 'a negative percentage'],
  ])('writes %s unguarded (%s)', (value) => {
    expect(cell(value)).not.toContain('\t');
  });

  // Everything else is text: the guard is what stops a spreadsheet running it.
  it.each([
    ["-1+cmd|'/c calc'!A0", 'DDE payload behind a minus'],
    ['=SUM(A1)', 'a formula'],
    ['+SUM(A1)', 'a formula behind a plus'],
    ['@SUM(A1)', 'a Lotus-style formula'],
    ['-HYPERLINK("http://evil","click")', 'a hyperlink payload'],
    ['-A1', 'a cell reference'],
    ['-1+1', 'arithmetic that is not a literal'],
    ['-', 'a bare sign'],
    ['--5', 'a doubled sign'],
    ['=1', 'the shortest formula there is'],
    ['-1.5e3', 'exponential text, which no export produces and `e` would open to -E1'],
  ])('guards %s (%s)', (value) => {
    // The tab goes inside the quoting, so match the cell's opening rather than
    // the value -- a payload carrying quotes has them doubled by then.
    expect(cell(value)).toMatch(/^"?\t/);
  });

  it('leaves a number alone whatever its sign', () => {
    expect(buildCsvContent([{ rows: [[-100, -1.5, 0, 42]] }])).toBe('-100,-1.5,0,42');
  });
});

describe('exportCsvSections', () => {
  let createObjectURL: any;

  beforeEach(() => {
    createObjectURL = vi.fn().mockReturnValue('blob:mock');
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, writable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), writable: true });
    vi.spyOn(document.body, 'appendChild').mockImplementation((node: any) => {
      if (node && node.tagName === 'A') (node as HTMLAnchorElement).click = vi.fn();
      return node;
    });
    vi.spyOn(document.body, 'removeChild').mockImplementation((node: any) => node);
  });

  it('separates sections with a blank line and writes each title above its table', () => {
    const content = buildCsvContent([
      { title: 'Projection', headers: ['Year', 'Median'], rows: [[2026, '-1.50']] },
      { title: 'Summary', headers: ['Statistic', 'Median'], rows: [['Ending balance', '-$1,652.73']] },
    ]);

    expect(content.split('\r\n')).toEqual([
      'Projection',
      'Year,Median',
      '2026,-1.50',
      '',
      'Summary',
      'Statistic,Median',
      'Ending balance,"-$1,652.73"',
    ]);
  });

  it('writes a header-only section and omits an absent title', () => {
    expect(buildCsvContent([{ headers: ['A', 'B'], rows: [] }])).toBe('A,B');
  });

  it('downloads the sections with a BOM and a .csv extension', async () => {
    exportCsvSections('monte-carlo-retirement', [{ headers: ['Year'], rows: [[2026]] }]);

    const blob = createObjectURL.mock.calls[0][0] as Blob;
    // `Blob.text()` decodes UTF-8 and swallows the BOM, so assert on the bytes:
    // it is there for Excel, which reads the file as the system codepage
    // without it.
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(await blob.text()).toBe('Year\r\n2026');
    expect(blob.type).toBe('text/csv;charset=utf-8;');
  });
});
