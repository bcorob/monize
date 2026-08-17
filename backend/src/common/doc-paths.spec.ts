import { readFileSync } from "fs";
import { basename, join } from "path";

import { findRepoRoot, gitListFiles, requireRepoRoot } from "./repo-tree.util";

/**
 * A doc that names a file is making a claim about the source tree.
 *
 * The rule is already written down in the root `CLAUDE.md` -- rename or delete a
 * file and grep `docs/` and every `CLAUDE.md` in the same commit -- and it was
 * still broken: the cross-owner-transfers plan pointed at
 * `backend/src/ai/query/transaction-tool-prep.service.ts` for a service that
 * lives under `backend/src/transactions/`, so anyone following the path would
 * find nothing and either hunt for it or create a second one. A rule in prose
 * gets read, agreed with, and violated anyway; this is the version the machine
 * checks.
 *
 * Three strengths of claim, matched to what each kind of doc can promise:
 *
 *  - A **rooted** path (`backend/src/...`, `database/...`) is an exact claim and
 *    must resolve exactly. This is the one that was wrong.
 *  - A **relative** path (`map/map-loans.ts` inside a section about one
 *    directory) or a **bare filename** (`schema.sql`) is a readable shorthand,
 *    so it only has to match some file's path suffix somewhere in the tree.
 *    Bare names count: `133_currency_global_liveness.sql` once sat in a
 *    contract describing a migration that was never in the tree, and a
 *    slash-only grammar let it.
 *  - In `docs/future-plans/` a path may name a file that does not exist yet --
 *    that is what a plan is for -- so non-existence alone proves nothing there.
 *    What a plan must not do is name a file that exists *somewhere else*: an
 *    unresolved path whose basename lives at another location is not a planned
 *    file, it is a stale reference to a moved or renamed one. That weaker claim
 *    is exactly the shape of the motivating defect above, and it holds with
 *    zero false positives against genuinely planned files (whose basenames
 *    exist nowhere). The blind spot is deliberate and named: a plan referencing
 *    a file that was *deleted* outright cannot be told from a planned one.
 *
 * Out of scope, each for a reason: `docs/release-notes/` and `docs/audits/` are
 * shipped historical records -- editing them to match a later tree would falsify
 * them. Fenced code blocks are stripped before scanning: they are sample code,
 * where a hypothetical path is legitimate; the claim idiom is the inline span.
 *
 * The same grammar decides the inverse case: a doc asserting that a file is
 * *absent* -- `docs/release-integrity.md`'s gap register says the repository has
 * no branch-protection policy in it -- names it in plain prose rather than in a
 * span, because a span here means "this is here" and that doc is arguing the
 * opposite. Re-backticking such a name fails this suite, which is the intended
 * outcome: the day the file lands, the span is correct again.
 *
 * Cross-tree references are not claims about this tree and are exempt by
 * grammar, each with a test below: `branch:path/to/file.md` (qualify a path
 * that lives in another branch exactly this way -- the root `CLAUDE.md` says
 * so), image tags (`ghcr.io/...:latest`), and URLs. A `path:42` /
 * `path:95-97` line reference, by contrast, IS a claim about `path` and is
 * checked with the lines stripped.
 *
 * The inventory comes from `git ls-files`, so the guard sees exactly the tree
 * CI sees and needs no hand-maintained skip list: `node_modules`, build output
 * and local agent scratch are simply not tracked. Docs are collected from the
 * tracked list too, so an untracked draft never gates anything. Existence
 * checks include untracked-but-not-ignored files, so a doc committed alongside
 * a file it names does not fail locally before the file is staged.
 */

const EXTENSIONS = "ts|tsx|sql|mjs|cjs|js|json|sh|ya?ml|md";

/** Prefixes that make a path a claim about an exact location. */
const ROOTED = [
  "backend/",
  "frontend/",
  "database/",
  "docs/",
  "helm/",
  "scripts/",
  "e2e/",
  ".github/",
  ".claude/",
];

/**
 * Spans that are deliberately not files in this tree. Each needs a reason, not
 * just an entry.
 */
const NOT_REPO_PATHS: RegExp[] = [
  /^https?:/, // URLs
  /^\/(?:data|app|tmp|etc|root)\//, // container and host paths
  /\.{3}/, // `.../interceptors/foo.ts` ellipsis shorthand
  /(?:^|\/)\d*N{2,}_/, // `NNN_description.sql`, `0NN_rls_...` numbering placeholders
];

type PathClaim = { kind: "rooted" | "relative" | "bare"; path: string };
type Claim = PathClaim | { kind: "cross-tree" | "not-path" };

const isPathClaim = (claim: Claim): claim is PathClaim =>
  claim.kind === "rooted" || claim.kind === "relative" || claim.kind === "bare";

/**
 * Decide what, if anything, a backticked span claims about this tree. Pure, so
 * the grammar itself is unit-tested below.
 */
export function classifySpan(span: string): Claim {
  if (NOT_REPO_PATHS.some((p) => p.test(span))) return { kind: "not-path" };

  // `path:42` / `path:95-97` is a line reference: a claim about the path part.
  // Any other colon-qualified span (`branch:path`, `image:tag`) references a
  // tree that is not this one, and is exempt -- explicitly, not by a character
  // class accident.
  const lineRef = /^([A-Za-z0-9_.@/-]+):\d+(?:-\d+)?$/.exec(span);
  const path = lineRef ? lineRef[1] : span;
  if (!lineRef && span.includes(":")) {
    return /^[A-Za-z0-9_.@/-]+:[A-Za-z0-9_.@:/-]+$/.test(span)
      ? { kind: "cross-tree" }
      : { kind: "not-path" };
  }

  // A path claim is path characters ending in a known extension. Globs (`*`)
  // and templates (`{locale}`) fail this grammar outright.
  if (!new RegExp(`^[A-Za-z0-9_.@/-]+\\.(?:${EXTENSIONS})$`).test(path)) {
    return { kind: "not-path" };
  }

  if (ROOTED.some((prefix) => path.startsWith(prefix))) {
    return { kind: "rooted", path };
  }
  if (path.includes("/")) return { kind: "relative", path };
  // A leading dot is an extension being named (`.controller.spec.ts`), not a
  // file.
  if (!/^[A-Za-z0-9]/.test(path)) return { kind: "not-path" };
  return { kind: "bare", path };
}

interface FileIndex {
  /** Exact repo-relative paths. */
  set: Set<string>;
  list: string[];
  /** basename -> every repo-relative path carrying it. */
  byBasename: Map<string, string[]>;
}

export function buildIndex(paths: string[]): FileIndex {
  const byBasename = new Map<string, string[]>();
  for (const p of paths) {
    const name = basename(p);
    byBasename.set(name, [...(byBasename.get(name) ?? []), p]);
  }
  return { set: new Set(paths), list: paths, byBasename };
}

const resolves = (claim: PathClaim, index: FileIndex): boolean => {
  if (claim.kind === "rooted") return index.set.has(claim.path);
  // relative and bare: some file's path suffix.
  return (
    index.set.has(claim.path) ||
    index.list.some((f) => f.endsWith(`/${claim.path}`))
  );
};

/**
 * The strict check, for binding contracts: every claim must resolve.
 * Returns a problem description, or null.
 */
export function strictProblem(span: string, index: FileIndex): string | null {
  const claim = classifySpan(span);
  if (!isPathClaim(claim)) return null;
  if (resolves(claim, index)) return null;
  const elsewhere = index.byBasename.get(basename(claim.path));
  return elsewhere
    ? `${span} does not resolve (a file with that name lives at ${elsewhere.join(", ")})`
    : `${span} does not resolve`;
}

/**
 * The plan check, for `docs/future-plans/`: a claim may name an unbuilt file,
 * but an unresolved claim whose basename exists elsewhere in the tree is a
 * stale reference to a moved or renamed file, not a plan.
 */
export function planProblem(span: string, index: FileIndex): string | null {
  const claim = classifySpan(span);
  if (!isPathClaim(claim)) return null;
  if (resolves(claim, index)) return null;
  const elsewhere = index.byBasename.get(basename(claim.path));
  if (!elsewhere) return null; // exists nowhere: a planned file
  return `${span} names a moved or renamed file (it lives at ${elsewhere.join(", ")})`;
}

/** Inline spans of a doc, with fenced code blocks stripped first. */
export function docSpans(text: string): string[] {
  const withoutFences = text.replace(/```[\s\S]*?```/g, "");
  return [...withoutFences.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
}

// ---------------------------------------------------------------------------
// The grammar, pinned. These are the decisions a reader of a finding will
// question, so each is a test rather than a comment.
// ---------------------------------------------------------------------------

describe("doc path grammar", () => {
  const kinds = (span: string) => classifySpan(span).kind;

  it("classifies the three claim strengths", () => {
    expect(classifySpan("backend/src/app.module.ts")).toEqual({
      kind: "rooted",
      path: "backend/src/app.module.ts",
    });
    expect(classifySpan("map/map-loans.ts")).toEqual({
      kind: "relative",
      path: "map/map-loans.ts",
    });
    expect(classifySpan("schema.sql")).toEqual({
      kind: "bare",
      path: "schema.sql",
    });
    // The bare claim exists so this exact span -- a migration that was never in
    // the tree, cited by a contract -- cannot escape on having no slash.
    expect(kinds("133_currency_global_liveness.sql")).toBe("bare");
  });

  it("treats a line reference as a claim about its path", () => {
    expect(classifySpan("database/schema.sql:705-795")).toEqual({
      kind: "rooted",
      path: "database/schema.sql",
    });
    expect(classifySpan("delegation/delegation.module.ts:46")).toEqual({
      kind: "relative",
      path: "delegation/delegation.module.ts",
    });
  });

  it("exempts a branch-qualified path explicitly, not by accident", () => {
    // The escape hatch the root CLAUDE.md prescribes for paths in other
    // branches. It used to survive only because `:` was missing from a
    // character class; this is the deliberate version.
    expect(
      kinds("poc/import-from-dotmny:migration/ms-money-data-model.md"),
    ).toBe("cross-tree");
    expect(kinds("ghcr.io/kenlasko/monize-backend:latest")).toBe("cross-tree");
  });

  it("does not read prose, globs, templates or placeholders as paths", () => {
    expect(kinds("GET /transactions/:id/linked")).toBe("not-path");
    expect(kinds("src/**/*.ts")).toBe("not-path");
    expect(kinds("messages/{locale}/{namespace}.json")).toBe("not-path");
    expect(kinds("NNN_description.sql")).toBe("not-path");
    expect(kinds("0NN_rls_helpers_and_trigger.sql")).toBe("not-path");
    expect(kinds(".../interceptors/request-context.interceptor.ts")).toBe(
      "not-path",
    );
    expect(kinds(".controller.spec.ts")).toBe("not-path"); // an extension, named
    expect(kinds("/app/dist/main.js")).toBe("not-path");
    expect(
      kinds("https://github.com/kenlasko/monize/blob/main/README.md"),
    ).toBe("not-path");
  });

  it("flags a plan claim whose basename lives elsewhere, and only that", () => {
    const index = buildIndex([
      "backend/src/database/seed.service.ts",
      "backend/src/transactions/transaction-tool-prep.service.ts",
    ]);
    // The two references the original guard missed by excluding future-plans:
    // seed.service.ts claimed at a path it moved away from.
    expect(planProblem("database/seed.service.ts", index)).toContain(
      "backend/src/database/seed.service.ts",
    );
    // The guard's own motivating defect, now in scope.
    expect(
      planProblem(
        "backend/src/ai/query/transaction-tool-prep.service.ts",
        index,
      ),
    ).toContain("backend/src/transactions/transaction-tool-prep.service.ts");
    // A genuinely planned file exists nowhere, and passes.
    expect(planProblem("docs/rls.md", index)).toBeNull();
    expect(planProblem("frontend/src/lib/vat.ts", index)).toBeNull();
    // A resolved claim passes under either check.
    expect(
      planProblem("backend/src/database/seed.service.ts", index),
    ).toBeNull();
  });

  it("strictly requires resolution outside future-plans, bare names included", () => {
    const index = buildIndex(["database/schema.sql"]);
    expect(strictProblem("schema.sql", index)).toBeNull();
    expect(strictProblem("133_currency_global_liveness.sql", index)).toContain(
      "does not resolve",
    );
    expect(strictProblem("database/schema.sql:705-795", index)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The tree itself.
// ---------------------------------------------------------------------------

const REPO_ROOT = findRepoRoot(__dirname);

const describeTree = REPO_ROOT || process.env.CI ? describe : describe.skip;

describeTree("docs name files that exist", () => {
  interface TreeData {
    index: FileIndex;
    contractDocs: string[];
    planDocs: string[];
  }
  let cached: TreeData | undefined;

  const load = (): TreeData => {
    if (cached) return cached;
    const root = requireRepoRoot(REPO_ROOT);
    // Existence is generous (tracked plus untracked-but-not-ignored, so a file
    // committed in the same change as the doc that names it passes before
    // staging); the docs that gate are the tracked ones only.
    const index = buildIndex(
      gitListFiles(root, "--cached --others --exclude-standard"),
    );
    const tracked = gitListFiles(root);
    const contractDocs = tracked.filter(
      (f) =>
        basename(f) === "CLAUDE.md" ||
        (/^docs\/[^/]+\.md$/.test(f) && basename(f) !== "CLAUDE.md"),
    );
    const planDocs = tracked.filter((f) =>
      /^docs\/future-plans\/[^/]+\.md$/.test(f),
    );
    cached = { index, contractDocs, planDocs };
    return cached;
  };

  const problems = (
    docs: string[],
    check: (span: string, index: FileIndex) => string | null,
  ): string[] => {
    const { index } = load();
    const found: string[] = [];
    for (const doc of docs) {
      const text = readFileSync(join(REPO_ROOT as string, doc), "utf8");
      for (const span of docSpans(text)) {
        const problem = check(span, index);
        if (problem) found.push(`${doc}: ${problem}`);
      }
    }
    return found;
  };

  it("scans the contracts it claims to scan", () => {
    // A broken inventory would make every assertion below vacuous.
    const { index, contractDocs, planDocs } = load();
    expect(contractDocs.some((d) => d.endsWith("/CLAUDE.md"))).toBe(true);
    expect(contractDocs).toContain("docs/financial-calculation-contract.md");
    expect(contractDocs.length).toBeGreaterThan(5);
    expect(planDocs.length).toBeGreaterThan(5);
    expect(index.list.length).toBeGreaterThan(500);
  });

  it("resolves every path a binding contract names", () => {
    // A doc describing a file that is not there gets read, believed, and built
    // on -- or sends the reader to create a duplicate at the path it names.
    expect(problems(load().contractDocs, strictProblem)).toEqual([]);
  });

  it("finds no moved or renamed file behind a future-plans path", () => {
    // Weaker than the strict claim on purpose -- a plan names unbuilt files --
    // but exactly strong enough for the failure mode that motivated this
    // guard, which lived in future-plans and the original scope could not see.
    expect(problems(load().planDocs, planProblem)).toEqual([]);
  });
});
