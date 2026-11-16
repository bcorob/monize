import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { escapeRegExp } from "../common/escape-regexp.util";
import { BondAdapter } from "./bond-adapter";
import { INSTALLED_BOND_ADAPTERS } from "./bond-adapters";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const GUIDE = "docs/backend/bond-adapters.md";

/**
 * A country is not installed without its spec. For every adapter in
 * `INSTALLED_BOND_ADAPTERS`, without editing this file: the document named by
 * `specDoc` exists under `docs/specs/`, and it mentions every program code,
 * every benchmark code, the adapter's country code, and links at least one
 * official source (an `https://` address). Returns what is missing, one line
 * each, so the failure tells the author what to add.
 */
export function adapterDocProblems(
  adapter: BondAdapter,
  read: (relativePath: string) => string | null,
): string[] {
  const label = `adapter ${adapter.countryCode}`;
  if (!/^docs\/specs\/[A-Za-z0-9._-]+\.md$/.test(adapter.specDoc ?? "")) {
    return [
      `${label}: specDoc "${adapter.specDoc}" must be a repo-relative path of a markdown file directly under docs/specs/`,
    ];
  }
  const text = read(adapter.specDoc);
  if (text === null) {
    return [`${label}: the spec ${adapter.specDoc} does not exist`];
  }
  const mentions = (token: string) =>
    new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(token)}(?![A-Za-z0-9_])`).test(
      text,
    );
  const problems: string[] = [];
  if (!mentions(adapter.countryCode)) {
    problems.push(
      `${label}: ${adapter.specDoc} never mentions the country code ${adapter.countryCode}`,
    );
  }
  for (const program of adapter.programs) {
    if (!mentions(program.programCode)) {
      problems.push(
        `${label}: ${adapter.specDoc} never mentions the program ${program.programCode}`,
      );
    }
  }
  for (const benchmark of adapter.benchmarks) {
    if (!mentions(benchmark.code)) {
      problems.push(
        `${label}: ${adapter.specDoc} never mentions the benchmark ${benchmark.code}`,
      );
    }
  }
  if (!/https:\/\/[^\s)>]+/.test(text)) {
    problems.push(
      `${label}: ${adapter.specDoc} links no official source (an https:// address of the issuer or publisher)`,
    );
  }
  return problems;
}

const fromRepo = (relativePath: string): string | null => {
  const full = join(REPO_ROOT, relativePath);
  return existsSync(full) ? readFileSync(full, "utf8") : null;
};

const advice = (problems: string[]) =>
  `${problems.join("\n")}\nA country is not installed without its spec: write ` +
  `docs/specs/<country>-<product>.md (programs, benchmarks, country code, official ` +
  `source links) and name it in the adapter's specDoc. See ${GUIDE} sections 5 and 6.`;

describe("every installed bond adapter is documented", () => {
  it("finds the adapters it guards", () => {
    expect(INSTALLED_BOND_ADAPTERS.length).toBeGreaterThan(0);
  });

  it.each(INSTALLED_BOND_ADAPTERS.map((a) => [a.countryCode, a] as const))(
    "%s has a spec that names its programs, benchmarks, country code and an official source",
    (_country, adapter) => {
      const problems = adapterDocProblems(adapter, fromRepo);
      if (problems.length > 0) throw new Error(advice(problems));
    },
  );

  it("the check itself reports what is missing", () => {
    const adapter = {
      countryCode: "XX",
      specDoc: "docs/specs/xx.md",
      programs: [{ programCode: "ABC" }, { programCode: "DEF" }],
      benchmarks: [{ code: "XX_RATE" }],
    } as unknown as BondAdapter;
    const text = "Country XX sells ABC. No link here. XX_RATE_OTHER.";
    const problems = adapterDocProblems(adapter, () => text);
    expect(problems).toEqual([
      "adapter XX: docs/specs/xx.md never mentions the program DEF",
      "adapter XX: docs/specs/xx.md never mentions the benchmark XX_RATE",
      "adapter XX: docs/specs/xx.md links no official source (an https:// address of the issuer or publisher)",
    ]);
    expect(adapterDocProblems(adapter, () => null)).toEqual([
      "adapter XX: the spec docs/specs/xx.md does not exist",
    ]);
    expect(
      adapterDocProblems({ ...adapter, specDoc: "../x.md" }, () => text),
    ).toHaveLength(1);
    expect(
      adapterDocProblems(
        adapter,
        () => "XX ABC DEF XX_RATE https://example.org/source",
      ),
    ).toEqual([]);
  });
});
