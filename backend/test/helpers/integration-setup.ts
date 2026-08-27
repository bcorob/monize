import { Test, TestingModule } from "@nestjs/testing";
import { Global, Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ConfigModule } from "@nestjs/config";
import { I18nService } from "nestjs-i18n";
import { DataSource } from "typeorm";
import { User } from "@/users/entities/user.entity";
import { NetWorthService } from "@/net-worth/net-worth.service";
import { ScheduledTransactionsModule } from "@/scheduled-transactions/scheduled-transactions.module";
import { ScheduledTransaction } from "@/scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "@/scheduled-transactions/entities/scheduled-transaction-split.entity";
import { ScheduledTransactionOverride } from "@/scheduled-transactions/entities/scheduled-transaction-override.entity";
import { Account } from "@/accounts/entities/account.entity";
import { ScheduledTransactionsService } from "@/scheduled-transactions/scheduled-transactions.service";
import { ScheduledTransactionOverrideService } from "@/scheduled-transactions/scheduled-transaction-override.service";
import { ScheduledTransactionLoanService } from "@/scheduled-transactions/scheduled-transaction-loan.service";
import type { TypeOrmModuleOptions } from "@nestjs/typeorm";
import * as bcrypt from "bcryptjs";
import { applyRlsPolicies } from "./rls-setup";
import { settlePendingPriceWrites } from "@/securities/security-price.service";

/**
 * Shared PostgreSQL connection options for integration suites. Specs that need
 * a real database with a schema synchronized from the entities use this instead
 * of copying the env-var defaults, so a config change lives in one place.
 *
 * **`dropSchema` means suites using this cannot run concurrently.** Every suite
 * drops and rebuilds the schema of the one shared `monize_test` database, so a
 * second worker starting up pulls the tables out from under a running suite --
 * which surfaces as "connection terminated" from an unrelated spec rather than
 * as anything resembling its cause. `test/jest-e2e.json` therefore pins
 * `maxWorkers: 1`; keep it there rather than relying on a `--runInBand` flag at
 * a call site, since the config is what every entry point shares.
 */
export const INTEGRATION_TYPEORM_OPTIONS: TypeOrmModuleOptions = {
  type: "postgres",
  host: process.env.DATABASE_HOST || "localhost",
  port: parseInt(process.env.DATABASE_PORT || "5432"),
  username: process.env.DATABASE_USER || "monize_user",
  password: process.env.DATABASE_PASSWORD || "monize_password",
  database: process.env.DATABASE_NAME || "monize_test",
  entities: [__dirname + "/../../src/**/*.entity{.ts,.js}"],
  synchronize: true,
  dropSchema: true,
};

/**
 * Provides a lightweight I18nService globally to the integration test graph.
 * Several services (email senders, etc.) inject I18nService; the app supplies it
 * via the global nestjs-i18n module, but the integration TestingModule builds
 * feature modules in isolation. A stub avoids pulling in the real I18nModule
 * (whose `watch: true` file watcher would leak a handle and hang Jest). The
 * stub returns the English `defaultValue`, matching production behaviour for the
 * default locale.
 */
@Global()
@Module({
  providers: [
    {
      provide: I18nService,
      useValue: {
        translate: (key: string, options?: { defaultValue?: string }) =>
          options?.defaultValue ?? key,
        t: (key: string, options?: { defaultValue?: string }) =>
          options?.defaultValue ?? key,
      },
    },
  ],
  exports: [I18nService],
})
class TestI18nModule {}

/**
 * What the real `ScheduledTransactionsModule` lets other modules inject, read
 * off its own metadata rather than restated here.
 *
 * The stub below stands in for that module, so its export list is a claim about
 * the real one -- and a hand-written copy of a list only fails when a consumer
 * appears. Issue #1247 added `ScheduledEffectiveAmountService` and
 * `ScheduledOccurrenceService` to those exports and gave
 * `NotificationsModule`/`BudgetsModule` a dependency on them; the stub went on
 * compiling until those consumers were reached, and then eighteen suites failed
 * with "argument ScheduledOccurrenceService at index [5] is available in the
 * NotificationsModule module". Derived, a new export is stubbed the day it
 * exists.
 */
const SCHEDULED_TRANSACTIONS_EXPORTS: unknown[] =
  Reflect.getMetadata("exports", ScheduledTransactionsModule) ?? [];

/** Stubbed but deliberately not exported: internal collaborators the real module keeps to itself. */
const SCHEDULED_TRANSACTIONS_INTERNALS: unknown[] = [
  ScheduledTransactionOverrideService,
  ScheduledTransactionLoanService,
];

/**
 * Creates a NestJS TestingModule wired to a real PostgreSQL database.
 * Uses `synchronize: true` and `dropSchema: true` so each test suite
 * starts with a clean schema derived from entity metadata.
 *
 * Replaces ScheduledTransactionsModule with a stub to break the
 * circular dependency (Transactions -> Accounts -> ScheduledTransactions -> Transactions).
 *
 * NetWorthService.triggerDebouncedRecalc is mocked to a no-op to prevent
 * timer leaks in tests.
 */
export async function createIntegrationModule(
  modules: any[],
): Promise<TestingModule> {
  if (!SCHEDULED_TRANSACTIONS_EXPORTS.includes(ScheduledTransactionsService)) {
    // A floor on the derivation: an empty or unrecognisable metadata read would
    // otherwise produce a stub that exports nothing and blame every consumer.
    throw new Error(
      "could not read ScheduledTransactionsModule's exports -- the integration stub would export nothing",
    );
  }

  const moduleBuilder = Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true }),
      TestI18nModule,
      TypeOrmModule.forRoot(INTEGRATION_TYPEORM_OPTIONS),
      ...modules,
    ],
  })
    // Replace ScheduledTransactionsModule to break circular dependency.
    // AccountsModule imports ScheduledTransactionsModule (forwardRef),
    // which imports TransactionsModule (forwardRef), causing undefined
    // in the circular chain. We stub it with just the entity registrations
    // and mock services.
    .overrideModule(ScheduledTransactionsModule)
    .useModule({
      module: class StubScheduledTransactionsModule {},
      imports: [
        TypeOrmModule.forFeature([
          ScheduledTransaction,
          ScheduledTransactionSplit,
          ScheduledTransactionOverride,
          Account,
        ]),
      ],
      providers: [
        ...SCHEDULED_TRANSACTIONS_EXPORTS,
        ...SCHEDULED_TRANSACTIONS_INTERNALS,
      ].map((token) => ({ provide: token as never, useValue: {} })),
      exports: SCHEDULED_TRANSACTIONS_EXPORTS as never[],
    });

  const module = await moduleBuilder.compile();

  // Bring the synchronize-built schema up to the real database's shape: runtime
  // role + grants, RLS helper functions and policies, updated_at triggers (T1).
  // Policies ship without ENABLE, so this is inert for suites that do not opt
  // into enforcement -- see rls-setup.ts.
  await applyRlsPolicies(module.get(DataSource));

  // Mock triggerDebouncedRecalc to prevent timer leaks
  const netWorthService = module.get(NetWorthService);
  jest
    .spyOn(netWorthService, "triggerDebouncedRecalc")
    .mockImplementation(() => {});

  return module;
}

/**
 * Truncates the given tables (with CASCADE) for inter-test cleanup.
 * Table names should be the SQL table names (snake_case).
 */
export async function cleanTables(
  dataSource: DataSource,
  tableNames: string[],
): Promise<void> {
  // Creating a security or an investment transaction starts a price fetch that
  // nobody awaits, and the write it eventually makes has outlived the request
  // that caused it. Truncating `securities ... CASCADE` underneath one takes
  // the same locks in the opposite order -- a deadlock reported against
  // whichever spec happened to be running -- and when the truncate wins
  // instead, the insert fails as an orphan foreign key. Both look like a bug
  // in the test rather than in its housekeeping.
  //
  // So the tables are only emptied once the database is quiet. This waits on
  // work that has started, not on a duration, so it costs nothing when there
  // is none.
  await settlePendingPriceWrites();
  const tables = tableNames.join(", ");
  await dataSource.query(`TRUNCATE ${tables} CASCADE`);
}

/**
 * Inserts a user directly via DataSource, bypassing AuthModule.
 * Returns the saved User entity with a generated UUID.
 */
export async function createTestUserDirect(
  dataSource: DataSource,
  overrides: Partial<{
    email: string;
    firstName: string;
    lastName: string;
    role: string;
  }> = {},
): Promise<User> {
  const passwordHash = await bcrypt.hash("TestPassword123!", 4); // low rounds for speed
  const user = dataSource.manager.create(User, {
    email:
      overrides.email ||
      `test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
    firstName: overrides.firstName || "Test",
    lastName: overrides.lastName || "User",
    passwordHash,
    authProvider: "local",
    role: overrides.role || "user",
    isActive: true,
    emailVerified: true,
  });
  return dataSource.manager.save(user);
}
