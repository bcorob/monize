import "reflect-metadata";
import { StrategiesModule } from "./strategies.module";
import { SecuritiesModule } from "../securities/securities.module";
import { CurrenciesModule } from "../currencies/currencies.module";
import { NotificationsModule } from "../notifications/notifications.module";

/**
 * Every constructor dependency this module takes from another module must be
 * exported by that module.
 *
 * Nest checks this at boot and nowhere earlier. Every other spec in this
 * folder builds its subject with `new GemPositionService(...)` and hand-made
 * doubles, which proves the class works and says nothing about whether the
 * container can construct it -- so adding a dependency whose provider was
 * declared but not exported passed lint, type-check, 10 500 unit tests and the
 * integration suite, and then exited during application bootstrap, taking
 * Lighthouse and all four E2E shards with it under a failure that named
 * nothing.
 *
 * Compiling the real graph here is not practical: `SecuritiesModule` pulls in
 * most of the application. This reads the decorator metadata instead, which is
 * the same information Nest resolves against, and fails on exactly the mistake
 * above. It does not prove the whole application boots -- only that this
 * module's cross-boundary wiring is declared.
 */
type Ctor = { name: string };

function metadata(target: object, key: string): Ctor[] {
  return (Reflect.getMetadata(key, target) as Ctor[]) ?? [];
}

describe("StrategiesModule dependency graph", () => {
  const own = new Set(
    [
      ...metadata(StrategiesModule, "providers"),
      ...metadata(StrategiesModule, "controllers"),
    ].map((provider) => provider?.name),
  );

  const available = new Set(
    [
      ...metadata(SecuritiesModule, "exports"),
      ...metadata(CurrenciesModule, "exports"),
      // The GEM signal-change cron dispatches through NotificationDispatchService.
      ...metadata(NotificationsModule, "exports"),
    ].map((provider) => provider?.name),
  );

  /** Injectables Nest supplies without a module exporting them. */
  const AMBIENT = new Set(["DataSource", "EntityManager", "Repository"]);

  it("declares providers to check, so the assertion is not vacuous", () => {
    expect(own.size).toBeGreaterThan(5);
    expect(available.size).toBeGreaterThan(0);

    // And the dependency lists are actually readable. Every case below reads
    // `design:paramtypes`, which only exists while `emitDecoratorMetadata` is
    // on; without it each provider would present an empty dependency list and
    // the whole guard would pass having checked nothing.
    const withDeps = metadata(StrategiesModule, "providers").filter(
      (provider) => metadata(provider, "design:paramtypes").length > 0,
    );
    expect(withDeps.length).toBeGreaterThan(3);
  });

  it.each(
    [
      ...metadata(StrategiesModule, "providers"),
      ...metadata(StrategiesModule, "controllers"),
    ].map((provider) => [provider.name, provider] as const),
  )("%s can have every dependency resolved", (_name, provider) => {
    const deps = metadata(provider, "design:paramtypes");
    const unresolvable = deps
      .map((dep) => dep?.name)
      .filter(
        (name) =>
          name !== undefined &&
          !own.has(name) &&
          !available.has(name) &&
          !AMBIENT.has(name) &&
          // Repository<X> injections arrive as the Object/Function shape.
          !["Object", "Function"].includes(name),
      );

    expect(unresolvable).toEqual([]);
  });
});
