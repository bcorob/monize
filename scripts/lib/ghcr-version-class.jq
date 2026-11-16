# Classify one GHCR container package version for the prune sweep.
#
# This is the predicate that decides whether a version is DELETED, so it lives
# in one file that both passes of prune-ghcr-untagged.sh read and that
# scripts/ghcr-version-class.test.mjs exercises directly. Spelled out per call
# site it would be two copies of a destructive rule, and the dangerous half is
# invisible in a passing run: a version carrying BOTH a per-PR tag and a live
# one is a single version, so deleting it for its `pr-` tag takes `:latest` or
# `:beta` with it. That case is why "every tag is a per-PR tag" is the test,
# never "any tag is".
#
# Classes:
#   "keep"    carries at least one tag that is not a per-PR tag -- never pruned
#   "per-pr"  tagged, and EVERY tag is `pr-<n>` -- prunable (per-PR publishing
#             was retired; see .github/workflows/ci.yml)
#   "untagged" no tags at all -- prunable if nothing live references its digest
#
# The pattern is anchored on purpose: `pr-1290` is a per-PR tag, while `pr-abc`,
# `pr-` and `preview` are not, and a version wearing one of those is kept.

def per_pr_tag: test("^pr-[0-9]+$");

def version_class:
  (.metadata.container.tags // []) as $tags
  | if ($tags | length) == 0 then "untagged"
    elif ($tags | all(per_pr_tag)) then "per-pr"
    else "keep"
    end;
