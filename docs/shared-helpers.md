# Shared helpers and the duplicate-function guard

A small generic function is written once per layer and imported everywhere else. `backend/src/common/duplicate-functions.guard.spec.ts` holds the rule; this document says where a shared helper goes, what the guard compares, and how to register a copy that is deliberate.

## Where a generic helper lives

| Layer | Directory |
|---|---|
| backend | `backend/src/common/helpers/` |
| frontend | `frontend/src/lib/helpers/` |

A generic helper knows nothing about the domain and depends on no framework: a type guard, a string or error helper, a pure transform. Each file exports one function and is named after it in kebab-case (`is-record.ts` exports `isRecord`), so listing the directory is the index: no barrel file and no list to keep in sync. Run `ls` on the layer's directory before writing a small function.

Two kinds of helper stay where they are:

- a helper with domain knowledge (a receipt refusal, a loan figure, a report's column style) lives in its feature module, written once there;
- a date, money or FX helper that an instruction file already names (`addDaysYMD`, `enumerateDaysYMD`, `roundMoney`, `roundFxRate`, `resolveFxRate`) stays where it is named.

The layers have no shared package, so a backend helper and its frontend twin are two files. A twin that computes a figure both layers show is held by a parity test over one fixture, as `phone-number-cases.json` and `mortgage-type-cases.json` are.

## What the guard compares

The guard runs in the Backend Unit Tests job and in `npm run test:changed`. It lists the non-test `.ts` and `.tsx` files under `backend/src` and `frontend/src` with `git ls-files`, so a new file is seen once it is staged (`git add -N` is enough). In each file it takes the top-level functions: function declarations and `const` arrow or function expressions.

For each function it builds the token sequence of its type parameters, parameters, return type and body. The name, the modifiers, comments, JSDoc and whitespace are left out, and the function's own parameters are renamed by position. Two functions in one layer with the same sequence are copies, whatever they are called. A function shorter than `MIN_TOKENS` (a constant in the guard) is ignored, so a one-line arrow is never a finding.

The guard does not see:

- class methods;
- a copy whose local variables were renamed;
- the same logic written in different code;
- a backend function and its frontend twin.

Those are for review and for parity tests.

## When the guard fails

The failure names the copy and every other member of its group with `path:line`. In order of preference:

1. Import the existing function. If it is generic and sits in a feature file, move it to the layer's helpers directory and import it from every former copy.
2. If it has domain knowledge, keep one copy in its feature module and import that one.
3. If the copy is deliberate, register it as an exception (next section).

Never add an entry to the baseline.

## Registering an exception

Put a line comment directly above the copy, with the reason:

```ts
// allow-duplicate: standalone script, runs before the application's modules load
function requiredEnv(name: string): string {
```

- The reason is required. A marker with no reason, or one shorter than 10 characters, fails.
- Mark only the deliberate copy. The unmarked function stays the original, and a group with one unmarked member left passes.
- A marker on a function that no longer has a twin fails. Delete the marker when its twin goes.
- `git grep "allow-duplicate:"` lists every registered exception. A reviewer reads the reason as a decision, the same as any other exemption (`docs/guard-tests.md`).

## The baseline

`BASELINE` in the guard lists, as `path#name`, the copies that existed when the guard was added. It is shrink-only (`docs/guard-tests.md`): an entry goes away when its copy is replaced by an import, and an entry whose copy no longer exists fails until the line is deleted. Moving or renaming a baselined copy is the moment to remove it, not to re-add it under the new path.
