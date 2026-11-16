import { readFileSync } from "fs";
import { join } from "path";

import { findRepoRoot, gitListFiles } from "../../common/repo-tree.util";

/**
 * Every integration suite that wires the attachment graph wires all of it.
 *
 * Three suites built their own Nest testing module with `DatabaseStorageProvider`
 * and the `ATTACHMENT_STORAGE_PROVIDER` token, which was the whole graph until
 * `AttachmentStorageRegistry` joined it -- and then all three failed together with
 * "Nest can't resolve dependencies of the AttachmentsService". Nest resolves
 * providers at run time, so `tsc` cannot see the gap and neither can the unit
 * suite: the only job that noticed was the nine-minute database-backed one, and it
 * noticed after the push.
 *
 * `attachmentStorageProviders()` (`test/helpers/integration-setup.ts`) is now the
 * one place that list lives, so the next provider added to the graph is one edit
 * rather than four. This guard is what makes that true rather than hoped for: a
 * suite naming the token directly is a second copy of the list, and the failure it
 * causes is a red CI job instead of a red unit test.
 *
 * Scoped to `test/integration/`, because `src/**` specs construct services with
 * `new` and the compiler already fails them on a missing argument.
 */

/**
 * What a suite must not spell out for itself, and the helper it takes instead.
 *
 * The population is "suites that touch the attachment storage graph at all",
 * which is why the helper's own name is one of the markers: selecting only on the
 * things a correct suite no longer mentions would leave this guard matching
 * nothing the moment it was satisfied -- and a guard that matches nothing passes
 * forever.
 */
const OWN_COPY = ["ATTACHMENT_STORAGE_PROVIDER", "DatabaseStorageProvider"];
const HELPER = "attachmentStorageProviders";

const REPO_ROOT = findRepoRoot(__dirname);
const describeTree = REPO_ROOT || process.env.CI ? describe : describe.skip;

describeTree(
  "integration suites wire the whole attachment storage graph",
  () => {
    const root = REPO_ROOT as string;

    /** Integration specs that touch the attachment storage graph at all. */
    const suites = (): string[] =>
      gitListFiles(root, "backend/test/integration")
        .filter((file) => file.endsWith(".spec.ts"))
        .filter((file) => {
          const source = readFileSync(join(root, file), "utf8");
          return [...OWN_COPY, HELPER].some((marker) =>
            source.includes(marker),
          );
        });

    it("has integration suites to check", () => {
      // A guard that silently matches nothing passes forever. If the suites move,
      // this fails and says so rather than going quiet.
      expect(suites().length).toBeGreaterThan(0);
    });

    it.each(suites())("%s takes the providers from the helper", (file) => {
      const source = readFileSync(join(root, file), "utf8");

      expect(source).toContain(`${HELPER}(`);
      // And does not keep a second copy of the list beside it: that copy is what
      // went stale, in three suites at once.
      for (const marker of OWN_COPY) {
        expect(source).not.toContain(marker);
      }
    });
  },
);
