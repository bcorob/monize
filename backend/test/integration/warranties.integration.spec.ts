import {
  BadRequestException,
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";

import { withDelegateContext, withUserContext } from "@/common/db/with-context";
import { CrossOwnerAccessService } from "@/delegation/cross-owner-access.service";
import { DelegationService } from "@/delegation/delegation.service";
import { AccountDelegateGuard } from "@/delegation/guards/account-delegate.guard";
import { WarrantiesController } from "@/warranties/warranties.controller";
import { WarrantiesModule } from "@/warranties/warranties.module";
import { WarrantiesService } from "@/warranties/warranties.service";
import { WarrantyClaimsService } from "@/warranties/warranty-claims.service";
import { WarrantyImportService } from "@/warranties/warranty-import.service";

import {
  cleanTables,
  createEnforcedIntegrationModule,
  createTestUserDirect,
  EnforcedIntegrationHarness,
} from "../helpers/integration-setup";

/**
 * Warranties and their claims against a real PostgreSQL enforcing RLS
 * (docs/specs/warranty-tracker.md section 11: Ownership, Delegation,
 * Import; WTY-005, WTY-006, WTY-007).
 *
 * What a mocked manager cannot show and these do: that another user's
 * warranty and claim are absent to the policy itself, not only to the
 * service's `WHERE user_id`; that a refused link leaves the table exactly as
 * it was (the row count, and on an update every other field too); that a
 * delegate's view of the linked purchase is narrowed by the account grants
 * the database holds, read through the real `delegateReadableAccountScope`;
 * that the section refusal is the real guard reading the real controller's
 * metadata; and that an import's preview and commit agree row for row.
 *
 * The bucket placement of both tables is `rls-enforcement.integration.spec.ts`;
 * the reminder dedupe across two connections is
 * `warranty-expiry-reminders.integration.spec.ts`; attachments and the backup
 * round trip are `warranty-attachments.integration.spec.ts`.
 */
describe("Warranties under RLS enforcement (integration)", () => {
  jest.setTimeout(240000);

  let harness: EnforcedIntegrationHarness;
  let module: TestingModule;
  /** The table owner: seeds and inspects. Never the connection under test. */
  let db: DataSource;
  let warranties: WarrantiesService;
  let claims: WarrantyClaimsService;
  let importer: WarrantyImportService;
  let controller: WarrantiesController;
  let delegation: DelegationService;

  let aliceId: string;
  let bobId: string;
  let daveId: string;
  let delegationId: string;
  /** Alice's account Dave holds a READ grant on, and one he does not. */
  let grantedAccountId: string;
  let ungrantedAccountId: string;
  let grantedTxId: string;
  let ungrantedTxId: string;
  let alicePayeeId: string;
  let bobTxId: string;
  let bobPayeeId: string;

  const TODAY = "2026-10-21";
  const asAlice = <T>(fn: () => Promise<T>) => withUserContext(aliceId, fn);
  const asBob = <T>(fn: () => Promise<T>) => withUserContext(bobId, fn);
  const asDave = <T>(fn: () => Promise<T>) =>
    withDelegateContext(aliceId, daveId, fn);

  const query = <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => db.query(sql, params) as Promise<T[]>;

  const warrantyCount = async (): Promise<number> =>
    Number(
      (await query<{ n: string }>(`SELECT COUNT(*) AS n FROM warranties`))[0].n,
    );

  async function seedAccount(userId: string, name: string): Promise<string> {
    const [row] = await query<{ id: string }>(
      `INSERT INTO accounts (user_id, name, account_type, currency_code,
                             current_balance, opening_balance)
       VALUES ($1, $2, 'CHEQUING', 'USD', 0, 0) RETURNING id`,
      [userId, name],
    );
    return row.id;
  }

  async function seedTransaction(
    userId: string,
    accountId: string,
    payeeName: string,
  ): Promise<string> {
    const [row] = await query<{ id: string }>(
      `INSERT INTO transactions (user_id, account_id, amount, transaction_date,
                                 currency_code, payee_name)
       VALUES ($1, $2, -1299.99, '2026-10-01', 'USD', $3) RETURNING id`,
      [userId, accountId, payeeName],
    );
    return row.id;
  }

  async function seedPayee(userId: string, name: string): Promise<string> {
    const [row] = await query<{ id: string }>(
      `INSERT INTO payees (user_id, name) VALUES ($1, $2) RETURNING id`,
      [userId, name],
    );
    return row.id;
  }

  async function seedWarranty(
    userId: string,
    over: { name?: string; transactionId?: string | null } = {},
  ): Promise<string> {
    const [row] = await query<{ id: string }>(
      `INSERT INTO warranties
         (user_id, name, purchase_date, expires_on, transaction_id)
       VALUES ($1, $2, '2026-10-01', '2028-10-01', $3) RETURNING id`,
      [userId, over.name ?? "Laptop", over.transactionId ?? null],
    );
    return row.id;
  }

  beforeAll(async () => {
    harness = await createEnforcedIntegrationModule([WarrantiesModule]);
    module = harness.module;
    db = harness.owner;
    warranties = module.get(WarrantiesService);
    claims = module.get(WarrantyClaimsService);
    importer = module.get(WarrantyImportService);
    controller = module.get(WarrantiesController);
    delegation = module.get(DelegationService);

    aliceId = (await createTestUserDirect(db, { firstName: "Alice" })).id;
    bobId = (await createTestUserDirect(db, { firstName: "Bob" })).id;
    daveId = (await createTestUserDirect(db, { firstName: "Dave" })).id;
    await db.query(
      `INSERT INTO currencies (code, name, symbol) VALUES ('USD', 'US Dollar', '$')
       ON CONFLICT DO NOTHING`,
    );

    grantedAccountId = await seedAccount(aliceId, "Chequing");
    ungrantedAccountId = await seedAccount(aliceId, "Private Visa");
    grantedTxId = await seedTransaction(aliceId, grantedAccountId, "Best Buy");
    ungrantedTxId = await seedTransaction(
      aliceId,
      ungrantedAccountId,
      "Jeweller",
    );
    alicePayeeId = await seedPayee(aliceId, "Best Buy");
    bobTxId = await seedTransaction(
      bobId,
      await seedAccount(bobId, "Bob's"),
      "Bob's shop",
    );
    bobPayeeId = await seedPayee(bobId, "Bob's shop");

    const [row] = await query<{ id: string }>(
      `INSERT INTO account_delegates (owner_user_id, delegate_user_id, status)
       VALUES ($1, $2, 'active') RETURNING id`,
      [aliceId, daveId],
    );
    delegationId = row.id;
    await db.query(
      `INSERT INTO account_delegate_grants (delegation_id, account_id, can_read)
       VALUES ($1, $2, true)`,
      [delegationId, grantedAccountId],
    );
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await cleanTables(db, ["warranty_claims", "warranties"]);
  });

  it("is enforcing: the runtime role outside a scoped transaction sees no warranty", async () => {
    // The floor under every refusal below: at RLS_MODE=off, or connected as
    // the owner, the service's own WHERE would produce the same 404s and this
    // suite would report a predicate as though it were the policy.
    await seedWarranty(aliceId);
    expect(await harness.app.query(`SELECT id FROM warranties`)).toEqual([]);
    expect(await warrantyCount()).toBe(1);
  });

  describe("another user's warranty and claim", () => {
    let warrantyId: string;
    let claimId: string;

    beforeEach(async () => {
      warrantyId = await seedWarranty(aliceId);
      const [claim] = await query<{ id: string }>(
        `INSERT INTO warranty_claims (user_id, warranty_id, claim_date, description)
         VALUES ($1, $2, '2026-10-10', 'Screen flickers') RETURNING id`,
        [aliceId, warrantyId],
      );
      claimId = claim.id;
    });

    const stored = async () =>
      (
        await query<{ name: string; status: string; description: string }>(
          `SELECT w.name, c.status, c.description
             FROM warranties w JOIN warranty_claims c ON c.warranty_id = w.id
            WHERE w.id = $1`,
          [warrantyId],
        )
      )[0];

    it("is not readable by user B, whichever user id the service is asked about", async () => {
      await asBob(async () => {
        // B's own id: the service's WHERE refuses.
        await expect(
          warranties.findOne(bobId, warrantyId, { today: TODAY }),
        ).rejects.toBeInstanceOf(NotFoundException);
        // A's id under B's identity: only the policy can refuse this one.
        await expect(
          warranties.findOne(aliceId, warrantyId, { today: TODAY }),
        ).rejects.toBeInstanceOf(NotFoundException);
        const listed = await warranties.findAll(aliceId, {}, { today: TODAY });
        expect(listed.data).toEqual([]);
        expect(listed.pagination.total).toBe(0);
        await expect(
          claims.findAll(aliceId, warrantyId),
        ).rejects.toBeInstanceOf(NotFoundException);
      });

      // The positive control: the same reads as A find the row and its claim.
      const view = await asAlice(() =>
        warranties.findOne(aliceId, warrantyId, { today: TODAY }),
      );
      expect(view).toMatchObject({ id: warrantyId, openClaimCount: 1 });
      expect(await asAlice(() => claims.findAll(aliceId, warrantyId))).toEqual([
        expect.objectContaining({ id: claimId }),
      ]);
    });

    it("is not writable by user B, and nothing changes", async () => {
      const before = await stored();
      await asBob(async () => {
        for (const owner of [bobId, aliceId]) {
          await expect(
            warranties.update(owner, warrantyId, { name: "Hijacked" }),
          ).rejects.toBeInstanceOf(NotFoundException);
          await expect(
            warranties.archive(owner, warrantyId),
          ).rejects.toBeInstanceOf(NotFoundException);
          await expect(
            warranties.remove(owner, warrantyId),
          ).rejects.toBeInstanceOf(NotFoundException);
          await expect(
            claims.update(owner, warrantyId, claimId, {
              status: "denied",
              description: "Hijacked",
            }),
          ).rejects.toBeInstanceOf(NotFoundException);
          await expect(
            claims.create(owner, warrantyId, { claimDate: "2026-10-12" }),
          ).rejects.toBeInstanceOf(NotFoundException);
          await expect(
            claims.remove(owner, warrantyId, claimId),
          ).rejects.toBeInstanceOf(NotFoundException);
        }
      });

      expect(await stored()).toEqual(before);
      expect(before).toEqual({
        name: "Laptop",
        status: "open",
        description: "Screen flickers",
      });
      const [counts] = await query<{ w: string; c: string; archived: string }>(
        `SELECT (SELECT COUNT(*) FROM warranties) AS w,
                (SELECT COUNT(*) FROM warranty_claims) AS c,
                (SELECT COUNT(*) FROM warranties WHERE archived_at IS NOT NULL) AS archived`,
      );
      expect(counts).toEqual({ w: "1", c: "1", archived: "0" });
    });
  });

  describe("WTY-005: a foreign or unknown link is refused before the write", () => {
    const UNKNOWN = "00000000-0000-4000-8000-000000000000";
    const base = {
      name: "Dishwasher",
      purchaseDate: "2026-10-01",
      expiresOn: "2028-10-01",
    };

    it.each([
      ["another user's transaction", () => ({ transactionId: bobTxId })],
      ["another user's payee", () => ({ payeeId: bobPayeeId })],
      ["an unknown transaction", () => ({ transactionId: UNKNOWN })],
      ["an unknown payee", () => ({ payeeId: UNKNOWN })],
    ])("create naming %s is a 404 and writes no row", async (_label, link) => {
      await expect(
        asAlice(() => warranties.create(aliceId, { ...base, ...link() })),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(await warrantyCount()).toBe(0);
    });

    it("create naming the caller's own transaction and payee links both", async () => {
      // The positive control for the four refusals above.
      const view = await asAlice(() =>
        warranties.create(
          aliceId,
          { ...base, transactionId: grantedTxId, payeeId: alicePayeeId },
          { today: TODAY },
        ),
      );
      expect(view).toMatchObject({
        transactionId: grantedTxId,
        payeeId: alicePayeeId,
        payee: { id: alicePayeeId, name: "Best Buy", hasLogo: false },
        linkedTransaction: { id: grantedTxId, accountId: grantedAccountId },
      });
      expect(await warrantyCount()).toBe(1);
    });

    it.each([
      ["another user's transaction", () => ({ transactionId: bobTxId })],
      ["another user's payee", () => ({ payeeId: bobPayeeId })],
    ])(
      "update to %s is a 404 and leaves every field of the row as it was",
      async (_label, link) => {
        const id = await seedWarranty(aliceId, { transactionId: grantedTxId });
        const snapshot = () =>
          query(
            `SELECT name, transaction_id, payee_id, notes, updated_at
               FROM warranties WHERE id = $1`,
            [id],
          );
        const before = await snapshot();

        // A rename travels with the foreign link, so a refusal that came after
        // a partial write would show here as a changed name.
        await expect(
          asAlice(() =>
            warranties.update(aliceId, id, {
              name: "Renamed",
              notes: "should not land",
              ...link(),
            }),
          ),
        ).rejects.toBeInstanceOf(NotFoundException);

        expect(await snapshot()).toEqual(before);
        expect(before[0]).toMatchObject({
          name: "Laptop",
          transaction_id: grantedTxId,
          payee_id: null,
        });
        expect(await warrantyCount()).toBe(1);
      },
    );
  });

  describe("WTY-007: the linked purchase as each caller sees it (truth table C)", () => {
    let grantedWarrantyId: string;
    let ungrantedWarrantyId: string;

    const jwt = new JwtService({ secret: "warranties-integration" });
    let guard: AccountDelegateGuard;

    const ownerReq = () =>
      ({
        user: {
          id: aliceId,
          realUserId: aliceId,
          isActing: false,
          delegationId: null,
        },
      }) as never;
    // What JwtStrategy builds from an acting token: `id` is the owner.
    const delegateReq = () =>
      ({
        user: { id: aliceId, realUserId: daveId, isActing: true, delegationId },
      }) as never;

    const setSection = (on: boolean) =>
      asAlice(() =>
        delegation.setSectionGrants(aliceId, delegationId, {
          warrantiesCanRead: on,
        }),
      );

    /** The real guard deciding a delegate's request for a controller method. */
    const guardAdmits = (handler: (...args: never[]) => unknown) => {
      const token = jwt.sign({
        sub: daveId,
        email: "dave@example.com",
        actingAsUserId: aliceId,
        delegationId,
      });
      return guard.canActivate({
        getType: () => "http",
        switchToHttp: () => ({
          getRequest: () => ({
            headers: { authorization: `Bearer ${token}` },
          }),
        }),
        getHandler: () => handler,
        getClass: () => WarrantiesController,
      } as unknown as ExecutionContext);
    };

    beforeAll(() => {
      guard = new AccountDelegateGuard(
        new Reflector(),
        jwt,
        delegation,
        module.get(CrossOwnerAccessService),
      );
    });

    beforeEach(async () => {
      grantedWarrantyId = await seedWarranty(aliceId, {
        name: "Laptop",
        transactionId: grantedTxId,
      });
      ungrantedWarrantyId = await seedWarranty(aliceId, {
        name: "Ring",
        transactionId: ungrantedTxId,
      });
    });

    afterEach(async () => {
      await setSection(false);
    });

    it("owner: both purchases, with their ids", async () => {
      for (const [id, txId, accountId] of [
        [grantedWarrantyId, grantedTxId, grantedAccountId],
        [ungrantedWarrantyId, ungrantedTxId, ungrantedAccountId],
      ]) {
        const view = await asAlice(() => controller.findOne(ownerReq(), id));
        expect(view.transactionId).toBe(txId);
        expect(view.linkedTransaction).toMatchObject({
          id: txId,
          accountId,
          amount: -1299.99,
          currencyCode: "USD",
        });
      }
    });

    it("delegate with the section and the account grant: the purchase and its id", async () => {
      await setSection(true);
      await expect(
        guardAdmits(WarrantiesController.prototype.findOne),
      ).resolves.toBe(true);

      const view = await asDave(() =>
        controller.findOne(delegateReq(), grantedWarrantyId),
      );
      expect(view.transactionId).toBe(grantedTxId);
      expect(view.linkedTransaction).toEqual({
        id: grantedTxId,
        transactionDate: "2026-10-01",
        payeeName: "Best Buy",
        amount: -1299.99,
        currencyCode: "USD",
        accountId: grantedAccountId,
      });
    });

    it("delegate with the section but not the account: the warranty, no trace of the purchase", async () => {
      await setSection(true);

      const view = await asDave(() =>
        controller.findOne(delegateReq(), ungrantedWarrantyId),
      );
      expect(view).toMatchObject({ id: ungrantedWarrantyId, name: "Ring" });
      expect(view.linkedTransaction).toBeNull();
      expect(view).not.toHaveProperty("transactionId");
      // Not under another name either: the id appears nowhere in the payload.
      expect(JSON.stringify(view)).not.toContain(ungrantedTxId);

      // The list narrows per row the same way, through the same scope.
      const list = await asDave(() => controller.findAll(delegateReq(), {}));
      const byId = new Map(list.data.map((row) => [row.id, row]));
      expect(byId.get(grantedWarrantyId)?.transactionId).toBe(grantedTxId);
      expect(byId.get(ungrantedWarrantyId)?.linkedTransaction).toBeNull();
      expect(JSON.stringify(list)).not.toContain(ungrantedTxId);
    });

    it("delegate filtering the list by a purchase id: matches only a purchase in a granted account", async () => {
      await setSection(true);

      // The owner's filter finds the warranty whatever the account.
      const owners = await asAlice(() =>
        controller.findAll(ownerReq(), { transactionId: ungrantedTxId }),
      );
      expect(owners.data.map((row) => row.id)).toEqual([ungrantedWarrantyId]);

      // Without the account grant the id matches nothing: the same answer
      // an unknown id gets, so the filter cannot confirm the link.
      const hidden = await asDave(() =>
        controller.findAll(delegateReq(), { transactionId: ungrantedTxId }),
      );
      const unknown = await asDave(() =>
        controller.findAll(delegateReq(), {
          transactionId: "00000000-0000-4000-8000-000000000000",
        }),
      );
      expect(hidden).toEqual({
        data: [],
        pagination: {
          page: 1,
          limit: 50,
          total: 0,
          totalPages: 0,
          hasMore: false,
        },
      });
      expect(hidden).toEqual(unknown);

      // Positive control: with the grant, the filter finds the row.
      const granted = await asDave(() =>
        controller.findAll(delegateReq(), { transactionId: grantedTxId }),
      );
      expect(granted.pagination.total).toBe(1);
      expect(granted.data).toHaveLength(1);
      expect(granted.data[0]).toMatchObject({
        id: grantedWarrantyId,
        transactionId: grantedTxId,
        linkedTransaction: { id: grantedTxId, accountId: grantedAccountId },
      });
    });

    it("delegate without the section: refused by the guard on every read route", async () => {
      // Section off (the column's default). The real guard reads the real
      // controller's metadata and the delegation row through RLS.
      for (const handler of [
        WarrantiesController.prototype.findAll,
        WarrantiesController.prototype.findOne,
        WarrantiesController.prototype.summary,
      ]) {
        await expect(guardAdmits(handler)).rejects.toBeInstanceOf(
          ForbiddenException,
        );
      }
    });

    it("delegate with the section: still refused on every write route", async () => {
      await setSection(true);
      for (const handler of [
        WarrantiesController.prototype.create,
        WarrantiesController.prototype.update,
        WarrantiesController.prototype.remove,
        WarrantiesController.prototype.archive,
        WarrantiesController.prototype.importCsv,
      ]) {
        await expect(guardAdmits(handler)).rejects.toBeInstanceOf(
          ForbiddenException,
        );
      }
    });
  });

  describe("WTY-006: an import's preview and commit are one computation", () => {
    const HEADER =
      "ProductName,PurchaseDate,ExpirationDate,IsLifetime,Vendor,Tags";
    const DISHWASHER = "Dishwasher,2026-01-15,2028-01-15,false,Bosch,kitchen";
    const KETTLE = "Kettle,2026-02-01,,true,Breville,";
    const DRILL = "Drill,2026-03-01,2029-03-01,,Makita,tools";
    const BROKEN = "Toaster,not-a-date,2027-01-01,false,,";

    const run = (content: string, dryRun: boolean, skipInvalid = false) =>
      asAlice(() => importer.run(aliceId, content, { dryRun, skipInvalid }));

    const storedNames = async () =>
      (
        await query<{ name: string; expires_on: string | null }>(
          `SELECT name, TO_CHAR(expires_on, 'YYYY-MM-DD') AS expires_on
             FROM warranties WHERE user_id = $1 ORDER BY name`,
          [aliceId],
        )
      ).map((row) => [row.name, row.expires_on]);

    it("a clean file: the commit creates exactly the rows the preview called valid", async () => {
      const file = [HEADER, DISHWASHER, KETTLE, DRILL].join("\n");

      const preview = await run(file, true);
      expect(preview.rows.map((row) => row.outcome)).toEqual([
        "valid",
        "valid",
        "valid",
      ]);
      expect(preview.created).toBe(0);
      expect(preview.skippedColumns).toEqual(["Tags"]);
      expect(await warrantyCount()).toBe(0);

      const commit = await run(file, false);
      // Row for row, the same verdict, payload, errors and warnings; only the
      // outcome advances and the created id is added.
      expect(commit.rows).toEqual(
        preview.rows.map((row) => ({
          ...row,
          outcome: "created",
          warrantyId: expect.any(String),
        })),
      );
      expect(commit.created).toBe(3);
      expect(commit.skippedColumns).toEqual(preview.skippedColumns);
      expect(await storedNames()).toEqual([
        ["Dishwasher", "2028-01-15"],
        ["Drill", "2029-03-01"],
        ["Kettle", null],
      ]);
      const ids = commit.rows.map((row) => row.warrantyId);
      const found = await query<{ id: string }>(
        `SELECT id FROM warranties WHERE id = ANY($1::uuid[])`,
        [ids],
      );
      expect(found).toHaveLength(3);
    });

    it("a file with one invalid row writes nothing unless the caller skips it", async () => {
      const file = [HEADER, DISHWASHER, BROKEN, DRILL].join("\n");

      const preview = await run(file, true);
      expect(preview.rows.map((row) => [row.line, row.outcome])).toEqual([
        [2, "valid"],
        [3, "invalid"],
        [4, "valid"],
      ]);
      expect(preview.rows[1].errors.length).toBeGreaterThan(0);

      await expect(run(file, false)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(await warrantyCount()).toBe(0);

      const commit = await run(file, false, true);
      expect(commit.rows).toEqual(
        preview.rows.map((row) =>
          row.outcome === "valid"
            ? { ...row, outcome: "created", warrantyId: expect.any(String) }
            : row,
        ),
      );
      expect(commit.created).toBe(2);
      expect(await storedNames()).toEqual([
        ["Dishwasher", "2028-01-15"],
        ["Drill", "2029-03-01"],
      ]);
    });
  });
});
