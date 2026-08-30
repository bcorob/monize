import { Global, Injectable, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { ProviderHealthModule } from "./provider-health.module";
import { ProviderHealthService } from "./provider-health.service";

/**
 * Stands in for `TypeOrmModule.forRootAsync`, whose core module is `@Global()`
 * and is how `DataSource` reaches every provider in the real app.
 */
@Global()
@Module({
  providers: [{ provide: DataSource, useValue: {} }],
  exports: [DataSource],
})
class FakeDatabaseModule {}

/**
 * The one thing every other spec in this folder cannot see.
 *
 * Each of them constructs the service with `new`, so a constructor Nest cannot
 * resolve leaves the whole suite green and the container dead on boot:
 * TypeScript emits `Function` as the `design:paramtypes` entry for the injected
 * clock, which is not a provider token, and Nest refuses with "can't resolve
 * dependencies of the ProviderHealthService (DataSource, ?)". That is exactly
 * what happened, and it is the class of defect a unit test cannot reach --
 * only asking the injector can.
 */
describe("ProviderHealthModule", () => {
  it("constructs the service through Nest's injector", async () => {
    const module = await Test.createTestingModule({
      imports: [FakeDatabaseModule, ProviderHealthModule],
    }).compile();

    expect(module.get(ProviderHealthService)).toBeInstanceOf(
      ProviderHealthService,
    );
  });

  it("exports it, so a provider client in another module can inject it", async () => {
    // SecuritiesModule's clients depend on this: a module that provides the
    // service without exporting it compiles, and then every quote client fails
    // to resolve at boot.
    @Injectable()
    class FakeQuoteClient {
      constructor(readonly health: ProviderHealthService) {}
    }

    @Module({
      imports: [ProviderHealthModule],
      providers: [FakeQuoteClient],
    })
    class ConsumerModule {}

    const module = await Test.createTestingModule({
      imports: [FakeDatabaseModule, ConsumerModule],
    }).compile();

    expect(module.get(FakeQuoteClient).health).toBeInstanceOf(
      ProviderHealthService,
    );
  });
});
