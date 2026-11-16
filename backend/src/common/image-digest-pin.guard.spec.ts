import { readFileSync } from "fs";
import { join } from "path";

import { extractImageRefs } from "./image-ref.util";
import { findRepoRoot, gitListFiles, requireRepoRoot } from "./repo-tree.util";

/**
 * A tag is a name, not content: whoever controls the publishing account, or a
 * compromised registry or mirror, can repoint `node:24-alpine` at different
 * bytes, and the next pull takes it with nothing in this repository or in
 * review to show it changed. This is the same rule the project already
 * applies to GitHub Actions, pinned to a full commit SHA
 * (`docs/release-integrity.md` section 5).
 *
 * `docs/container-images.md` is the map from a pinned tag to the digest
 * actually pulled. This guard scans the same files as
 * `ci-images.guard.spec.ts` (every tracked Dockerfile, `docker-compose.e2e.yml`,
 * and every workflow and shell script) and fails when:
 *   - a third-party image this repository builds or starts (`mirror.gcr.io`,
 *     `mcr.microsoft.com`) is named by tag alone, with no `@sha256:` digest;
 *   - a digest a file pins has no row in `docs/container-images.md`'s
 *     "Pinned images" table, so a reviewer cannot see what the pin means; or
 *   - a digest in that table is not actually pinned anywhere, so the map has
 *     gone stale.
 *
 * Out of scope deliberately: `ghcr.io/kenlasko/*` (this project's own images)
 * and the project's own user-facing compose files and Helm chart --
 * `:latest` there is a deliberate convenience for self-hosters, decided
 * separately (issue #1837, item 5).
 */

const DIGEST_REQUIRED = [/^mirror\.gcr\.io\//, /^mcr\.microsoft\.com\//];

const SHA256 = /@sha256:[0-9a-f]{64}$/;

export function missingDigestPin(
  file: string,
  text: string,
): Array<{ line: number; image: string }> {
  return extractImageRefs(file, text).filter(
    ({ image }) =>
      DIGEST_REQUIRED.some((pattern) => pattern.test(image)) &&
      !SHA256.test(image),
  );
}

export function imageDigest(image: string): string | null {
  const m = /@sha256:([0-9a-f]{64})$/.exec(image);
  return m ? m[1] : null;
}

/**
 * Digests listed in the "Pinned images" table only -- not the per-platform
 * manifest table underneath it, whose digests describe a single-platform
 * manifest nothing ever pulls directly. That table's rows have no `/` in
 * their first column (a tag, not `registry/path`), which is what tells the
 * two apart.
 */
export function pinnedDigestsInDoc(doc: string): Set<string> {
  const digests = new Set<string>();
  const rowPattern =
    /^\|\s*`([\w.-]+\/[^`]+)`\s*\|\s*`[^`]+`\s*\|\s*`sha256:([0-9a-f]{64})`\s*\|/gm;
  for (const match of doc.matchAll(rowPattern)) {
    digests.add(match[2]);
  }
  return digests;
}

describe("missingDigestPin", () => {
  it("flags a mirror.gcr.io or mcr.microsoft.com image with no digest", () => {
    expect(
      missingDigestPin(
        "backend/Dockerfile",
        "FROM mirror.gcr.io/library/node:24-alpine AS development\n",
      ),
    ).toEqual([{ line: 1, image: "mirror.gcr.io/library/node:24-alpine" }]);
    expect(
      missingDigestPin(
        "ci.yml",
        "    image: mcr.microsoft.com/playwright:v1.64.0-noble\n",
      ),
    ).toEqual([
      { line: 1, image: "mcr.microsoft.com/playwright:v1.64.0-noble" },
    ]);
  });

  it("accepts a digest-pinned reference", () => {
    expect(
      missingDigestPin(
        "backend/Dockerfile",
        "FROM mirror.gcr.io/library/node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS development\n",
      ),
    ).toEqual([]);
  });

  it("does not require a digest from a registry the pin rule does not cover", () => {
    expect(
      missingDigestPin(
        "ci.yml",
        "    image: ghcr.io/kenlasko/monize-backend\n",
      ),
    ).toEqual([]);
    expect(
      missingDigestPin(
        "ci.yml",
        "    image: ${{ matrix.image }}@${{ steps.build.outputs.digest }}\n",
      ),
    ).toEqual([]);
    expect(
      missingDigestPin("ci.yml", "    image: monize-e2e-backend:local\n"),
    ).toEqual([]);
  });
});

describe("pinnedDigestsInDoc", () => {
  it("reads the Pinned images table, not the per-platform manifest table", () => {
    const doc = [
      "## Pinned images",
      "",
      "| Image | Tag | Digest | Used in |",
      "| --- | --- | --- | --- |",
      "| `mirror.gcr.io/library/postgres` | `16-alpine` | `sha256:" +
        "16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229` | `ci.yml` |",
      "",
      "| Tag | Platform | Manifest digest |",
      "| --- | --- | --- |",
      "| `v1.64.0-noble` | `linux/amd64` | `sha256:" +
        "bc72a8df40831ded821e3cbc79c318c21b44d6e51dff9fd89ace7a8249c5b462` |",
    ].join("\n");

    expect(pinnedDigestsInDoc(doc)).toEqual(
      new Set([
        "16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229",
      ]),
    );
  });
});

const REPO_ROOT = findRepoRoot(__dirname);
const describeTree = REPO_ROOT || process.env.CI ? describe : describe.skip;

describeTree("third-party image references are pinned by digest", () => {
  it("every mirror.gcr.io or mcr.microsoft.com reference carries @sha256:", () => {
    const root = requireRepoRoot(REPO_ROOT);
    const files = gitListFiles(root).filter(
      (path) =>
        /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path) ||
        path === "docker-compose.e2e.yml" ||
        /^scripts\/[^/]+\.sh$/.test(path) ||
        /(^|\/)Dockerfile[^/]*$/.test(path),
    );

    const offenders = files.flatMap((file) =>
      missingDigestPin(file, readFileSync(join(root, file), "utf8")).map(
        ({ line, image }) => `${file}:${line}: ${image}`,
      ),
    );
    if (offenders.length > 0) {
      throw new Error(
        `These third-party images are named by tag alone, with no @sha256: digest:\n  ${offenders.join(
          "\n  ",
        )}\nRead the index digest from the registry and pin name:tag@sha256:<digest>. docs/container-images.md has the commands.`,
      );
    }
  });

  it("every pinned digest has a row in docs/container-images.md, and every row is actually pinned somewhere", () => {
    const root = requireRepoRoot(REPO_ROOT);
    const files = gitListFiles(root).filter(
      (path) =>
        /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path) ||
        path === "docker-compose.e2e.yml" ||
        /^scripts\/[^/]+\.sh$/.test(path) ||
        /(^|\/)Dockerfile[^/]*$/.test(path),
    );

    const digestsInFiles = new Map<string, string[]>();
    for (const file of files) {
      const text = readFileSync(join(root, file), "utf8");
      for (const { line, image } of extractImageRefs(file, text)) {
        const digest = imageDigest(image);
        if (digest === null) continue;
        const sites = digestsInFiles.get(digest) ?? [];
        sites.push(`${file}:${line}`);
        digestsInFiles.set(digest, sites);
      }
    }

    const doc = readFileSync(join(root, "docs/container-images.md"), "utf8");
    const digestsInDoc = pinnedDigestsInDoc(doc);

    const undocumented = [...digestsInFiles.keys()].filter(
      (digest) => !digestsInDoc.has(digest),
    );
    if (undocumented.length > 0) {
      throw new Error(
        `These pinned digests have no row in docs/container-images.md's "Pinned images" table:\n  ${undocumented
          .map(
            (digest) =>
              `sha256:${digest} (${digestsInFiles.get(digest)!.join(", ")})`,
          )
          .join(
            "\n  ",
          )}\nAdd a row, so a reviewer can see what the pin means without querying a registry.`,
      );
    }

    const stale = [...digestsInDoc].filter(
      (digest) => !digestsInFiles.has(digest),
    );
    if (stale.length > 0) {
      throw new Error(
        `These digests are listed in docs/container-images.md's "Pinned images" table but no scanned file actually pins them:\n  ${stale
          .map((digest) => `sha256:${digest}`)
          .join(
            "\n  ",
          )}\nUpdate the table, or the reference it describes, so the map does not go stale silently.`,
      );
    }
  });
});
