import { describe, it, expect } from 'vitest';
import {
  REGISTER_COLUMN_ORDER,
  REGISTER_COLUMN_PRIORITY,
  PRIORITY_MIN_WIDTH_PX,
  REGISTER_TABLE_CONTAINER,
  REGISTER_DESCRIPTION_CELL_FLEX,
  REGISTER_PAYEE_CELL_FLOOR,
  REGISTER_PAYEE_NAME_CAP,
  REGISTER_PAYEE_PRIORITY_SHARE,
  registerColumnClass,
  registerPayeeLayout,
  type RegisterColumnId,
} from './register-columns';
import { HIDEABLE_COLUMNS } from '@/lib/hidden-columns';

/**
 * Guard for the register's column contract (`register-columns.ts`).
 *
 * The defect this pins: each `<th>`/`<td>` used to carry its own hand-written
 * visibility class, and they drifted until the columns appeared in no
 * explicable order -- Status (ranked high) surfaced last of all at 1400px,
 * Attachments (ranked low) before Tags (ranked medium), and the Account
 * column rendered on single-account pages. The contract is only worth having
 * if a new cell cannot quietly opt back out of it, so this scans the two
 * register files for any visibility class that does not come from the module.
 */
const REGISTER_SOURCES = import.meta.glob(
  '/src/components/transactions/{TransactionList,TransactionRow}.tsx',
  { query: '?raw', eager: true, import: 'default' },
) as Record<string, string>;

/**
 * Blank out comments, keeping line numbering, so the scan reads CODE. The
 * prose documenting this rule has to name the banned pattern; a scan that
 * prose can trip is also a scan that prose can satisfy (the stripper is
 * tested in both directions below, per `loan-history.guard.test.ts`).
 *
 * Deliberately crude -- a `//` inside a string literal would be blanked too.
 * That direction is safe here: it can only hide code from the scan, and the
 * negative control below fails if the scan stops seeing a real class.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (line) => ' '.repeat(line.length));
}

/**
 * A hand-written responsive column-visibility class -- viewport variants and
 * container-query variants alike. The viewport forms are doubly banned: they
 * bypass the module AND they measure the wrong thing (the register sits
 * inside page padding, so viewport-keyed columns appeared before the table
 * could hold them and scrolled Status out from behind the sticky Actions).
 */
const HAND_WRITTEN_VISIBILITY =
  /hidden\s+@?(?:sm|md|lg|xl|2xl|min-\[\d+px\]):table-cell/;

describe('the register column contract', () => {
  it('resolves both register sources (an empty match set proves nothing)', () => {
    expect(Object.keys(REGISTER_SOURCES).sort()).toEqual([
      '/src/components/transactions/TransactionList.tsx',
      '/src/components/transactions/TransactionRow.tsx',
    ]);
  });

  it('strips comments but still sees code', () => {
    const stripped = withoutComments(
      [
        '// hidden lg:table-cell',
        '/* hidden lg:table-cell */',
        'const x = "hidden lg:table-cell";',
      ].join('\n'),
    );
    const lines = stripped.split('\n');
    expect(HAND_WRITTEN_VISIBILITY.test(lines[0])).toBe(false);
    expect(HAND_WRITTEN_VISIBILITY.test(lines[1])).toBe(false);
    expect(HAND_WRITTEN_VISIBILITY.test(lines[2])).toBe(true);
    // Line numbering must survive, or the offender report points at the
    // wrong line.
    expect(lines).toHaveLength(3);
  });

  it('takes every column-visibility class from register-columns.ts', () => {
    const offenders = Object.entries(REGISTER_SOURCES).flatMap(([path, content]) =>
      withoutComments(content)
        .split('\n')
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => HAND_WRITTEN_VISIBILITY.test(line))
        .map(({ line, number }) => `${path}:${number}: ${line.trim()}`),
    );

    expect(
      offenders,
      'A register cell must read its responsive visibility from ' +
        "registerColumnClass('<id>') so the column order and tiers stay one " +
        'table. Add or change a tier in register-columns.ts; never spell a ' +
        '`hidden *:table-cell` class in the register itself.',
    ).toEqual([]);
  });

  it('mentions the columns in the enforced order, header and row alike', () => {
    // The DOM order is the source order of the cells, so the order the
    // registerColumnClass('...') literals appear in each file is the order the
    // columns render in. Always-visible columns produce no class and so no
    // call; the enforced order still holds over the ones that do.
    for (const [path, content] of Object.entries(REGISTER_SOURCES)) {
      const mentioned = [
        ...withoutComments(content).matchAll(/registerColumnClass\('([a-zA-Z]+)'\)/g),
      ].map(([, id]) => id);

      expect(mentioned.length, `${path} uses the shared classes`).toBeGreaterThan(0);
      const expectedOrder = REGISTER_COLUMN_ORDER.filter((id) =>
        mentioned.includes(id),
      );
      expect(mentioned, `${path} keeps the enforced column order`).toEqual(
        expectedOrder,
      );
    }
  });

  it('assigns the priorities the spec names', () => {
    expect(REGISTER_COLUMN_PRIORITY).toEqual({
      date: 'always',
      account: 'high',
      payee: 'always',
      category: 'high',
      description: 'low',
      refNumber: 'low',
      tags: 'medium',
      attachments: 'low',
      amount: 'always',
      paidCurrency: 'always',
      paidAmount: 'always',
      feePaid: 'always',
      balance: 'always',
      status: 'high',
      actions: 'exceptPhones',
    } satisfies Record<RegisterColumnId, string>);
  });

  it('reveals the tiers in rank order as the register widens', () => {
    // "High before medium before low" is the whole point of the tiers; a
    // class-string edit that inverted two breakpoints would otherwise pass.
    expect(PRIORITY_MIN_WIDTH_PX.always).toBe(0);
    expect(PRIORITY_MIN_WIDTH_PX.high).toBeLessThan(PRIORITY_MIN_WIDTH_PX.medium);
    expect(PRIORITY_MIN_WIDTH_PX.medium).toBeLessThan(PRIORITY_MIN_WIDTH_PX.low);
    // And the classes agree with the table the assertion above trusted. They
    // must be CONTAINER-QUERY variants (`@min-[...]`): a viewport variant
    // measures the window, which overstates the register's width by the page
    // padding around it -- the defect that scrolled Status out of view.
    const widthOfClass = (cls: string): number => {
      if (cls === '') return 0;
      const match = cls.match(/^hidden @min-\[(\d+)px\]:table-cell$/);
      expect(match, `container-query visibility class: ${cls}`).toBeTruthy();
      return Number(match![1]);
    };
    for (const id of REGISTER_COLUMN_ORDER) {
      expect(widthOfClass(registerColumnClass(id)), id).toBe(
        PRIORITY_MIN_WIDTH_PX[REGISTER_COLUMN_PRIORITY[id]],
      );
    }
  });

  it('never hides an always column and always renders a class string', () => {
    for (const id of REGISTER_COLUMN_ORDER) {
      const cls = registerColumnClass(id);
      expect(typeof cls, id).toBe('string');
      if (REGISTER_COLUMN_PRIORITY[id] === 'always') {
        expect(cls, `${id} is part of what a register is`).toBe('');
      } else {
        expect(cls, `${id} is a real responsive class`).toMatch(
          HAND_WRITTEN_VISIBILITY,
        );
      }
    }
  });

  it('gives the tier classes a container to measure', () => {
    // Every `@min-[...]` variant matches against the nearest @container
    // ancestor; without one on the scroll wrapper the hideable columns
    // silently never appear at any width.
    expect(REGISTER_TABLE_CONTAINER).toBe('@container');
    const list = withoutComments(
      REGISTER_SOURCES['/src/components/transactions/TransactionList.tsx'],
    );
    expect(
      /overflow-x-auto \$\{REGISTER_TABLE_CONTAINER\}/.test(list),
      'TransactionList marks the overflow-x-auto wrapper as the register container',
    ).toBe(true);
  });

  it('makes Description the column that yields', () => {
    // `w-full` hands Description the width the content-sized columns leave;
    // `max-w-0` lets it shrink below its own content so the inner truncate
    // ellipsizes. Together they are what keeps a low-tier column's arrival
    // from overflowing the table and scrolling Status out from behind the
    // sticky Actions column -- the register squeezes Description instead.
    expect(REGISTER_DESCRIPTION_CELL_FLEX.split(' ').sort()).toEqual([
      'max-w-0',
      'w-full',
    ]);
    const row = withoutComments(
      REGISTER_SOURCES['/src/components/transactions/TransactionRow.tsx'],
    );
    const descriptionCellLine = row
      .split('\n')
      .find((line) => line.includes("registerColumnClass('description')"));
    expect(descriptionCellLine, 'the description cell exists').toBeTruthy();
    expect(
      descriptionCellLine!.includes('REGISTER_DESCRIPTION_CELL_FLEX'),
      'the description cell carries the yield classes',
    ).toBe(true);
  });

  it('lets the payee outrank Description for width', () => {
    // The payee cap is never a fixed pixel figure -- fixed is what kept the
    // longest payees truncated at 280px however wide the register grew. It
    // scales with the register in cqw, with a px floor.
    const shape = REGISTER_PAYEE_NAME_CAP.match(/^sm:max-w-\[max\((\d+)px,(\d+)cqw\)\]$/);
    expect(shape, 'a scaling cap with a px floor').toBeTruthy();
    const [, floorPx] = shape!.map(Number);
    expect(floorPx, 'no register width renders less payee than the old fixed cap did')
      .toBeGreaterThanOrEqual(280);

    // Description's `w-full` takes every pixel above the other columns'
    // min-content, so once it is on screen the single-line payee only keeps
    // what its own min-content claims. The priority share is that claim: the
    // name's full width (`w-max`) up to everything but a reserve for the rest
    // of the row, never less than a share. It switches on exactly where
    // Description appears (the literal must repeat the low tier, since
    // Tailwind's scanner only sees complete class names). Its minimum sits
    // above the floor's share or it adds nothing, and below a quarter of the
    // register, because Description can only yield down to its padding and a
    // larger claim at 1536px overflows the table and hides Amount again; the
    // reserve is what keeps the growing part inside the register.
    const priority = REGISTER_PAYEE_PRIORITY_SHARE.match(
      /^@min-\[(\d+)px\]:w-max @min-\[(\d+)px\]:max-w-\[max\((\d+)cqw,calc\(100cqw_-_(\d+)px\)\)\]$/,
    );
    expect(priority, 'full width up to what the row leaves, from a container width').toBeTruthy();
    const [, widthAt, capAt, share, reservePx] = priority!.map(Number);
    expect(widthAt, 'the claim starts exactly where Description appears').toBe(
      PRIORITY_MIN_WIDTH_PX.low,
    );
    expect(capAt, 'and is bounded from the same width').toBe(PRIORITY_MIN_WIDTH_PX.low);
    const floorShare = Number(REGISTER_PAYEE_CELL_FLOOR.match(/(\d+)cqw/)![1]);
    expect(share, 'the claim gives the payee more than its floor').toBeGreaterThan(floorShare);
    expect(share, 'and leaves the other columns their room').toBeLessThan(25);
    expect(
      PRIORITY_MIN_WIDTH_PX.low - reservePx,
      'at the tier itself the reserve alone would leave the payee less than the minimum share',
    ).toBeLessThan((PRIORITY_MIN_WIDTH_PX.low * share) / 100);

    const row = withoutComments(
      REGISTER_SOURCES['/src/components/transactions/TransactionRow.tsx'],
    );
    // Both payee renderings (the filter button and the plain name) wear the
    // shared classes -- the cap drifting on one of the two is how the last
    // hand-written pair got out of sync with the contract.
    const uses = row.match(/REGISTER_PAYEE_NAME_CAP/g) ?? [];
    expect(uses.length, 'both payee name renderings use the shared cap').toBeGreaterThanOrEqual(3); // import + 2 uses

    // And no register file reintroduces a hand-written payee-style cap.
    const offenders = Object.entries(REGISTER_SOURCES).flatMap(([path, content]) =>
      withoutComments(content)
        .split('\n')
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => /sm:max-w-\[/.test(line))
        .map(({ line, number }) => `${path}:${number}: ${line.trim()}`),
    );
    expect(
      offenders,
      'A width cap on the payee name comes from REGISTER_PAYEE_NAME_CAP, ' +
        'never a hand-written sm:max-w-[...] -- a fixed cap is what kept the ' +
        'longest payee from rendering while Description held the slack.',
    ).toEqual([]);
  });

  it('lets a long payee wrap or ellipsize, never widen the table', () => {
    // A nowrap `truncate` name counts its full width (up to the 35cqw cap)
    // in the column's min-content, so with the Account column showing the
    // table outgrew its container and Amount scrolled out from behind the
    // sticky Actions column (issue #1470). Normal wraps: `wrap-anywhere`, not
    // `break-words`, is what lowers the min-content. Compact and Dense keep
    // one line inside `minmax(0, max-content)` tracks, whose min-content is 0.
    const normal = registerPayeeLayout('normal');
    expect(normal.name.split(' ')).toContain('sm:wrap-anywhere');
    expect(normal.name.split(' ')).not.toContain('truncate');
    for (const density of ['compact', 'dense'] as const) {
      const layout = registerPayeeLayout(density);
      expect(layout.name).toContain('truncate');
      expect(layout.container.split(' ')).toContain('sm:grid');
      expect(layout.container).toContain('sm:auto-cols-[minmax(0,max-content)]');
      // From the low tier the payee outranks Description instead: a flex row
      // and a name whose min-content claims its width up to the share.
      expect(layout.container).toContain(`@min-[${PRIORITY_MIN_WIDTH_PX.low}px]:flex`);
      expect(layout.name).toContain(REGISTER_PAYEE_PRIORITY_SHARE);
    }
    // Normal wraps the name inside whatever width the column gets.
    expect(normal.name).not.toContain(REGISTER_PAYEE_PRIORITY_SHARE);

    // Below `sm` (phones) every density keeps the original single-line
    // payee: a plain `truncate` in a flex row, whose min-content holds the
    // cell open to its phone cap and lets the table scroll to Balance. A
    // phone payee allowed to shrink to nothing was unreadable at Compact and
    // Dense. So nothing that lowers the min-content may apply unprefixed.
    expect(normal.name).toContain('max-sm:truncate');
    expect(normal.name).not.toMatch(/(^|\s)wrap-anywhere/);
    for (const density of ['normal', 'compact', 'dense'] as const) {
      const layout = registerPayeeLayout(density);
      expect(layout.container.split(' ')).toContain('flex');
      expect(layout.container).not.toMatch(/(^|\s)(grid|grid-flow-col|auto-cols-\S+)(\s|$)/);
    }

    // The row takes both halves from the helper, so a hand-written
    // `truncate` beside the cap cannot quietly come back.
    const row = withoutComments(
      REGISTER_SOURCES['/src/components/transactions/TransactionRow.tsx'],
    );
    expect(row).toContain('registerPayeeLayout(density)');
    expect(row).not.toMatch(/truncate \$\{REGISTER_PAYEE_NAME_CAP\}/);
    expect(row.match(/\$\{payeeLayout\.name\} \$\{REGISTER_PAYEE_NAME_CAP\}/g) ?? []).toHaveLength(2);
  });

  it('floors the payee column so Description cannot take what it needs', () => {
    // The defect: `w-full` on Description is a claim on 100% of the table,
    // and an auto-layout table settles that claim against the content columns
    // in PROPORTION TO THEIR CONTENT -- it does not merely mop up the spare
    // width. So filtering the register to one payee, which shortens Payee,
    // Category, Ref # and the amounts together, handed Description the
    // difference: measured on a 1710px register, Payee 270px -> 212px and
    // Description 386px -> 517px, truncating the payee that had just been
    // filtered for while Description rendered a column of "-". A floor on the
    // payee column is what makes Description absorb only the leftover.
    const shape = REGISTER_PAYEE_CELL_FLOOR.match(
      /^sm:min-w-\[max\((\d+)px,(\d+)cqw\)\]$/,
    );
    expect(shape, 'a scaling floor with a px minimum, from `sm` up').toBeTruthy();
    const [, floorPx, floorShare] = shape!.map(Number);

    // `sm:` is not decoration. `min-width` beats `max-width`, so an unscoped
    // floor would override the payee cell's phone caps (max-w-[100px] /
    // max-w-[160px]) and blow the phone layout open.
    expect(REGISTER_PAYEE_CELL_FLOOR.startsWith('sm:')).toBe(true);

    // A floor is what the payee is guaranteed; the cap is how far it may
    // grow. A floor that reached the cap would freeze the column at one width
    // and pad it with blank space whenever the payees are short.
    const capShape = REGISTER_PAYEE_NAME_CAP.match(
      /^sm:max-w-\[max\((\d+)px,(\d+)cqw\)\]/,
    );
    expect(capShape, 'the cap still has the shape this compares against').toBeTruthy();
    const [, capFloorPx, capBaseShare] = capShape!.map(Number);
    expect(floorShare, 'the floor stays below the cap it lives under').toBeLessThan(
      capBaseShare,
    );
    expect(floorPx, 'and its px minimum does too').toBeLessThan(capFloorPx);
    expect(floorPx, 'but is still wide enough to read a payee in').toBeGreaterThanOrEqual(
      200,
    );

    // Both register files carry it: the header and the cells decide one
    // column's minimum between them, so a `<th>` without the floor would put
    // the label and the values it labels over different columns.
    for (const [path, content] of Object.entries(REGISTER_SOURCES)) {
      expect(
        withoutComments(content).includes('REGISTER_PAYEE_CELL_FLOOR'),
        `${path} floors the payee column from the shared constant`,
      ).toBe(true);
    }

    // And no register file hand-writes one instead.
    const offenders = Object.entries(REGISTER_SOURCES).flatMap(([path, content]) =>
      withoutComments(content)
        .split('\n')
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => /sm:min-w-\[/.test(line))
        .map(({ line, number }) => `${path}:${number}: ${line.trim()}`),
    );
    expect(
      offenders,
      'The payee column floor comes from REGISTER_PAYEE_CELL_FLOOR, never a ' +
        'hand-written sm:min-w-[...] -- the header and the row have to agree ' +
        'on it, and two copies are how they stop agreeing.',
    ).toEqual([]);
  });

  it('gates the Account column structurally, not with CSS', () => {
    // "Only if multi-accounts selected" is a DOM decision: on a single
    // account's page the column must not exist at any width. Both files carry
    // the guard -- a header without its cells (or vice versa) misaligns every
    // column after it.
    for (const [path, content] of Object.entries(REGISTER_SOURCES)) {
      const code = withoutComments(content);
      const gate = /\{!isSingleAccountView && \(/;
      expect(gate.test(code), `${path} renders Account only for multi-account views`).toBe(
        true,
      );
    }
  });

  describe('the hideable columns', () => {
    // The register's hideable set (`lib/hidden-columns.ts`, the one list both
    // layers declare) and the structural ids this guard names outright: the
    // ids that say what a row IS, which no preference may remove. Category is
    // structural by the maintainer's call -- its cell carries the transfer
    // arrow, the split marker and the linked-investment pill.
    const hideable: readonly string[] = HIDEABLE_COLUMNS.transactions;
    const STRUCTURAL = [
      'date',
      'account',
      'payee',
      'category',
      'amount',
      'paidCurrency',
      'paidAmount',
      'feePaid',
      'balance',
      'actions',
    ] as const satisfies readonly RegisterColumnId[];

    /** The line the element's gate would be on: the nearest code line above. */
    function codeLineBefore(lines: string[], index: number): string {
      for (let i = index - 1; i >= 0; i -= 1) {
        if (lines[i].trim() !== '') return lines[i];
      }
      return '';
    }

    /** The opening tag of the cell whose class is on `index`, which may be above it. */
    function openingTagIndex(lines: string[], index: number): number {
      for (let i = index; i >= 0; i -= 1) {
        if (/^\s*<(th|td|RegisterHeader)\b/.test(lines[i])) return i;
      }
      throw new Error(`no opening tag above line ${index + 1}`);
    }

    it('are a subset of the column order, disjoint from the structural ids, in order', () => {
      expect(hideable).toEqual(REGISTER_COLUMN_ORDER.filter((id) => hideable.includes(id)));
      expect(hideable.length).toBeGreaterThan(0);
      for (const id of STRUCTURAL) {
        expect(hideable, `${id} says what a row is`).not.toContain(id);
      }
      // Together they are the whole contract: a column added to the order
      // has to be declared one or the other.
      expect([...STRUCTURAL, ...hideable].sort()).toEqual([...REGISTER_COLUMN_ORDER].sort());
    });

    it('gates every hideable cell, and no structural one, in both files', () => {
      // Hidden is ABSENT from the DOM, never a class: the cell is wrapped in
      // `isVisible('<id>') && (` on the line before its opening tag. A
      // hideable cell left ungated renders a column the reader turned off; a
      // structural cell gated could be removed by a stored id the validator
      // was never told about.
      for (const [path, content] of Object.entries(REGISTER_SOURCES)) {
        const code = withoutComments(content);
        const lines = code.split('\n');
        const cellLines = (id: string) =>
          lines
            .map((line, index) => ({ line, index }))
            .filter(({ line }) => line.includes(`registerColumnClass('${id}')`));

        for (const id of hideable) {
          expect(code, `${path} gates ${id}`).toContain(`isVisible('${id}') &&`);
          for (const { index } of cellLines(id)) {
            const opening = openingTagIndex(lines, index);
            expect(
              codeLineBefore(lines, opening),
              `${path}:${opening + 1}: the ${id} cell sits under its isVisible('${id}') && ( gate`,
            ).toContain(`isVisible('${id}') &&`);
          }
        }
        for (const id of STRUCTURAL) {
          expect(code, `${path} never gates ${id} on the hidden set`).not.toContain(
            `isVisible('${id}')`,
          );
          for (const { index } of cellLines(id)) {
            const opening = openingTagIndex(lines, index);
            expect(
              codeLineBefore(lines, opening),
              `${path}:${opening + 1}: the ${id} cell is structural`,
            ).not.toContain('isVisible(');
          }
        }
      }
    });

    it("gates the phone card's status pill, attachment badge and tags line", () => {
      // The card carries status, attachments and tags (description and ref #
      // are not on it), so each of those three is gated twice in the row --
      // once in the tier cell, once on the card -- and the other two once.
      const row = withoutComments(
        REGISTER_SOURCES['/src/components/transactions/TransactionRow.tsx'],
      );
      const gates = (id: string) =>
        (row.match(new RegExp(`isVisible\\('${id}'\\) &&`, 'g')) ?? []).length;
      expect(gates('status'), 'status: tier cell and card pill').toBe(2);
      expect(gates('attachments'), 'attachments: tier cell and card badge').toBe(2);
      expect(gates('tags'), 'tags: tier cell and card line').toBe(2);
      expect(gates('description'), 'description is not on the card').toBe(1);
      expect(gates('refNumber'), 'ref # is not on the card').toBe(1);
    });

    it('reads the hidden set once, in the list; the row takes it as a prop', () => {
      // One read per list: the memoised row would re-render on every list
      // render if it took a fresh callback, and a second read of the store
      // is a second place to get the table kind wrong.
      const list = withoutComments(
        REGISTER_SOURCES['/src/components/transactions/TransactionList.tsx'],
      );
      const row = withoutComments(
        REGISTER_SOURCES['/src/components/transactions/TransactionRow.tsx'],
      );
      expect(list.match(/useHiddenColumns\('transactions'\)/g) ?? []).toHaveLength(1);
      expect(list).toContain('hidden={hiddenColumns}');
      expect(row).not.toContain('useHiddenColumns');
      expect(row).toContain('hidden?: ReadonlySet<string>');
    });
  });
});
