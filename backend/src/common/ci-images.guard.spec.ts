import { readFileSync } from "fs";
import { join } from "path";

import { extractImageRefs } from "./image-ref.util";
import { findRepoRoot, gitListFiles, requireRepoRoot } from "./repo-tree.util";

/**
 * CI pulls third-party container images from a registry without an anonymous
 * pull limit: Google's mirror of the Docker Official Images
 * (`mirror.gcr.io/library/...`, the same content and digests as Docker Hub) or
 * GitHub's own registry (`ghcr.io`), or -- for an image only Microsoft
 * publishes, the Playwright image the E2E shards run in -- Microsoft's own
 * registry (`mcr.microsoft.com`), which is not Docker Hub and needs no login.
 * Not the ECR Public mirror: its anonymous
 * data limit per source IP is exhausted by GitHub's shared runners. A Docker Hub pull from a shared
 * runner IP is rate-limited, and a login needs DOCKERHUB_* secrets a fork does
 * not have, so a Docker Hub image turns a job red for reasons no change caused.
 * `docs/verification-contract.md` section 7.
 *
 * Scanned: every `image:` in `.github/workflows/*.yml` and in the compose file
 * CI runs (`docker-compose.e2e.yml`), every `*_IMAGE=` default in
 * `scripts/*.sh`, and every `FROM` in a tracked Dockerfile (CI builds them for
 * the E2E, Lighthouse and ZAP jobs). Allowed: the three registries above, a
 * GitHub expression (`${{ ... }}`), an image CI builds itself (a `:local` tag),
 * a build argument (`$VAR`) and an earlier stage of the same Dockerfile. No
 * workflow logs in with DOCKERHUB_* secrets: nothing needs it.
 */

const ALLOWED = [
  /^mirror\.gcr\.io\//,
  /^ghcr\.io\//,
  /^mcr\.microsoft\.com\//,
  /^\$\{\{.*\}\}/,
  /^[a-z0-9._-]+:local$/,
];

export function disallowedImages(
  file: string,
  text: string,
): Array<{ line: number; image: string }> {
  return extractImageRefs(file, text).filter(
    ({ image }) => !ALLOWED.some((pattern) => pattern.test(image)),
  );
}

describe("disallowedImages", () => {
  it("refuses a Docker Hub base image in a Dockerfile, not an earlier stage", () => {
    const text = [
      "FROM node:24-alpine AS development",
      "FROM mirror.gcr.io/library/node:24-slim AS builder",
      "FROM builder AS production",
      "FROM --platform=$BUILDPLATFORM $BASE",
    ].join("\n");
    expect(disallowedImages("backend/Dockerfile", text)).toEqual([
      { line: 1, image: "node:24-alpine" },
    ]);
  });

  it("refuses a Docker Hub image in a workflow or compose file", () => {
    expect(
      disallowedImages("ci.yml", "    image: postgres:16-alpine\n"),
    ).toEqual([{ line: 1, image: "postgres:16-alpine" }]);
    expect(
      disallowedImages("ci.yml", "    image: docker.io/library/nginx:1\n"),
    ).toEqual([{ line: 1, image: "docker.io/library/nginx:1" }]);
    expect(
      disallowedImages(
        "ci.yml",
        "    image: public.ecr.aws/docker/library/nginx:1\n",
      ),
    ).toEqual([{ line: 1, image: "public.ecr.aws/docker/library/nginx:1" }]);
  });

  it("refuses a Docker Hub default in a script", () => {
    expect(
      disallowedImages("verify.sh", 'PG_IMAGE="${PG_IMAGE:-postgres:16}"\n'),
    ).toEqual([{ line: 1, image: "postgres:16" }]);
    expect(disallowedImages("verify.sh", 'PG_IMAGE="postgres:16"\n')).toEqual([
      { line: 1, image: "postgres:16" },
    ]);
  });

  it("accepts mirror.gcr.io, ghcr.io, mcr.microsoft.com, an expression and a local build", () => {
    const text = [
      "image: mirror.gcr.io/library/postgres:16-alpine@sha256:abc",
      "image: ghcr.io/owner/app",
      "image: mcr.microsoft.com/playwright:v1.64.0-noble@sha256:abc",
      "image: ${{ matrix.image }}@${{ steps.build.outputs.digest }}",
      "image: monize-e2e-backend:local",
      "# image: postgres:16",
    ].join("\n");
    expect(disallowedImages("ci.yml", text)).toEqual([]);
    expect(
      disallowedImages(
        "v.sh",
        'PG_IMAGE="${PG_IMAGE:-mirror.gcr.io/library/postgres:16}"',
      ),
    ).toEqual([]);
    expect(
      disallowedImages(
        "e2e-playwright.sh",
        'IMAGE="mcr.microsoft.com/playwright:v1.64.0-noble@sha256:abc"',
      ),
    ).toEqual([]);
  });
});

const REPO_ROOT = findRepoRoot(__dirname);
const describeTree = REPO_ROOT || process.env.CI ? describe : describe.skip;

describeTree("CI pulls no image from Docker Hub", () => {
  it("every image CI pulls comes from mirror.gcr.io, ghcr.io or mcr.microsoft.com", () => {
    const root = requireRepoRoot(REPO_ROOT);
    const files = gitListFiles(root).filter(
      (path) =>
        /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path) ||
        path === "docker-compose.e2e.yml" ||
        /^scripts\/[^/]+\.sh$/.test(path) ||
        /(^|\/)Dockerfile[^/]*$/.test(path),
    );
    expect(files).toEqual(
      expect.arrayContaining([
        ".github/workflows/ci.yml",
        "docker-compose.e2e.yml",
        "scripts/verify-schema.sh",
        "backend/Dockerfile",
        "frontend/Dockerfile",
      ]),
    );

    const offenders = files.flatMap((file) =>
      disallowedImages(file, readFileSync(join(root, file), "utf8")).map(
        ({ line, image }) => `${file}:${line}: ${image}`,
      ),
    );
    if (offenders.length > 0) {
      throw new Error(
        `CI pulls these images from Docker Hub (rate-limited, needs a login a fork lacks):\n  ${offenders.join(
          "\n  ",
        )}\nUse Google's mirror of the official image, mirror.gcr.io/library/<name>:<tag> (same digests), ghcr.io, or mcr.microsoft.com for an image only Microsoft publishes. docs/verification-contract.md section 7.`,
      );
    }
  });

  it("no workflow logs in to Docker Hub", () => {
    const root = requireRepoRoot(REPO_ROOT);
    const logins = gitListFiles(root)
      .filter((path) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path))
      .filter((path) =>
        /secrets\.DOCKERHUB_/.test(readFileSync(join(root, path), "utf8")),
      );
    expect(logins).toEqual([]);
  });
});
