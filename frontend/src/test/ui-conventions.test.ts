import { describe, it, expect } from "vitest";

/**
 * Guard tests for the UI conventions in `frontend/CLAUDE.md`.
 *
 * These exist because a documented rule is only as good as its enforcement. Each
 * one was added after an agent reached for the generic solution, a human spotted
 * it in the running app, and the fix landed in a single file. A test that scans
 * the whole source tree catches the next instance wherever it appears, which a
 * test around the one component that was fixed cannot.
 *
 * Add a case here whenever a *mechanical* mistake gets corrected -- a raw element
 * used where a shared component exists. Judgement calls (is this list long enough
 * to need paging?) stay in prose; only checkable rules belong here.
 *
 * Modelled on `src/lib/tours/anchors.uniqueness.test.ts`, which scans the tree the
 * same way for detached tour anchors.
 */
const sources = import.meta.glob("/src/**/*.{ts,tsx}", {
  query: "?raw",
  eager: true,
  import: "default",
}) as Record<string, string>;

/** Source files only: tests legitimately contain the markup they assert on. */
function productionSources(): [string, string][] {
  return Object.entries(sources).filter(
    ([path]) => !/\.test\.tsx?$/.test(path),
  );
}

describe("date entry goes through DateInput", () => {
  /** The one file allowed to hold a raw date input -- it *is* the wrapper. */
  const WRAPPER = "/src/components/ui/DateInput.tsx";
  const RAW_DATE_INPUT = /type=["']date["']/;

  it('has no raw <input type="date"> outside the shared component', () => {
    const offenders = productionSources()
      .filter(([path]) => path !== WRAPPER)
      .filter(([, content]) => RAW_DATE_INPUT.test(content))
      .map(([path]) => path);

    // A bare date input misses the lenient parsing, the shortcuts and
    // `CalendarPopover`, and hands the user the browser's own segment-jumping
    // entry -- which is the thing issue #1201 was about.
    expect(offenders).toEqual([]);
  });

  it("still finds the wrapper, so the rule cannot pass by accident", () => {
    // Were DateInput renamed, or were it to stop using a native date input, the
    // check above would trivially pass over an empty set. This fails first and
    // says what to update.
    const wrapper = sources[WRAPPER];
    expect(
      wrapper,
      `${WRAPPER} not found -- update WRAPPER in this test`,
    ).toBeTruthy();
    expect(RAW_DATE_INPUT.test(wrapper)).toBe(true);
  });
});

describe('numeric entry goes through NumericInput or CurrencyInput', () => {
  /**
   * `type="number"` is not exclusive to inputs -- recharts' `<XAxis type="number">`
   * declares a continuous scale and appears in roughly twenty chart components.
   * So the check is not "does this file contain the string": it walks back from
   * each occurrence to the tag it belongs to and only complains about `input`
   * (the raw element) and `Input` (the shared text field). Anything else --
   * `XAxis`, `YAxis`, a future chart prop -- is left alone.
   */
  const TYPE_NUMBER = /type=["']number["']/g;

  /** The JSX tag an attribute at `index` belongs to, or null if unparseable. */
  function owningTag(content: string, index: number): string | null {
    const open = content.lastIndexOf('<', index);
    if (open === -1) return null;
    return /^<\s*([A-Za-z][\w.]*)/.exec(content.slice(open, index))?.[1] ?? null;
  }

  const NUMERIC_ENTRY_TAGS = new Set(['input', 'Input']);

  it('has no <input type="number"> anywhere in the source tree', () => {
    const offenders: string[] = [];
    for (const [path, content] of productionSources()) {
      for (const match of content.matchAll(TYPE_NUMBER)) {
        const tag = owningTag(content, match.index);
        if (tag && NUMERIC_ENTRY_TAGS.has(tag)) {
          offenders.push(`${path}: <${tag} type="number">`);
        }
      }
    }

    // A native number input adds spinner arrows, changes value on scroll wheel,
    // and hands the form a locale-dependent parse of what was typed. Money goes
    // through `CurrencyInput` (thousands separators, rounding to cents, the
    // inline calculator); every other number -- share counts, rates, day-of-month,
    // retention counts -- through `NumericInput` with `decimalPlaces`.
    expect(offenders).toEqual([]);
  });

  it('still resolves the tag an attribute belongs to', () => {
    // Were `owningTag` to start returning null -- a bad edit, a JSX form it
    // cannot walk -- the check above would pass over an empty set. Assert both
    // halves: the raw input is caught, the recharts axis is not.
    const sample = [
      '<input type="number" min={0} />',
      '<XAxis dataKey="t" type="number" scale="time" />',
    ].join('\n');
    const tags = [...sample.matchAll(TYPE_NUMBER)].map((m) => owningTag(sample, m.index));
    expect(tags).toEqual(['input', 'XAxis']);
  });
});

describe('every password field says what may be autofilled into it', () => {
  /**
   * A `type="password"` box with no `autoComplete` is an open invitation to the
   * browser's saved credential for this origin, and the field is not always
   * asking for that credential. The AI provider's API key is the case that bit:
   * the edit form sends `apiKey` whenever the box is non-empty, so a manager
   * filling it silently replaced the stored provider key on the next save -- the
   * user sees "saved" and the provider stops working. The backup export password
   * is the same shape and worse, because the artifact is then encrypted under a
   * password nobody knows.
   *
   * So every password input declares its intent. Three answers, and which one is
   * right is a judgement about the field, not something a scan can decide:
   *
   *   - `current-password` -- it really is this account's password (a re-auth
   *     prompt, the confirm-before-delete box). Autofill is correct and helpful.
   *   - `new-password`     -- a password being set or changed here.
   *   - `off`              -- not a credential of this site at all: an API key,
   *     a backup artifact's password.
   *
   * The scan only insists that the decision was made and written down.
   */
  const PASSWORD_TYPE = /type=["']password["']/g;

  /** Values that answer the question. Anything else is a typo or a guess. */
  const DECLARED = new Set(['off', 'new-password', 'current-password']);

  /**
   * The source of the JSX element an attribute at `index` belongs to.
   *
   * Walks back to the element's `<` and forward to the `>` that closes its
   * opening tag, skipping any `>` inside a `{...}` expression (an arrow function
   * in an `onKeyDown` handler is the common one, and `owningTag` above stops at
   * the tag name so it cannot be reused here). Returns null when the tag cannot
   * be delimited, which the paired test below proves does not happen silently.
   */
  function owningElement(content: string, index: number): string | null {
    const open = content.lastIndexOf('<', index);
    if (open === -1) return null;
    let depth = 0;
    for (let i = open; i < content.length; i += 1) {
      const ch = content[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      else if (ch === '>' && depth === 0) return content.slice(open, i + 1);
    }
    return null;
  }

  const passwordElements = (): { path: string; element: string }[] => {
    const found: { path: string; element: string }[] = [];
    for (const [path, content] of productionSources()) {
      for (const match of content.matchAll(PASSWORD_TYPE)) {
        const element = owningElement(content, match.index);
        found.push({ path, element: element ?? '' });
      }
    }
    return found;
  };

  it('declares an autoComplete on every password input', () => {
    const offenders = passwordElements()
      .filter(({ element }) => !/\bautoComplete\s*=/.test(element))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it('uses only the three values that answer the question', () => {
    const offenders: string[] = [];
    for (const { path, element } of passwordElements()) {
      const value = /\bautoComplete\s*=\s*["']([^"']*)["']/.exec(element)?.[1];
      if (value !== undefined && !DECLARED.has(value)) {
        offenders.push(`${path}: autoComplete="${value}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('finds the password fields, so the rule cannot pass over an empty set', () => {
    // Were the shared `Input` to stop taking `type="password"`, or were the
    // regex to rot, both checks above would trivially pass. The app has a
    // login, a change-password form and a re-auth modal at minimum.
    expect(passwordElements().length).toBeGreaterThan(5);
    expect(passwordElements().every(({ element }) => element !== '')).toBe(true);
  });

  it('delimits an element whose props contain a `>` inside an expression', () => {
    // The restore and export boxes both carry an `onKeyDown` arrow function, so
    // a naive "first `>` after the `<`" would cut the element short and report a
    // false offender. Assert the walker handles it.
    const sample =
      '<Input type="password" onKeyDown={(e) => run(e)} autoComplete="off" />';
    const element = owningElement(sample, sample.indexOf('type='));
    expect(element).toBe(sample);
    expect(/\bautoComplete\s*=/.test(element ?? '')).toBe(true);
  });
});

describe("a scrollbar you need is not hidden", () => {
  /**
   * `scrollbar-hide` is for a horizontal strip of chips, where the content being
   * cut off is itself the signal that there is more. On a vertical list it hides
   * the only indication that rows exist below the fold, which is strictly worse
   * than the plain bar someone was trying to get rid of. The fix for an ugly bar
   * is `scrollbar-slim`, not no bar.
   *
   * Matched per class attribute rather than per file, so an unrelated
   * `scrollbar-hide` elsewhere in the same component does not trip it.
   */
  const CLASS_ATTR = /class(?:Name)?=(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\})/g;

  it("never puts scrollbar-hide on a vertically scrolling element", () => {
    const offenders: string[] = [];
    for (const [path, content] of productionSources()) {
      for (const match of content.matchAll(CLASS_ATTR)) {
        const classes = match[1] ?? match[2] ?? match[3] ?? "";
        if (
          classes.includes("scrollbar-hide") &&
          /\boverflow-y-(auto|scroll)\b/.test(classes)
        ) {
          offenders.push(`${path}: ${classes.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("chart colours come from the theme tokens", () => {
  /**
   * `src/lib/chart-colors.ts` exposes `var(--chart-*)` strings so a chart
   * follows the active colour theme and light/dark mode with no JS. A literal
   * `fill="#22c55e"` looks correct on the default palette and then stays that
   * exact green on all twenty-odd themes -- the charts were the last thing on
   * screen still doing it.
   *
   * Matched per colour prop rather than per file, because the same components
   * legitimately hold hex for the PDF export: `pdf-export.ts` parses
   * `summaryCards[].color` as hex, and a `var(...)` there produces NaN. Those
   * are `color:` keys and never reach a chart.
   *
   * The value is captured whole (`{...}`, `"..."`, `'...'`) so a conditional
   * like `fill={up ? '#16a34a' : '#dc2626'}` is caught too, not just the
   * literal-valued form.
   */
  const COLOUR_PROP =
    /\b(fill|stroke|stopColor)\s*[=:]\s*(\{[^{}]*\}|"[^"]*"|'[^']*')/g;
  const HEX = /#[0-9a-fA-F]{3,8}\b/;

  /**
   * Drawn on top of a filled flag bubble rather than on the card, so these are
   * contrast against the fill -- white is the point. `chartColors.surface`
   * would make them the card colour and so invisible on the bubble in dark
   * mode. The only exemption; anything new needs its own reason here.
   */
  const ON_FILL_WHITE = "/src/components/investments/portfolio-chart-utils.tsx";

  it("never hardcodes a hex colour on a chart fill or stroke", () => {
    const offenders: string[] = [];
    for (const [path, content] of productionSources()) {
      if (!/from ['"]recharts['"]/.test(content)) continue;
      for (const match of content.matchAll(COLOUR_PROP)) {
        if (!HEX.test(match[2])) continue;
        // The bubble text/divider/cross, and nothing else in that file.
        if (path === ON_FILL_WHITE && /#fff\b/.test(match[2])) continue;
        offenders.push(`${path}: ${match[0].trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("still matches the colour props it is meant to police", () => {
    // Were the regex to stop matching -- a Recharts rename, a bad edit -- the
    // check above would pass over an empty set. This fails first and says so.
    const sample = `fill="#22c55e" stroke={up ? '#16a34a' : '#dc2626'}`;
    const hits = [...sample.matchAll(COLOUR_PROP)].filter((m) =>
      HEX.test(m[2]),
    );
    expect(hits).toHaveLength(2);
  });
});

describe('a control sitting beside an input is the height of that input', () => {
  /**
   * `CurrencyPickerButton` is the square button left of an Amount field. It has
   * no vertical padding and no height of its own, so its height comes entirely
   * from the flex row. That made it a two-part rule that was easy to half-apply:
   * the button needs `self-stretch`, and the row it sits in needs
   * `items-stretch` with a `min-w-0` sibling. Getting either wrong renders a
   * squat button beside a full-height input, which is what a human had to point
   * out on the Bills & Deposits form.
   *
   * Both halves are checked: `self-stretch` on the button makes it correct
   * whatever the wrapper does, and the row check keeps the two existing call
   * sites (and any new one) on the same layout.
   */
  const BUTTON = '/src/components/transactions/CurrencyPickerButton.tsx';

  it('gives CurrencyPickerButton self-stretch, so any wrapper renders it full height', () => {
    const source = sources[BUTTON];
    expect(source, `${BUTTON} not found -- update BUTTON in this test`).toBeTruthy();
    // Guard against the class being dropped in a future restyle: align-self
    // beats the parent's align-items, so this is what makes the button
    // independent of how it is laid out.
    expect(source).toMatch(/className="[^"]*\bself-stretch\b/);
  });

  it('renders the picker only inside an items-stretch row', () => {
    const ROW = /<div className="flex items-stretch space-x-2">/;
    // Building the picker and handing it down as `currencyPickerSlot={...}` is
    // not laying it out -- TransactionForm does exactly that, and the row lives
    // in NormalTransactionFields / SplitTransactionFields, which receive it. So
    // a file that passes the slot on is a producer, and the check applies to
    // whoever actually renders it beside an input.
    const HANDS_OFF = /currencyPickerSlot=\{/;
    const offenders = productionSources()
      .filter(([path]) => path !== BUTTON)
      .filter(
        ([, content]) =>
          /<CurrencyPickerButton\b/.test(content) || /\{currencyPickerSlot\}/.test(content),
      )
      .filter(([, content]) => !HANDS_OFF.test(content))
      .filter(([, content]) => !ROW.test(content))
      .map(([path]) => path);

    // `items-start` (or the default `stretch` being overridden) leaves the
    // button at its content height. Use the same row the other call sites do.
    expect(offenders).toEqual([]);
  });
});

describe('the GEM report links through its shared wrappers', () => {
  /**
   * Every account and instrument the report names is a way into that account
   * or instrument, and they all have to look the same doing it. A hand-rolled
   * `<Link>` in one card gets its own colour and its own hover, which is how
   * the report ended up with permanently blue anchors in one tab and plain
   * text everywhere else. `GemSecurityLink` / `GemAccountLink` in
   * `GemPrimitives.tsx` are the only place that markup lives.
   */
  const WRAPPERS = "/src/components/strategies/GemPrimitives.tsx";

  it("has no ad-hoc security or account link in a strategy component", () => {
    const offenders = productionSources()
      .filter(
        ([path]) =>
          path.startsWith("/src/components/strategies/") && path !== WRAPPERS,
      )
      .filter(([, source]) => /href={`\/(securities|accounts)\//.test(source))
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });
});

describe("a tab bar is the shared Tabs component", () => {
  /**
   * `ui/Tabs.tsx` is the only tablist in the app. It carries the roving
   * tabindex, the arrow/Home/End keys, the horizontal scroll and the `pb-px`
   * that keeps a stray vertical scrollbar off the row, plus the id convention
   * (`tabId`/`tabPanelId`) a panel points back at.
   *
   * The rule is a scan because a second tablist is never wrong on its own file's
   * terms -- it simply re-derives all of that, and drops some of it. The GEM
   * report's hand-rolled bar set `aria-controls` on all five tabs while only the
   * selected tab's panel is rendered, so four of them named an element that was
   * not in the document. `Tabs.tsx` sets the attribute for the selected tab
   * only, with a comment saying why; that is the fix a call site inherits by
   * using it.
   */
  const SHARED = "/src/components/ui/Tabs.tsx";
  const TABLIST = /role=["']tablist["']/;

  it("declares role=tablist in exactly one place", () => {
    const offenders = productionSources()
      .filter(([path]) => path !== SHARED)
      .filter(([, source]) => TABLIST.test(source))
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });

  it("still finds the shared tablist, so the rule cannot pass by accident", () => {
    const shared = sources[SHARED];
    expect(
      shared,
      `${SHARED} not found -- update SHARED in this test`,
    ).toBeTruthy();
    expect(TABLIST.test(shared)).toBe(true);
  });
});

describe("the way back to a section list is the shared link", () => {
  /**
   * Every report page returns to the list the same way: a chevron and "Back to
   * Reports" above the title, matching the account, payee, category and
   * security detail pages. `BackToReportsLink` is that control. The rule is a
   * scan because a hand-rolled one is never wrong on its own file's terms --
   * the GEM report had a breadcrumb, the two report viewers had an outline
   * button among their actions, and each looked deliberate until they were on
   * screen next to each other.
   *
   * Matched on the pair (a back chevron *and* a link to `/reports`), so the
   * editor pages' "Back to Reports" cancel button -- which is an action on a
   * form, not the way out of a detail page -- is deliberately left alone.
   */
  const SHARED = "/src/components/reports/BackToReportsLink.tsx";
  const REPORTS_HREF = /href=["']\/reports["']/;
  const BACK_CHEVRON = /<ChevronLeftIcon\b/;

  it("has no hand-rolled back-to-reports link", () => {
    const offenders = productionSources()
      .filter(([path]) => path !== SHARED)
      .filter(
        ([, source]) => REPORTS_HREF.test(source) && BACK_CHEVRON.test(source),
      )
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });

  it("still finds the shared link, so the rule cannot pass by accident", () => {
    const shared = sources[SHARED];
    expect(shared, `${SHARED} not found -- update SHARED in this test`).toBeTruthy();
    expect(REPORTS_HREF.test(shared)).toBe(true);
    expect(BACK_CHEVRON.test(shared)).toBe(true);
  });
});

describe("nothing interactive is nested inside a button", () => {
  /**
   * `<button>`'s content model forbids interactive descendants, and the
   * failure is not cosmetic: the parser closes the outer button at the inner
   * tag, so the click target is truncated to whatever preceded it and the
   * server's markup no longer matches what React builds on the client.
   *
   * This landed the moment `InfoTooltip`'s trigger changed from a `<span>` to
   * a `<button>` -- correct in isolation, and it broke the one card that had
   * put a tooltip inside a clickable card. That is the shape of mistake a
   * scan catches and a component test cannot: neither file is wrong on its
   * own, only the pair is, and the pair is discovered by grepping.
   *
   * Fix it at the call site by making the two siblings, not by demoting the
   * inner control to a non-focusable element -- a tab stop that announces
   * nothing is how `InfoTooltip` got here in the first place.
   */
  const INTERACTIVE = /<(button|a|select|textarea|input|InfoTooltip)[\s/>]/g;

  /**
   * Blank out comment bodies, keeping the file's length and line breaks so
   * reported line numbers still point at the source. Prose in this repo
   * discusses `<button>` constantly, and a scan that reads its own
   * explanation as a violation is worse than no scan.
   */
  function withoutComments(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
      .replace(
        /(^|[^:])\/\/[^\n]*/g,
        (match, before: string) =>
          before + " ".repeat(match.length - before.length),
      );
  }

  /** [start, end) of every non-self-closing `<button>` element's children. */
  function buttonBodies(source: string): Array<[number, number]> {
    const bodies: Array<[number, number]> = [];
    const opens = /<button(?=[\s/>])/g;
    let open: RegExpExecArray | null;
    while ((open = opens.exec(source))) {
      const tagEnd = source.indexOf(">", open.index);
      if (tagEnd === -1) continue;
      // `<button ... />` has no children to search.
      if (source[tagEnd - 1] === "/") continue;
      let depth = 1;
      let cursor = tagEnd + 1;
      while (depth > 0) {
        const close = source.indexOf("</button>", cursor);
        if (close === -1) break;
        const nested = source.slice(cursor).search(/<button(?=[\s/>])/);
        const nestedAt = nested === -1 ? Infinity : cursor + nested;
        if (nestedAt < close) {
          const nestedEnd = source.indexOf(">", nestedAt);
          if (source[nestedEnd - 1] !== "/") depth += 1;
          cursor = nestedEnd + 1;
          continue;
        }
        depth -= 1;
        cursor = close + "</button>".length;
        if (depth === 0) bodies.push([tagEnd + 1, close]);
      }
    }
    return bodies;
  }

  it("puts no control, link or tooltip inside a <button>", () => {
    const offenders: string[] = [];
    for (const [path, raw] of productionSources()) {
      if (!path.endsWith(".tsx")) continue;
      const source = withoutComments(raw);
      for (const [start, end] of buttonBodies(source)) {
        const body = source.slice(start, end);
        INTERACTIVE.lastIndex = 0;
        let hit: RegExpExecArray | null;
        while ((hit = INTERACTIVE.exec(body))) {
          const line = source.slice(0, start + hit.index).split("\n").length;
          offenders.push(`${path}:${line} nests <${hit[1]}> in a <button>`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("still recognises a nested control, so the rule cannot pass by accident", () => {
    // The scanner skips self-closing buttons and blanks out comments, and
    // both of those could silently grow into "skips everything". This is the
    // markup the guard exists for.
    const sample = `
      {/* a <button> inside a comment is not a violation */}
      <button type="button" />
      <button onClick={go}>
        <span>Account</span>
        <InfoTooltip text={help} />
      </button>
    `;
    const bodies = buttonBodies(withoutComments(sample));
    expect(bodies).toHaveLength(1);
    const body = sample.slice(bodies[0][0], bodies[0][1]);
    expect(/<InfoTooltip[\s/>]/.test(body)).toBe(true);
  });
});

describe("an unknown value is not drawn as measured data", () => {
  /**
   * `connectNulls` draws a straight segment across a gap. It is
   * indistinguishable from measured data, and a tooltip saying "unknown" under
   * the cursor does not undo it -- so the server's careful `null` is thrown away
   * in the last hundred pixels (`frontend/CLAUDE.md`,
   * `docs/time-series-contract.md` rule 3).
   *
   * The rule is `connectNulls={false}`. This scan is what tells you which files
   * broke it: the Security Performance comparison chart carried a bare
   * `connectNulls` for its whole life and nothing said so.
   *
   * The baseline is **shrink-only**. Each entry is a chart that predates the
   * guard, with the reason it is tolerated; fixing one means deleting its line.
   */
  const BASELINE: ReadonlyArray<{ file: string; reason: string }> = [
    {
      file: "/src/components/accounts/loan-detail/PayoffComparisonChart.tsx",
      reason:
        "Amortization curves are computed, not observed: every point exists by " +
        "construction, so a null there is a series that has ended rather than a " +
        "month nobody measured.",
    },
  ];

  /** A `connectNulls` with no `={false}` beside it. */
  const BARE_CONNECT_NULLS = /connectNulls(?!\s*=\s*\{\s*false\s*\})/;

  it("has no bare connectNulls outside the recorded baseline", () => {
    const allowed = new Set(BASELINE.map((entry) => entry.file));
    const offenders = productionSources()
      .filter(([, content]) => content.includes("recharts"))
      .filter(([, content]) =>
        content
          .split("\n")
          .some((line) => BARE_CONNECT_NULLS.test(line)),
      )
      .map(([path]) => path)
      .filter((path) => !allowed.has(path));

    expect(offenders).toEqual([]);
  });

  it("keeps the baseline shrink-only", () => {
    const offending = new Set(
      productionSources()
        .filter(([, content]) =>
          content.split("\n").some((line) => BARE_CONNECT_NULLS.test(line)),
        )
        .map(([path]) => path),
    );
    expect(
      BASELINE.map((entry) => entry.file).filter((file) => !offending.has(file)),
    ).toEqual([]);
  });
});

describe("an account picker labels its options through the shared hook", () => {
  /**
   * A linked investment pair is one account, stored as two rows whose names
   * carry a " - Cash"/" - Brokerage" suffix the user never chose. A picker that
   * builds its label from `account.name` shows that suffix, so money pickers
   * offered "TFSA - Cash" while every other surface called it "TFSA".
   *
   * `useAccountOptionLabel` is the one place that label is built. The scan is
   * what makes it stick: a new picker looks perfectly reasonable on its own.
   */
  const PICKER_TREES = [
    "/src/components/transactions/",
    "/src/components/scheduled-transactions/",
  ];
  /** A label built straight from the stored name, e.g. `(a) => `${a.name}...`. */
  const RAW_NAME_LABEL = /\(\s*\w+\s*\)\s*=>\s*`\$\{\s*\w+\.name\s*\}/;

  it("builds no account option label from the stored account name", () => {
    const offenders = productionSources()
      .filter(([path]) => PICKER_TREES.some((tree) => path.startsWith(tree)))
      .filter(([, content]) => content.includes("buildAccountDropdownOptions"))
      .filter(([, content]) => RAW_NAME_LABEL.test(content))
      .map(([path]) => path);

    expect(
      offenders,
      "Label account options with useAccountOptionLabel() so a linked cash " +
        "half reads as the account the user knows, not its stored ledger name.",
    ).toEqual([]);
  });

  it("passes the shared labeller wherever it builds account options", () => {
    const missing = productionSources()
      .filter(([path]) => PICKER_TREES.some((tree) => path.startsWith(tree)))
      .filter(([, content]) => content.includes("buildAccountDropdownOptions("))
      .filter(([, content]) => !content.includes("useAccountOptionLabel"))
      .map(([path]) => path);

    expect(
      missing,
      "Every account picker in these trees labels through useAccountOptionLabel().",
    ).toEqual([]);
  });
});

describe("a CSV file is written by the shared exporter", () => {
  /** The one file allowed to build a CSV -- it *is* the writer. */
  const WRITER = "/src/lib/csv-export.ts";
  /** A `text/csv` Blob: the last step of writing one by hand. */
  const CSV_BLOB = /new Blob\([\s\S]{0,200}?text\/csv/;
  /** RFC 4180 quoting, doubled quotes and all. */
  const CSV_QUOTING = /replace\(\/"\/g,\s*['"]""['"]\)/;

  it("builds no CSV outside the shared writer", () => {
    const offenders = productionSources()
      .filter(([path]) => path !== WRITER)
      .filter(
        ([, content]) => CSV_BLOB.test(content) || CSV_QUOTING.test(content),
      )
      .map(([path]) => path);

    // A second writer is a second set of answers to the questions this one
    // already answers: the BOM, CRLF line endings, quoting, and which values a
    // spreadsheet would evaluate rather than display. MonteCarloReport had one,
    // and it applied no formula-injection guard at all -- while the shared
    // writer applied it to every negative amount (issue #1134). Neither file
    // looked wrong on its own, which is why this is a scan.
    expect(
      offenders,
      "Write CSV through exportToCsv/exportCsvSections in @/lib/csv-export.",
    ).toEqual([]);
  });

  it("still finds the writer, so the rule cannot pass by accident", () => {
    const writer = sources[WRITER];
    expect(writer, `${WRITER} not found -- update WRITER in this test`).toBeTruthy();
    expect(CSV_BLOB.test(writer)).toBe(true);
    expect(CSV_QUOTING.test(writer)).toBe(true);
  });
});

describe("a transfer's direction is decided in one place", () => {
  /** The one file allowed to turn an amount's sign into a direction. */
  const HELPER = "/src/lib/transfer-label.ts";
  const DIRECTION_TERNARY = /['"]to['"]\s*:\s*['"]from['"]|['"]from['"]\s*:\s*['"]to['"]/;

  it("derives to/from from an amount nowhere else", () => {
    const offenders = productionSources()
      .filter(([path]) => path !== HELPER)
      .filter(([, content]) => DIRECTION_TERNARY.test(content))
      .map(([path]) => path);

    // Money leaving an account went *to* the counterpart and money arriving
    // came *from* it, so both legs of one transfer read differently and each
    // line -- a split line included -- is asked with its own amount. That rule
    // was written out four times in TransactionRow and omitted from both CSV
    // exports, which is how the register showed a counterpart the export did
    // not mention. Call transferDirection().
    expect(
      offenders,
      "Decide a transfer's direction with transferDirection() from @/lib/transfer-label.",
    ).toEqual([]);
  });

  it("still finds the helper, so the rule cannot pass by accident", () => {
    const helper = sources[HELPER];
    expect(helper, `${HELPER} not found -- update HELPER in this test`).toBeTruthy();
    expect(DIRECTION_TERNARY.test(helper)).toBe(true);
  });
});

describe("a transaction status cell is the shared StatusCellButton", () => {
  /** The one file allowed to render the dense status letters -- it IS the cell. */
  const WRAPPER = "/src/components/transactions/StatusCellButton.tsx";
  // The dense-label catalog keys fingerprint a hand-rolled status cell: any
  // second copy has to read them to draw the C/R/V/pending letters.
  const DENSE_LABEL_KEY =
    /list\.status\.(?:reconciledDense|clearedDense|voidDense|pendingDense)/;

  it("reads the dense status labels only inside the shared cell", () => {
    const offenders = productionSources()
      .filter(([path]) => path !== WRAPPER)
      .filter(([, content]) => DENSE_LABEL_KEY.test(content))
      .map(([path]) => path);

    // The cash register and the investment register share one status cell so
    // the two cannot drift on colours, labels, or what a click means. A second
    // inline copy is the mistake this rule was written after: the investment
    // register would have grown its own near-copy of TransactionRow's cell.
    expect(offenders).toEqual([]);
  });

  it("still finds the shared cell, so the rule cannot pass by accident", () => {
    const wrapper = sources[WRAPPER];
    expect(
      wrapper,
      `${WRAPPER} not found -- update WRAPPER in this test`,
    ).toBeTruthy();
    expect(DENSE_LABEL_KEY.test(wrapper)).toBe(true);
  });
});

describe("a category typed into a picker is created by one helper", () => {
  /** The one module allowed to turn typed picker text into a category. */
  const HELPER = "/src/lib/category-create.ts";
  /**
   * The Categories page's own create form is a different thing: it collects a
   * name, parent, colour and icon from real fields, so there is no typed text
   * to parse and no `Parent: Child` shorthand to honour.
   */
  const FULL_FORM = "/src/app/categories/page.tsx";
  /**
   * Both doors: the caller's own ledger, and the owner's ledger behind a joint
   * account. A second call site for either is a second set of rules.
   */
  const CREATE_CALL =
    /categoriesApi\.create\(|delegationApi\.createJointCategory\(/;

  it("has no second inline category-creation path", () => {
    const offenders = productionSources()
      .filter(([path]) => path !== HELPER && path !== FULL_FORM)
      .filter(([, content]) => CREATE_CALL.test(content))
      .map(([path]) => path);

    // Three copies of this existed -- the transaction form, the account form's
    // asset category, and the scheduled transaction form -- and the third had
    // neither title casing nor the `Parent: Child` shorthand, so `travel:
    // hotels` became a child of Travel in two fields and a single flat category
    // named "Travel: Hotels" in the other. Use `createCategoryFromInput`.
    expect(offenders).toEqual([]);
  });

  it("still finds the helper, so the rule cannot pass by accident", () => {
    const helper = sources[HELPER];
    expect(helper, `${HELPER} not found -- update HELPER in this test`).toBeTruthy();
    expect(/export async function createCategoryFromInput\(/.test(helper)).toBe(true);
  });

  it("the helper itself holds both ledgers' create calls", () => {
    // A joint account's picker creates on the OWNER's ledger, so the helper
    // owns that call too -- if it moves out, the rule above is scanning for a
    // string nothing writes any more and passes for the wrong reason.
    const helper = sources[HELPER];
    expect(/categoriesApi\.create/.test(helper)).toBe(true);
    expect(/delegationApi\.createJointCategory\(/.test(helper)).toBe(true);
  });
});

describe("a register that draws a Balance column is given the balance", () => {
  /** The list that renders the column and computes the running balances. */
  const LIST = "/src/components/transactions/TransactionList.tsx";

  /** The attribute text of every `<TransactionList ...>` opening tag in a file. */
  function transactionListTags(content: string): string[] {
    const tags: string[] = [];
    const open = /<TransactionList[\s>]/g;
    let match: RegExpExecArray | null;
    while ((match = open.exec(content)) !== null) {
      let depth = 0;
      for (let i = match.index; i < content.length; i++) {
        if (content[i] === "{") depth++;
        else if (content[i] === "}") depth--;
        else if (content[i] === ">" && depth === 0) {
          tags.push(content.slice(match.index, i));
          break;
        }
      }
    }
    return tags;
  }

  it("supplies startingBalance wherever isSingleAccountView is set", () => {
    const offenders = productionSources()
      .flatMap(([path, content]) =>
        transactionListTags(content).map((tag) => [path, tag] as const),
      )
      .filter(([, tag]) => /\bisSingleAccountView\b/.test(tag))
      .filter(([, tag]) => !/\bstartingBalance\b/.test(tag))
      .map(([path]) => path);

    // `isSingleAccountView` alone draws the Balance column, and the number in
    // it comes from the backend's `startingBalance` run down the page. The
    // investment register panel read the rows off the response and dropped that
    // field, so the column it had just asked for rendered "-" on every row
    // (issue #1188). The two are one decision: ask for the column, supply the
    // balance, and take both from the same response.
    expect(offenders).toEqual([]);
  });

  it("still needs the balance to draw the column, so the rule cannot pass by accident", () => {
    // Were the list to start deriving the running balance itself, this check
    // would be demanding a prop nothing reads. This fails first and says so.
    const list = sources[LIST];
    expect(list, `${LIST} not found -- update LIST in this test`).toBeTruthy();
    expect(/isSingleAccountView \|\| startingBalance !== undefined/.test(list)).toBe(
      true,
    );
  });
});

describe("TransactionList performs its own delete", () => {
  /** The list that owns the confirmation, the API call and the toast. */
  const LIST = "/src/components/transactions/TransactionList.tsx";
  /** Every way a caller could delete the row a second time. */
  const DELETES =
    /(?:transactionsApi\.(?:delete|deleteTransfer)|investmentsApi\.deleteTransaction)\(/;

  /**
   * The expression a file hands to `<TransactionList onDeleted={...}>`, resolved
   * to the callback's own source where it is passed by name. Brace-matched
   * rather than regex-terminated, because the handler is usually a `useCallback`
   * whose body contains braces of its own.
   */
  function deletedHandlerSources(content: string): string[] {
    const bodies: string[] = [];
    const prop = /onDeleted=\{/g;
    while (prop.exec(content) !== null) {
      const expression = braceMatched(content, prop.lastIndex - 1);
      const identifier = expression.trim();
      bodies.push(
        /^[A-Za-z_$][\w$]*$/.test(identifier)
          ? definitionOf(content, identifier)
          : expression,
      );
    }
    return bodies;
  }

  /** The text between `{` at `open` and its matching `}`. */
  function braceMatched(content: string, open: number): string {
    let depth = 0;
    for (let i = open; i < content.length; i++) {
      if (content[i] === "{") depth++;
      else if (content[i] === "}" && --depth === 0)
        return content.slice(open + 1, i);
    }
    return content.slice(open + 1);
  }

  /**
   * The initialiser of `const <name> = ...`, taken to the `;` at nesting depth
   * zero. Returns the empty string when the name is not defined in this file --
   * an imported handler is out of reach of a source scan, and saying so by
   * finding nothing is better than guessing.
   */
  function definitionOf(content: string, name: string): string {
    const start = content.search(
      new RegExp(`\\bconst\\s+${name}\\s*=`),
    );
    if (start < 0) return "";
    let depth = 0;
    for (let i = start; i < content.length; i++) {
      const c = content[i];
      if (c === "(" || c === "{" || c === "[") depth++;
      else if (c === ")" || c === "}" || c === "]") depth--;
      else if (c === ";" && depth === 0) return content.slice(start, i);
    }
    return content.slice(start);
  }

  it("is never asked to delete a row twice", () => {
    const offenders = productionSources()
      .filter(([, content]) => content.includes("<TransactionList"))
      .filter(([, content]) => deletedHandlerSources(content).some((body) => DELETES.test(body)))
      .map(([path]) => path);

    // `onDeleted` reports a delete this list has already performed; it is not a
    // request to perform one. The investment register panel gave it a handler
    // shaped like `InvestmentTransactionList`'s -- whose `onDelete` *is* the
    // performer -- so every cash row was deleted twice and the 404 from the
    // second attempt landed beside the success toast (issue #1192). Reach for
    // `onRefresh` to reload after a delete.
    expect(offenders).toEqual([]);
  });

  it("still owns the delete, so the rule cannot pass by accident", () => {
    // Were the contract to flip -- the list asking its parent to delete -- the
    // check above would be policing the opposite of the truth. This fails first
    // and says what to update.
    const list = sources[LIST];
    expect(list, `${LIST} not found -- update LIST in this test`).toBeTruthy();
    expect(DELETES.test(list)).toBe(true);
    expect(/onDeleted\?\.\(/.test(list)).toBe(true);
  });
});

describe("a report never unmounts the date field being typed into", () => {
  /**
   * A component that answers a load with `if (isLoading) return <Skeleton/>`
   * returns a *different tree*, and React unmounts whatever the previous tree
   * held at that position -- including the date input the user is mid-way
   * through typing. On the Net Worth report every keystroke that completed a
   * date started a reload, so focus was ejected after two characters and the
   * year could never be finished (issue #1201).
   *
   * The rule is narrow on purpose: it applies to a component that both hosts a
   * date control **and** takes its loading flag from `useReportData`, whose
   * fetch is re-run by the very date change being typed. A one-shot
   * prerequisite load -- `isLoadingData` on the report *forms*, the register's
   * first page -- is not the same thing: it resolves before the date field
   * exists and never fires again, so an early return there costs nothing.
   *
   * The fix is to render the load and error states inside the one tree the
   * component always returns. Duplicating the controls block into a second
   * `return` is not a fix, and looked like one for a while: `CashFlowReport`
   * did exactly that, but its two trees put the controls at different child
   * indexes, so React reconciled the block against the summary cards and
   * unmounted it anyway. That is why a second `<DateRangeSelector`/`<DateInput`
   * in one file fails too.
   */
  const DATE_CONTROL = /<DateInput\b|showCustom/;
  // Negated classes already cross newlines, so no dotAll flag is needed (and
  // the ES2017 target would reject one).
  const REPORT_DATA_LOADING = /\{[^}]*\bisLoading\b[^}]*\}\s*=\s*useReportData\(/;
  const EARLY_RETURN =
    /\bif \(\s*!?(?:isLoading|error)\b[^)\n]*\)\s*\{?\s*(?:\/\/[^\n]*\n\s*)*return/;

  const reportsWithDateControls = () =>
    productionSources().filter(
      ([, source]) => DATE_CONTROL.test(source) && REPORT_DATA_LOADING.test(source),
    );

  it("renders one tree, with the load and error states inside it", () => {
    const offenders = reportsWithDateControls()
      .filter(([, source]) => EARLY_RETURN.test(source))
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });

  it("renders its date controls in exactly one place", () => {
    // A report legitimately holds two date *inputs* -- a range has two ends --
    // so the thing to count is the controls block itself.
    const offenders = reportsWithDateControls()
      .filter(([, source]) => (source.match(/showCustom/g) ?? []).length > 1)
      .map(([path]) => path);

    // Two copies of the same controls block means two trees, whatever the
    // second one was added to fix.
    expect(offenders).toEqual([]);
  });

  it("still recognizes the reports it is meant to police", () => {
    // Were `useReportData` renamed, or the date controls moved behind another
    // component, both checks above would pass over an empty set. The reports
    // with a custom date range are the subject; there are several.
    const subjects = reportsWithDateControls().map(([path]) => path);
    expect(subjects.length).toBeGreaterThan(4);
    expect(subjects).toContain("/src/components/reports/NetWorthReport.tsx");
  });
});
