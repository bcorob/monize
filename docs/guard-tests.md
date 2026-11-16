# Writing and reading the guard tests

A guard test is a source scan that fails on every occurrence of a pattern the repository has decided against. The rule it holds is written in a `CLAUDE.md` or a `docs/` entry as one sentence; the guard is the version the machine checks, and its failure message names the thing to use instead. This document holds the conventions for writing one, moved out of `AGENTS.md` because they matter only when a guard is being written or has fired.

## A baseline is shrink-only

Several guards carry a recorded baseline or grandfather list of pre-existing violations (`ui-conventions.test.ts`, `RTL_IMPORT_BASELINE`, `KNOWN_CONTRAST_DEBT`, the optional-format DTO exemptions, the array-bound grandfather list). A baseline may only lose entries: converting a file means deleting its line, and a change is never made to pass by adding one. Where an exemption is genuinely a decision, it is recorded beside the guard with its reason, so the next reader can tell a decision from an omission.

## A source scan reads code, so strip the comments before matching

A guard that bans a pattern is documented by prose that has to *name* that pattern, so scanning raw text makes the explanation fail the guard -- and the cheap way out is weakening the comment, which is the opposite of the point. `frontend/src/lib/loan-history.guard.test.ts` blanks comments while preserving line numbers (so the offender report still points at the right line) and tests the stripper in both directions: a scan that prose can trip is also a scan that prose can satisfy.

## A mocked filesystem cannot demonstrate a filesystem property

`rename` being called is not the claim; what the directory looks like after an unfinished write is. For anything about atomicity, containment, symlinks or ownership, use a real temporary directory (`mkdtemp`) -- `backend/src/backup/atomic-file.spec.ts` and `auto-backup.service.spec.ts` are the pattern. Skip a permission case under uid 0 rather than weakening it into an assertion that passes for the wrong reason.

## A guard that walks the tree with `gitListFiles` cannot see an untracked file

`doc-paths.spec.ts`, `source-comment-paths.spec.ts` and `jest-config.guard.spec.ts` list their subjects with `git ls-files` (`backend/src/common/repo-tree.util.ts`), so a brand-new file is invisible to them until staged. Green before `git add` and red in CI on the same content is not a flake -- run those guards after staging (`git add -N` is enough).

## A doc that names an identifier is making a claim about the source

Renaming or deleting a field, flag or helper means grepping `docs/` and every `CLAUDE.md` in the same commit. A comment asserting that *every* call site does something is a scanning test, not a comment. For named *files* the machine checks: `backend/src/common/doc-paths.spec.ts` fails when a path (bare filenames included) in any `CLAUDE.md`, top-level `docs/*.md`, `docs/frontend/*.md` or `docs/backend/*.md` does not resolve. `docs/future-plans/` may name files that do not exist yet, but an unresolved path whose basename exists elsewhere is a moved file and fails. `docs/release-notes/` and `docs/audits/` are shipped records, out of scope. A path in another branch or repository is qualified (`branch:path/to/file.md`); a doc arguing a file is *missing* names it in plain prose, since a backticked span means "this file is here".

## An exemption the line carries beats an exemption the guard lists

A file list is the right escape for debt that will be paid off (it shrinks) and for a decision about a whole module. It is the wrong one when the legitimate use is a *kind* of line rather than a place: listing the file exempts everything in it, including the next offender someone adds. `frontend/src/components/calendar/calendar.guard.test.ts` bans the app's red on a figure but allows it on a line carrying `role="alert"`, because an error announces itself and a figure cannot take that escape without being announced as an error. The exemption is then checked in both directions, like the comment stripper: the guard must still fail the same markup without the attribute.
