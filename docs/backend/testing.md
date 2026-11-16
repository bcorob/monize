# Backend: testing conventions

The two Jest configs and why they never run together, the state of the E2E suites, and what a mock, a fixture and a green run each prove. Read this before writing or changing a spec, a test helper or a Jest config.

Paths beginning with `src/`, `test/` or `scripts/`, and layer configuration filenames, are relative to `backend/`; other source paths are relative to `backend/src/`. Explicit repository prefixes are preserved. `backend/CLAUDE.md` is the short index; this document is where the reasoning lives.

## The parallel config cannot see `test/`, and `npm test` serializes the two suites

`test/integration/*` rebuilds the schema of the one shared `monize_test`
database (`synchronize` + `dropSchema`), so two Jest workers running any two of
those suites race each other -- `pg_type_typname_nsp_index` conflicts, or a
"connection terminated" reported by whichever spec was innocent. The root Jest
config in `package.json` therefore pins `roots: ["<rootDir>/src"]`: a bare
`jest` (and `test:watch`, `test:debug`) discovers unit specs only. Integration
specs are owned by `test/jest-integration.json`, which finds
`test/integration/*.spec.ts` only and pins `maxWorkers: 1`, and
`npm test` runs `test:unit` then `test:integration` (through
`backend/scripts/test-chain.mjs`) so the default command runs everything without ever
running the two in parallel. That makes `npm test` require a reachable
PostgreSQL (`pretest:integration` creates `monize_test` if it is missing);
`npm run test:unit` is the offline path.
`src/common/jest-config.guard.spec.ts` fails if any of those facts stops being
true.

**`npm test` takes no Jest arguments, and says so rather than ignoring them.**
npm appends `npm test -- <args>` to the *end* of the script, so in a chained
command they become the next `npm run`'s flags: npm swallows them, Jest never
sees them, and the filtered run silently becomes a full one. Filtered runs go
through `npm run test:unit -- <args>` or `npm run test:integration -- <args>`.

**Discovery lives in a config, not in a script.** `--testPathPatterns` and `-t`
may narrow what a config found, and only when the script carries none of its
own: Jest ORs every path pattern it is given, so a script-level
`--testPathPatterns` for the whole directory made
`npm run test:integration -- <file>` run every suite. That is why
`test:integration` selects `test/jest-integration.json` instead, and the guard
refuses a `--testPathPatterns` on it. `--roots`, `--rootDir`, `--testRegex`,
`--testMatch`, `--testPathIgnorePatterns`, `--projects` and `--preset` redefine
it, and the guard rejects any script that passes one -- `jest --roots ./src
./test` would sweep the database-backed suites back into the parallel run with
every config in the repository still correct.

**The serialization is not a preference, and it stays until the suites stop
sharing a database.** A `dropSchema: true` suite is safe to run beside another
only when each worker owns its own database or schema; until that exists, one
worker is the mechanism, and `--runInBand` at a call site is not a substitute
for the config pinning it.

## The unit config transpiles; `npm run typecheck` is what type-checks

The root Jest config runs ts-jest with `isolatedModules: true` (and
`module: commonjs`, so a dynamic `import()` of a mocked ESM-only package becomes
a `require` Jest can intercept). Each file is transpiled on its own, with no
type information. With full per-file type-checking a 12-suite slice took about
5 minutes; transpiling, it takes about 15 seconds. Type errors in `src/` and
`test/` are caught by `npx tsc --noEmit` and `npm run typecheck`, which CI runs
in the lint job, not by the unit run.

Transpiling without type information has one trap: a name that is imported only
as a type cannot also stand for a global value. `cause instanceof Response`,
with `Response` imported from `express`, works under `tsc` but is rewritten to
the import's (undefined) binding when a file is transpiled alone; write
`globalThis.Response`.

**A unit run's output is its results, not the services' logs.**
`src/test-helpers/silence-nest-logger.setup.ts` (a `setupFiles` entry) removes
Nest's static logger and keeps `TestingModuleBuilder.compile()` from installing
its error-printing `TestingLogger`. Spies on `Logger.prototype` or on a
service's `logger` still record every call. A spec that loads a fresh module
registry (`jest.isolateModules`) gets its own `@nestjs/common` and silences that
copy itself.

## `test/*.e2e-spec.ts` is not a gate, and three of the five suites are broken

CI runs `test:unit` and `test:integration` (filtered to `test/integration/*.spec.ts`). Nothing runs `test:e2e`, and separate rot accumulated behind a since-fixed compile error (`npm run typecheck` now closes the compile half in CI):

| Suite | State | Why |
|---|---|---|
| `test/payee-detail.e2e-spec.ts` | passes (9 tests) | fine; this is the spec that caught the raw-select transformer class of bug |
| `test/category-detail.e2e-spec.ts` | passes (9 tests) | fine; same shape as the payee one |
| `test/payees.e2e-spec.ts` | fails | calls services directly, so no request scope; never converted for RLS (`withScopedDb` throws without ambient context) |
| `test/auth.e2e-spec.ts` | fails | `AuthController` gained a `TokenService` dependency its test module does not provide |
| `test/transactions.e2e-spec.ts` | fails | `DelegateTransferMaskInterceptor` gained a `CrossOwnerAccessService` dependency its test module does not provide |

Repair them or delete them -- what they must not stay is present, cited, and dead. Do not add `test:e2e` to CI until the three are fixed; it will be red.

## An integration suite that wants RLS enforced needs two connections

`createIntegrationModule(modules)` builds the schema as the table **owner**, and the owner bypasses row-level security -- so a suite built that way observes each service's own `WHERE user_id = $1` and nothing about the policies. `createEnforcedIntegrationModule(modules)` (`test/helpers/integration-setup.ts`) is the opt-in: the owner connection it returns as `owner` builds the schema, applies the policies **and** the enable migration, and seeds; the module's own connection is the unprivileged `monize_app` role, exactly as `RLS_MODE=enforce` configures the runtime, and the mode is set for the harness's lifetime and restored by `close()`.

Two rules follow. Seed through `owner`: a fixture written through the module's connection has to satisfy the same `WITH CHECK` as the code under test, which makes the fixture evidence of the thing it was meant to be independent of. And assert once, early, that the harness is actually enforcing -- a query outside any scoped transaction must return zero rows. At `RLS_MODE=off` no identity GUC is emitted and every policied query returns nothing, which reads as a scoping bug in every assertion at once rather than as a misconfigured suite; the floor assertion says which it is. `calendar-read-models.integration.spec.ts` is the pattern.

## Testing Conventions

Mock repositories use `Record<string, jest.Mock>`; tests use `Test.createTestingModule` with mocks injected via `getRepositoryToken()`. E2E tests live in `test/` with helpers under `test/helpers/` (`auth-helper.ts`, `test-database.ts`, `test-factories.ts`).

## A mock must return what the real collaborator returns

`Record<string, jest.Mock>` is fine for a repository, whose surface the driver defines. For **one of our own services**, type the double -- `jest.Mocked<TheService>`, or a `Partial<jest.Mocked<T>>` cast once -- so `tsc` rejects a return shape the real method cannot produce. Untyped, a mock quietly becomes fiction, and the branch that reads that fiction is green and unreachable:

- **A shape the driver never returns.** A TypeORM insert result mocked as `{ generatedMaps: [] }` made an entire lost-the-race path testable, tested and dead.
- **A signature that moved.** A method growing from `Promise<boolean>` to `Promise<string | null>` leaves `mockResolvedValue(true)` behind it -- still truthy, still passing. When you change a return type, grep its mocks in the same commit.

## Fixtures are claims about production data

`docs/testing-contract.md` is the shared list of adversarial inputs to choose from. A fixture is evidence only if the code that writes the real data could have written it -- check the producer's sampling, nullability, and format guarantees before adding one. `docs/financial-calculation-contract.md` section 8.3 has the full rule.

## Do not trust a suite that stayed green

Changing what a service computes and seeing every test pass means the change is a no-op or the suite has a hole -- `docs/financial-calculation-contract.md` sections 8.1 and 8.2. Establish which before moving on, and break each new invariant on purpose once to confirm its test actually fails.

## A test that reads the wall clock is a test about today's date

-- `TZ=UTC` pins the offset, not the day (auto-backup promotes artifacts on specific days of the month, so ten assertions failed on `main` with nothing changed). Pin the clock in the spec and derive the pinned value from the constants the behaviour branches on (`WEEKLY_DAYS`, `MONTHLY_DAY` are exported for this). `backend/src/backup/auto-backup.service.spec.ts` is the pattern: fake `Date` only (faking `nextTick`/`queueMicrotask` under real `fs.promises` deadlocks), install fake timers once, move the date through a single `withClockAt` helper, and let a source scan fail a second installation.
