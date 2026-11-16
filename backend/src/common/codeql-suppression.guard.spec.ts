import { readFileSync } from "fs";
import { join } from "path";
import { findRepoRoot, gitListFiles, requireRepoRoot } from "./repo-tree.util";

/**
 * A CodeQL in-source suppression covers exactly one line.
 *
 * CodeQL's own suppression library (`codeql/util/suppression`) reads a
 * `codeql` bracket annotation anywhere in a single-line comment, provided
 * nothing precedes the comment on its line, and applies it to the whole of the
 * line directly below -- and to nothing else. Two annotations for
 * `js/insufficient-password-hash` sat above the `const sha1 = crypto`
 * statement while CodeQL reports that query on the `.update(password)` call
 * three lines further down, so the source claimed the alerts were handled and
 * the Security tab kept them open.
 *
 * The placement rule is the mechanism, not a style preference, so it is
 * checked here rather than described. Note what this guard does NOT claim:
 * CodeQL default setup does not run the alert-suppression query at all, so an
 * annotation closes nothing today -- an accepted false positive is dismissed on
 * the Security tab with its reason. The annotation is still placed where it
 * takes effect the day that query is added, and this suite keeps it there.
 */

// The shape CodeQL matches, assembled from pieces so this file's own text
// never carries it.
const ANNOTATION = new RegExp("\\b" + "codeql" + "\\s*\\[([^\\]]*)\\]");
const QUERY_ID = /^[a-z]+\/[a-z0-9-]+$/;

/**
 * Where CodeQL reports each query we suppress, as a shape the covered line
 * must have. An annotation above the statement that *contains* the reported
 * expression covers the wrong line, and that is the exact defect this guard
 * exists for.
 */
const COVERED_LINE_SHAPE: Record<string, RegExp> = {
  "js/insufficient-password-hash": /\.update\(/,
};

interface Finding {
  line: number;
  problem: string;
}

function checkSuppressions(lines: readonly string[]): Finding[] {
  const findings: Finding[] = [];
  lines.forEach((line, index) => {
    const commentStart = line.indexOf("//");
    if (commentStart < 0) return;
    const match = ANNOTATION.exec(line.slice(commentStart));
    if (!match) return;
    const number = index + 1;
    if (line.slice(0, commentStart).trim() !== "") {
      findings.push({
        line: number,
        problem:
          "code precedes the annotation on its line, so CodeQL does not read it as a suppression",
      });
      return;
    }
    const annotation = match[1].trim();
    if (!QUERY_ID.test(annotation)) {
      findings.push({
        line: number,
        problem: `"${annotation}" is not a query id, and prose shaped like an annotation is read as one`,
      });
      return;
    }
    const next = lines[index + 1];
    if (
      next === undefined ||
      next.trim() === "" ||
      /^\s*(\/\/|\/\*|\*)/.test(next)
    ) {
      findings.push({
        line: number,
        problem:
          "the line below is not code, and a suppression covers exactly that one line",
      });
      return;
    }
    const shape = COVERED_LINE_SHAPE[annotation];
    if (shape && !shape.test(next)) {
      findings.push({
        line: number,
        problem: `${annotation} is reported on a line matching ${shape}, and the line below does not`,
      });
    }
  });
  return findings;
}

function countAnnotations(lines: readonly string[]): number {
  return lines.filter((line) => {
    const commentStart = line.indexOf("//");
    return commentStart >= 0 && ANNOTATION.test(line.slice(commentStart));
  }).length;
}

const annotate = (id: string) => `// ${"codeql"}[${id}]`;

describe("a CodeQL suppression annotation covers the line below it", () => {
  const hashChain = (marker: string[], before: string[] = []) => [
    ...before,
    "const sha1 = crypto",
    '  .createHash("sha1")',
    ...marker,
    "  .update(password)",
    '  .digest("hex");',
  ];

  it("accepts an annotation directly above the reported line", () => {
    const lines = hashChain([
      "  // required by the HIBP k-anonymity protocol",
      `  ${annotate("js/insufficient-password-hash")}`,
    ]);
    expect(checkSuppressions(lines)).toEqual([]);
    expect(countAnnotations(lines)).toBe(1);
  });

  it("fails the original mistake: the annotation above the statement", () => {
    const lines = hashChain(
      [],
      [`${annotate("js/insufficient-password-hash")}`],
    );
    expect(checkSuppressions(lines).map((f) => f.line)).toEqual([1]);
  });

  it("fails an annotation that follows code on the same line", () => {
    const lines = [
      `const h = sha1(password); ${annotate("js/insufficient-password-hash")}`,
    ];
    expect(checkSuppressions(lines)).toHaveLength(1);
  });

  it("fails prose shaped like an annotation", () => {
    expect(
      checkSuppressions([`// a ${"codeql"}[...] comment`, "x();"]),
    ).toHaveLength(1);
  });

  it("fails an annotation with nothing but a comment or a blank below it", () => {
    expect(
      checkSuppressions([annotate("js/xss"), "", "el.innerHTML = s;"]),
    ).toHaveLength(1);
    expect(
      checkSuppressions([annotate("js/xss"), "// later", "el.innerHTML = s;"]),
    ).toHaveLength(1);
  });

  it("ignores the shape outside a comment", () => {
    expect(checkSuppressions(['const s = "codeql" + "[x]";'])).toEqual([]);
  });
});

const REPO_ROOT = findRepoRoot(__dirname);
const describeTree = REPO_ROOT || process.env.CI ? describe : describe.skip;

describeTree(
  "every suppression annotation in the tree is placed where it applies",
  () => {
    it("finds no misplaced annotation, and does see the existing ones", () => {
      const root = requireRepoRoot(REPO_ROOT);
      const files = gitListFiles(root).filter((path) =>
        /\.(ts|tsx|js|mjs|cjs)$/.test(path),
      );
      expect(files.length).toBeGreaterThan(100);

      const offenders: string[] = [];
      let seen = 0;
      for (const file of files) {
        const lines = readFileSync(join(root, file), "utf8").split("\n");
        seen += countAnnotations(lines);
        for (const finding of checkSuppressions(lines)) {
          offenders.push(`${file}:${finding.line}: ${finding.problem}`);
        }
      }

      expect(offenders).toEqual([]);
      expect(seen).toBeGreaterThanOrEqual(1);
    });
  },
);
