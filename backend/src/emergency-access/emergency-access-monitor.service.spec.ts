import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { I18nService } from "nestjs-i18n";
import { EmergencyAccessMonitorService } from "./emergency-access-monitor.service";
import { EmergencyAccessSettings } from "./entities/emergency-access-settings.entity";
import { EmergencyAccessContact } from "./entities/emergency-access-contact.entity";
import { EncryptionService } from "../common/encryption/encryption.service";
import { EmailService } from "../notifications/email.service";
import { User } from "../users/entities/user.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { getRequestContext } from "../common/request-context";
import { hashToken } from "../auth/crypto.util";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import {
  createJobClaimMock,
  TEST_LEASE_TOKEN,
  JobClaimMock,
  jobClaimProvider,
} from "../test-helpers/job-claim-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("EmergencyAccessMonitorService", () => {
  /** Wins every claim, matching the pre-claim behaviour these specs describe. */
  const jobClaims: JobClaimMock = createJobClaimMock();
  /** Whether the conditional grant-claim UPDATE returns a row this run. */
  let grantClaimWins: boolean;
  let scopedManagerQuery: jest.Mock;
  let service: EmergencyAccessMonitorService;
  let settingsRepo: Record<string, jest.Mock>;
  let contactsRepo: Record<string, jest.Mock>;
  let usersRepo: Record<string, jest.Mock>;
  let prefsRepo: Record<string, jest.Mock>;
  let emailService: Record<string, jest.Mock>;
  let encryption: Record<string, jest.Mock>;
  let configService: Record<string, jest.Mock>;

  const userId = "11111111-1111-1111-1111-111111111111";
  /**
   * The cycle a claimed grant lands in. Not 1: a spec that only ever saw the first
   * cycle would pass against a service that ignored the generation entirely.
   */
  const CURRENT_GENERATION = 4;

  function daysAgo(n: number): Date {
    return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  }

  interface ContactFixture {
    id: string;
    firstName: string;
    email: string;
    /** Notified in the *current* cycle, unless `notifiedGeneration` says otherwise. */
    notified?: boolean;
    /** The cycle this contact's notice belongs to. Defaults to `CURRENT_GENERATION`. */
    notifiedGeneration?: number;
    /** A credential from an earlier attempt that was never confirmed sent. */
    undeliveredToken?: string;
    /** How long that credential is still good for, in days. Negative means expired. */
    tokenExpiresInDays?: number;
    /** A token issued by a version that did not keep it -- hash, no ciphertext. */
    unrecoverableToken?: boolean;
  }

  /**
   * A contacts `find` that honours the real pending predicate.
   *
   * That predicate is the mechanism under test -- it is what makes a resumed grant
   * skip a contact who already holds a working link, and what makes a *re-armed*
   * grant owe every contact again -- so a spec about either cannot use a
   * `mockResolvedValue` that returns everything. It is a generation comparison
   * rather than "has a timestamp" since RRV4-004, so this double compares
   * generations too: an assertion about the second cycle is worthless against a
   * double that only knows `notified: true`.
   */
  function contactsAre(rows: ContactFixture[]): void {
    const generationOf = (row: ContactFixture): number | null =>
      row.notifiedGeneration ?? (row.notified ? CURRENT_GENERATION : null);
    contactsRepo.find.mockImplementation(async (opts?: { where?: unknown }) => {
      // The pending query passes an array of two `where` arms (never notified,
      // or notified for an earlier cycle); every other read passes an object.
      const arms = Array.isArray(opts?.where)
        ? (opts?.where as {
            notifiedGrantGeneration?: { value?: number; type?: string };
          }[])
        : null;
      const wanted = arms?.[1]?.notifiedGrantGeneration?.value;
      // The comparison the service asks for, honoured rather than assumed. It is
      // `LessThan`, deliberately: a contact already served by a *newer* cycle is not
      // owed anything by an older one, and the read used to say `Not(...)` while the
      // write said `<`. A double that filtered on inequality would keep passing
      // through that drift, which is how it survived (see the forward-only spec
      // below).
      const comparison = arms?.[1]?.notifiedGrantGeneration?.type;
      // The pre-RRV4-004 predicate, honoured too, so a spec about the second
      // cycle fails if the service reverts to it rather than passing silently
      // against a double that ignores the `where` it was handed.
      const legacyPending =
        !arms &&
        typeof opts?.where === "object" &&
        opts?.where !== null &&
        "claimNotifiedAt" in (opts.where as Record<string, unknown>);
      return rows
        .filter((row) => {
          if (legacyPending) return generationOf(row) === null;
          if (!arms) return true;
          const gen = generationOf(row);
          if (gen === null) return true;
          // Whichever comparison the service asked for, applied the way PostgreSQL
          // would -- not the one this file would prefer it to use. Modelling only
          // `lessThan` would make the forward-only spec below vacuous: the buggy
          // `Not` would select nothing here and the assertion "no link was minted"
          // would pass for the wrong reason.
          if (comparison === "lessThan") return gen < (wanted ?? 0);
          if (comparison === "not") return gen !== wanted;
          throw new Error(
            `contactsAre does not model the '${comparison}' comparison; ` +
              `teach it what PostgreSQL does before relying on a spec that uses it`,
          );
        })
        .map((row) => ({
          id: row.id,
          firstName: row.firstName,
          email: row.email,
          claimNotifiedAt: generationOf(row) === null ? null : daysAgo(1),
          notifiedGrantGeneration: generationOf(row),
          claimTokenHash: row.undeliveredToken
            ? hashToken(row.undeliveredToken)
            : row.unrecoverableToken
              ? "a-hash-from-an-older-version"
              : null,
          claimTokenExpiresAt: row.undeliveredToken
            ? daysAgo(-(row.tokenExpiresInDays ?? 30))
            : null,
          claimTokenCiphertext: row.undeliveredToken
            ? `enc(${row.undeliveredToken})`
            : null,
        }));
    });
    contactsRepo.count.mockResolvedValue(rows.length);
  }

  /** The claim URLs this run put in front of recipients. */
  function sentClaimUrls(): string[] {
    return emailService.sendMail.mock.calls
      .map((call) => /token=([0-9a-f]+)/.exec(String(call[2]))?.[1])
      .filter((token): token is string => Boolean(token));
  }

  /**
   * The credentials this run minted, in the order they were written.
   *
   * The mint is a conditional UPDATE rather than a `repo.save` of the entity the
   * sweep read, because the loop makes an SMTP round trip per contact and the
   * snapshot goes stale under it: saving the whole entity asserted "not used, not
   * voided" over whatever the row had become, so a contact revoked mid-sweep -- or
   * voided by a sibling completing the takeover -- was handed a working link into an
   * account somebody else already owned. Reading the emitted statement rather than a
   * saved object is what keeps the spec able to see that.
   */
  interface MintedCredential {
    contactId?: string;
    claimTokenHash?: string;
    claimTokenCiphertext?: string;
    claimTokenExpiresAt?: Date;
    /** The row state the mint required to still be there (the compare-and-set). */
    expected: Record<string, unknown>;
    order: number;
  }
  function mintedCredentials(): MintedCredential[] {
    return contactsRepo.createQueryBuilder.mock.results.flatMap((result) => {
      if (result.type !== "return") return [];
      const builder = result.value as {
        set: jest.Mock;
        where: jest.Mock;
        andWhere: jest.Mock;
        execute: jest.Mock;
      };
      const mint = builder.set.mock.calls.find(
        (call) => (call[0] as Record<string, unknown>)?.claimTokenHash,
      )?.[0] as Record<string, unknown> | undefined;
      if (!mint) return [];
      const expected: Record<string, unknown> = {};
      for (const call of builder.andWhere.mock.calls) {
        Object.assign(expected, (call[1] ?? {}) as Record<string, unknown>);
      }
      return [
        {
          contactId: (builder.where.mock.calls[0]?.[1] as { id?: string })?.id,
          claimTokenHash: mint.claimTokenHash as string,
          claimTokenCiphertext: mint.claimTokenCiphertext as string,
          claimTokenExpiresAt: mint.claimTokenExpiresAt as Date,
          expected,
          order: builder.execute.mock.invocationCallOrder[0],
        },
      ];
    });
  }

  /** The contact ids whose delivery record this run stamped. */
  function notifiedContactIds(): string[] {
    return contactsRepo.createQueryBuilder.mock.results.flatMap((result) => {
      if (result.type !== "return") return [];
      const builder = result.value as {
        set: jest.Mock;
        where: jest.Mock;
      };
      const stampedNotified = builder.set.mock.calls.some(
        (call) => "claimNotifiedAt" in (call[0] ?? {}),
      );
      if (!stampedNotified) return [];
      return builder.where.mock.calls
        .map((call) => (call[1] as { id?: string } | undefined)?.id)
        .filter((id): id is string => typeof id === "string");
    });
  }

  beforeEach(async () => {
    // The claim double is shared across tests, so its recorded calls and any
    // queued `...Once` would otherwise leak forward -- which is invisible until a
    // spec asserts a claim was *not* taken, and then reads as a product bug.
    jobClaims.claimOnce.mockReset().mockResolvedValue(true);
    jobClaims.claimLease.mockReset().mockResolvedValue(TEST_LEASE_TOKEN);
    jobClaims.releaseLease.mockReset().mockResolvedValue(undefined);

    settingsRepo = {
      find: jest.fn().mockResolvedValue([]),
      // The reminder's delivery record is re-read under the lease, because a
      // claim says "may I send" and only `lastReminderSentAt` says "this was
      // sent" (audit FV4-005). Served from the rows this spec's `find` returned,
      // so a fixture that sets `lastReminderSentAt` states the committed value
      // once rather than twice.
      findOne: jest.fn(async (opts?: { where?: { ownerUserId?: string } }) => {
        const wanted = opts?.where?.ownerUserId;
        for (const result of settingsRepo.find.mock.results) {
          if (result.type !== "return") continue;
          const rows = (await result.value) as
            | { ownerUserId?: string }[]
            | undefined;
          const hit = rows?.find(
            (row) => wanted === undefined || row.ownerUserId === wanted,
          );
          if (hit) return hit;
        }
        return null;
      }),
      save: jest.fn(),
      // grantedAt / lastReminderSentAt are now written with targeted UPDATEs
      // rather than by re-saving the entity the sweep read, so a concurrent
      // settings change is not reverted by a bookkeeping write. The double
      // applies the patch to the fixture rows the way the database would, so a
      // later read in the same run sees the committed value -- the revocation
      // sweep now runs before the delivery sweep, and without this the second
      // pass would reprocess a grant the first one already cleared.
      createQueryBuilder: jest.fn(() => {
        let patch: Record<string, unknown> = {};
        // The revocation's settings write is a compare-and-set on
        // `granted_at IS NOT NULL` -- it is what makes exactly one replica send the
        // owner's notice, since that sweep takes no lease. So the double honours the
        // predicate rather than reporting `affected: 1` unconditionally, and a
        // second caller over an already-cleared grant gets zero rows the way
        // PostgreSQL would.
        let requireGranted = false;
        const qb = {
          update: jest.fn(() => qb),
          set: jest.fn((p: Record<string, unknown>) => {
            patch = p;
            return qb;
          }),
          where: jest.fn(() => qb),
          andWhere: jest.fn((clause: string) => {
            if (/granted_at IS NOT NULL/.test(clause)) requireGranted = true;
            return qb;
          }),
          execute: jest.fn(async () => {
            let affected = 0;
            for (const result of settingsRepo.find.mock.results) {
              if (result.type !== "return") continue;
              const rows = (await result.value) as
                | Record<string, unknown>[]
                | undefined;
              for (const row of rows ?? []) {
                if (requireGranted && row.grantedAt == null) continue;
                affected += 1;
                for (const [key, value] of Object.entries(patch)) {
                  row[key] = typeof value === "function" ? new Date() : value;
                }
              }
            }
            return { affected: requireGranted ? affected : 1 };
          }),
        };
        return qb;
      }),
    };
    contactsRepo = {
      find: jest.fn().mockResolvedValue([]),
      // "Has this owner anyone to notify" -- asked before a cycle is opened, since
      // the cycle about to open has by definition notified nobody. Delegates to
      // `find` so a fixture states the roster once.
      count: jest.fn(async () => (await contactsRepo.find({})).length),
      save: jest.fn(async (row) => row),
      createQueryBuilder: jest.fn(() => ({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      })),
    };
    usersRepo = { findOne: jest.fn() };
    prefsRepo = { findOne: jest.fn().mockResolvedValue(null) };
    emailService = {
      getStatus: jest.fn().mockReturnValue({ configured: true }),
      sendMail: jest.fn().mockResolvedValue(undefined),
    };
    encryption = {
      isConfigured: jest.fn().mockReturnValue(true),
      // A real round trip, not two unrelated stubs: the credential a retry
      // re-sends is the one the first attempt stored, so a double that could not
      // decrypt what it encrypted would make the reuse path untestable and the
      // rotation path look like the only one (audit RV4-004).
      encrypt: jest.fn((plain: string) => `enc(${plain})`),
      decrypt: jest.fn((s) => s.replace(/^enc\(/, "").replace(/\)$/, "")),
    };
    configService = {
      get: jest.fn((key: string, fallback: string) => fallback),
    };

    // Every read/write now runs through `withScopedDb`; the former QueryRunner
    // is the transaction's EntityManager, so keep `queryRunner.manager` pointing
    // at the same jest.fn()s the manager exposes.
    const scoped = createScopedDbMocks([
      [EmergencyAccessSettings, settingsRepo as never],
      [EmergencyAccessContact, contactsRepo as never],
      [User, usersRepo as never],
      [UserPreference, prefsRepo as never],
    ]);
    // The grant transition is claimed with a conditional UPDATE ... RETURNING,
    // so exactly one replica may issue tokens (audit P4-014). The default is
    // "this process won the claim", which is what the pre-claim specs describe;
    // `losesGrantClaim()` below is the other side.
    grantClaimWins = true;
    scopedManagerQuery = scoped.manager.query;
    scoped.manager.query.mockImplementation(async (sql: string) => {
      // Matched on the generation bump rather than on the table, so the grant
      // claim is told apart from `releaseGrant`'s plain `granted_at = NULL`.
      if (sql.includes("grant_generation = grant_generation + 1")) {
        return grantClaimWins
          ? [[{ grant_generation: CURRENT_GENERATION }], 1]
          : [[], 0];
      }
      return [];
    });
    const dataSource = scoped.dataSource;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: DataSource, useValue: dataSource },
        EmergencyAccessMonitorService,
        jobClaimProvider(jobClaims),
        { provide: EmailService, useValue: emailService },
        { provide: EncryptionService, useValue: encryption },
        { provide: ConfigService, useValue: configService },
        {
          provide: I18nService,
          useValue: {
            translate: (key: string, opts?: { defaultValue?: string }) =>
              opts?.defaultValue ?? key,
          },
        },
      ],
    }).compile();

    service = module.get(EmergencyAccessMonitorService);
  });

  it("skips delivery when SMTP is not configured, but still sweeps for revocations", async () => {
    emailService.getStatus.mockReturnValue({ configured: false });
    await service.runDailyCheck();
    // The revocation sweep ran (it needs only the database)...
    expect(settingsRepo.find).toHaveBeenCalledTimes(1);
    // ...and nothing delivery-shaped happened.
    expect(usersRepo.findOne).not.toHaveBeenCalled();
    expect(emailService.sendMail).not.toHaveBeenCalled();
  });

  it("revokes a returned owner's links even when SMTP is not configured", async () => {
    // REMAINING-001: an already-issued 30-day link must stop working when the
    // owner returns, whatever the delivery dependencies look like. The owner
    // notice is best-effort -- here it fails outright -- and must not stop the
    // revocation writes.
    emailService.getStatus.mockReturnValue({ configured: false });
    emailService.sendMail.mockRejectedValue(new Error("no transport"));
    const settings = {
      ownerUserId: userId,
      enabled: true,
      grantAfterDays: 14,
      reminderAfterDays: 7,
      messageCiphertext: null,
      lastReminderSentAt: daysAgo(8),
      grantedAt: daysAgo(3),
    };
    settingsRepo.find.mockResolvedValue([settings]);
    usersRepo.findOne.mockResolvedValue({
      id: userId,
      email: "owner@example.com",
      isActive: true,
      lastActivityAt: daysAgo(1),
    });
    const execute = jest.fn().mockResolvedValue({ affected: 1 });
    contactsRepo.createQueryBuilder.mockReturnValue({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute,
    });

    await service.runDailyCheck();

    // Links voided and monitoring re-armed, with no working SMTP anywhere.
    expect(execute).toHaveBeenCalledTimes(1);
    expect(settings.grantedAt).toBeNull();
  });

  it("revokes a returned owner's links even when the encryption key is absent", async () => {
    // REMAINING-001, the other dependency: the keyless gate protects the
    // delivery sweep, not the revocation. Revoking encrypts nothing.
    encryption.isConfigured.mockReturnValue(false);
    const settings = {
      ownerUserId: userId,
      enabled: true,
      grantAfterDays: 14,
      reminderAfterDays: 7,
      messageCiphertext: null,
      lastReminderSentAt: daysAgo(8),
      grantedAt: daysAgo(3),
    };
    settingsRepo.find.mockResolvedValue([settings]);
    usersRepo.findOne.mockResolvedValue({
      id: userId,
      email: "owner@example.com",
      firstName: "Owner",
      isActive: true,
      lastActivityAt: daysAgo(1),
    });
    const execute = jest.fn().mockResolvedValue({ affected: 2 });
    contactsRepo.createQueryBuilder.mockReturnValue({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute,
    });

    await service.runDailyCheck();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(settings.grantedAt).toBeNull();
    // The owner heard about it (SMTP is fine here); no contact was enumerated
    // for delivery, because the keyless gate still guards that sweep.
    const [to, subject] = emailService.sendMail.mock.calls[0];
    expect(to).toBe("owner@example.com");
    expect(subject).toContain("while you were away");
    expect(contactsRepo.find).not.toHaveBeenCalled();
  });

  // RLS (task C4): the cross-user sweep runs under a system context.
  it("runs the sweep under a system context", async () => {
    let ctx: ReturnType<typeof getRequestContext>;
    settingsRepo.find.mockImplementation(() => {
      ctx = getRequestContext();
      return Promise.resolve([]);
    });
    await service.runDailyCheck();
    expect(ctx).toEqual({ system: true });
  });

  it("sends a reminder when inactivity exceeds reminderAfterDays but not grantAfterDays", async () => {
    settingsRepo.find.mockResolvedValue([
      {
        ownerUserId: userId,
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: null,
        lastReminderSentAt: null,
        grantedAt: null,
      },
    ]);
    usersRepo.findOne.mockResolvedValue({
      id: userId,
      email: "owner@example.com",
      firstName: "Owner",
      lastName: "One",
      isActive: true,
      lastActivityAt: daysAgo(10),
    });
    contactsRepo.find.mockResolvedValue([
      { firstName: "Carol", email: "carol@example.com" },
    ]);

    await service.runDailyCheck();

    expect(emailService.sendMail).toHaveBeenCalledTimes(1);
    const [to, subject] = emailService.sendMail.mock.calls[0];
    expect(to).toBe("owner@example.com");
    expect(subject).toContain("10");
    // Two separate jobs: the lease excludes the other replica right now, and
    // `lastReminderSentAt` -- written below -- is what says the day is spent. A
    // permanent claim taken before the send was both, so a replica killed in
    // between consumed the day and sent nothing (audit FV4-005).
    expect(jobClaims.claimLease).toHaveBeenCalledWith(
      "emergency_access_reminder",
      userId,
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      expect.any(Number),
    );
    expect(jobClaims.claimOnce).not.toHaveBeenCalledWith(
      "emergency_access_reminder",
      userId,
      expect.anything(),
    );
    // And the timestamp is written with a targeted UPDATE, not by re-saving the
    // settings row the sweep read.
    expect(settingsRepo.createQueryBuilder).toHaveBeenCalled();
  });

  it("does not send the reminder while another replica holds the lease", async () => {
    jobClaims.claimLease.mockResolvedValueOnce(null);

    await service.runDailyCheck();

    expect(emailService.sendMail).not.toHaveBeenCalled();
  });

  it("issues a grant token + email to every contact once grantAfterDays is reached", async () => {
    const settings = {
      ownerUserId: userId,
      enabled: true,
      grantAfterDays: 14,
      reminderAfterDays: 7,
      messageCiphertext: "enc(my last wishes)",
      lastReminderSentAt: null,
      grantedAt: null,
    };
    settingsRepo.find.mockResolvedValue([settings]);
    usersRepo.findOne.mockResolvedValue({
      id: userId,
      email: "owner@example.com",
      firstName: "Owner",
      lastName: "One",
      isActive: true,
      lastActivityAt: daysAgo(20),
    });
    contactsRepo.find.mockResolvedValue([
      { id: "c1", firstName: "Carol", email: "carol@example.com" },
      { id: "c2", firstName: "Dave", email: "dave@example.com" },
    ]);

    await service.runDailyCheck();

    expect(emailService.sendMail).toHaveBeenCalledTimes(2);
    const recipients = emailService.sendMail.mock.calls.map((c) => c[0]);
    expect(recipients).toEqual(["carol@example.com", "dave@example.com"]);
    expect(mintedCredentials()).toHaveLength(2);
    expect(mintedCredentials()[0].claimTokenHash).toBeTruthy();
    // grantedAt is set by the conditional claim UPDATE, before any token is
    // generated -- not by saving the entity after the emails went out. That
    // ordering is the fix: two replicas both saw null and both sent, and only
    // the last token hash written was still valid (audit P4-014).
    const claimSql = scopedManagerQuery.mock.calls
      .map((c) => String(c[0]))
      .find((sql) => sql.includes("UPDATE emergency_access_settings"));
    expect(claimSql).toContain("granted_at IS NULL");
    expect(claimSql).toContain("RETURNING");
  });

  it("issues nothing when another replica won the grant claim", async () => {
    grantClaimWins = false;

    await service.runDailyCheck();

    expect(mintedCredentials()).toEqual([]);
    expect(emailService.sendMail).not.toHaveBeenCalled();
  });

  it("does not re-issue grants once granted_at is set", async () => {
    settingsRepo.find.mockResolvedValue([
      {
        ownerUserId: userId,
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: null,
        lastReminderSentAt: daysAgo(0),
        grantedAt: daysAgo(1),
      },
    ]);
    usersRepo.findOne.mockResolvedValue({
      id: userId,
      email: "owner@example.com",
      isActive: true,
      lastActivityAt: daysAgo(20),
    });

    await service.runDailyCheck();
    expect(emailService.sendMail).not.toHaveBeenCalled();
  });

  /**
   * FV4-004: the crash window between the grant claim and the emails.
   *
   * `granted_at` used to be the claim and the grant state at once, so a replica
   * killed in between left the account permanently marked granted with nobody
   * holding a link -- and step 1's `granted_at IS NULL` predicate meant nothing
   * would ever look again. The delivery record is per contact now, so the state
   * is discoverable: a granted owner with an un-notified contact is a link owed.
   */
  describe("a grant that was claimed but never delivered", () => {
    const grantedButUndelivered = () => {
      settingsRepo.find.mockResolvedValue([
        {
          ownerUserId: userId,
          enabled: true,
          grantAfterDays: 14,
          reminderAfterDays: 7,
          messageCiphertext: null,
          lastReminderSentAt: null,
          // The claim committed; the process died before any email.
          grantedAt: daysAgo(1),
          grantGeneration: CURRENT_GENERATION,
        },
      ]);
      usersRepo.findOne.mockResolvedValue({
        id: userId,
        email: "owner@example.com",
        firstName: "Owner",
        isActive: true,
        lastActivityAt: daysAgo(20),
      });
    };

    it("leaves a contact served by a newer cycle alone", async () => {
      // The read and the write of "owed a link" are one predicate spelled twice,
      // and they disagreed about direction: the write was forward-only (`<`) while
      // the read asked for inequality (`Not`). So a resume running in cycle N found
      // a contact already delivered in cycle N+1 -- the owner re-armed and a newer
      // cycle went out while this one was still working -- treated them as owed,
      // and `credentialFor` minted a replacement over the hash that newer cycle had
      // just put in their inbox. `markContactNotified` then refused the
      // acknowledgement, so the link died and nothing recorded that it had.
      //
      // The delivered link is the assertion, not the absence of an email: rotating
      // the hash is what kills it, and that happens before the send.
      grantedButUndelivered();
      contactsAre([
        {
          id: "c1",
          firstName: "Carol",
          email: "carol@example.com",
          notifiedGeneration: CURRENT_GENERATION + 1,
        },
      ]);

      await service.runDailyCheck();

      expect(mintedCredentials()).toEqual([]);
      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it("refuses to mint over a contact voided while the sweep was sending", async () => {
      // `credentialFor` used to `repo.save` the entity the sweep read, which
      // asserts `claim_token_used_at = NULL, claim_voided_reason = NULL` over
      // whatever the row has since become. The loop makes an SMTP round trip per
      // contact, so "since" is a real window: an owner return, a disable, or a
      // sibling contact completing the takeover all void the row -- and the save
      // would resurrect it with a working link, in the last case into an account
      // somebody else now owns. The mint is a compare-and-set on the state the
      // decision was made from; zero rows means skip, before the send.
      grantedButUndelivered();
      contactsAre([
        { id: "c1", firstName: "Carol", email: "carol@example.com" },
      ]);
      contactsRepo.createQueryBuilder.mockReturnValue({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 0 }),
      });

      await service.runDailyCheck();

      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it("compares against the row state the mint decision was made from", async () => {
      grantedButUndelivered();
      contactsAre([
        {
          id: "c1",
          firstName: "Carol",
          email: "carol@example.com",
          unrecoverableToken: true,
        },
      ]);

      await service.runDailyCheck();

      // The hash it read, so a rotation somewhere else in the window loses.
      expect(mintedCredentials()[0].expected).toEqual({
        seenHash: "a-hash-from-an-older-version",
        seenCiphertext: null,
        seenVoided: undefined,
      });
    });

    it("resumes delivery for the contacts still owed a link", async () => {
      grantedButUndelivered();
      contactsAre([
        { id: "c1", firstName: "Carol", email: "carol@example.com" },
        { id: "c2", firstName: "Dave", email: "dave@example.com" },
      ]);

      await service.runDailyCheck();

      expect(emailService.sendMail.mock.calls.map((c) => c[0])).toEqual([
        "carol@example.com",
        "dave@example.com",
      ]);
      expect(notifiedContactIds()).toEqual(["c1", "c2"]);
      // The grant is already ours; it must not be re-claimed or re-set.
      expect(
        scopedManagerQuery.mock.calls
          .map((c) => String(c[0]))
          .filter((sql) => sql.includes("UPDATE emergency_access_settings")),
      ).toEqual([]);
    });

    it("never re-issues a token for a contact who already received one", async () => {
      grantedButUndelivered();
      contactsAre([
        {
          id: "c1",
          firstName: "Carol",
          email: "carol@example.com",
          notified: true,
        },
        { id: "c2", firstName: "Dave", email: "dave@example.com" },
      ]);

      await service.runDailyCheck();

      // Re-issuing Carol's token would invalidate the link already in her inbox,
      // and a dead emergency-access link during a recovery is indistinguishable
      // from a revoked one -- the exact P4-014 failure this must not reintroduce.
      expect(emailService.sendMail.mock.calls.map((c) => c[0])).toEqual([
        "dave@example.com",
      ]);
      expect(mintedCredentials()).toHaveLength(1);
      expect(mintedCredentials()[0].contactId).toBe("c2");
    });

    it("takes a lease, so two replicas do not both resume it", async () => {
      grantedButUndelivered();
      contactsAre([{ id: "c1", firstName: "Carol", email: "c@example.com" }]);
      jobClaims.claimLease.mockResolvedValueOnce(null);

      await service.runDailyCheck();

      expect(jobClaims.claimLease).toHaveBeenCalledWith(
        "emergency_access_grant_notify",
        userId,
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        expect.any(Number),
      );
      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it("does nothing when every contact has already been notified", async () => {
      grantedButUndelivered();
      contactsAre([
        {
          id: "c1",
          firstName: "Carol",
          email: "c@example.com",
          notified: true,
        },
      ]);

      await service.runDailyCheck();

      expect(emailService.sendMail).not.toHaveBeenCalled();
      expect(jobClaims.claimLease).not.toHaveBeenCalled();
    });

    /**
     * The send-to-marker crash boundary (audit RV4-004).
     *
     * SMTP acceptance and the delivery record cannot commit together, so a
     * process killed between them leaves a contact who may already hold a working
     * link while the row still says the notice is owed. The retry must re-send the
     * *same* link: minting a new one overwrites the hash and kills what is already
     * in their inbox, and a second send failure then leaves them with a dead link
     * during a recovery.
     */
    it("re-sends the same link rather than minting one that kills the delivered link", async () => {
      grantedButUndelivered();
      const alreadyIssued = "a".repeat(64);
      contactsAre([
        {
          id: "c1",
          firstName: "Carol",
          email: "carol@example.com",
          undeliveredToken: alreadyIssued,
        },
      ]);

      await service.runDailyCheck();

      expect(sentClaimUrls()).toEqual([alreadyIssued]);
      // Nothing on the row changed, so a link already delivered keeps working
      // whatever happens to this attempt.
      expect(mintedCredentials()).toEqual([]);
    });

    it("leaves the delivered link valid when the retry's own send fails too", async () => {
      grantedButUndelivered();
      const alreadyIssued = "b".repeat(64);
      contactsAre([
        {
          id: "c1",
          firstName: "Carol",
          email: "carol@example.com",
          undeliveredToken: alreadyIssued,
        },
      ]);
      emailService.sendMail.mockRejectedValue(new Error("smtp down"));

      await service.runDailyCheck();

      // The hash is untouched, so the token in Carol's inbox still verifies, and
      // the notice is still recorded as owed.
      expect(mintedCredentials()).toEqual([]);
      expect(notifiedContactIds()).toEqual([]);
    });

    it("clears the stored credential once delivery is recorded", async () => {
      grantedButUndelivered();
      contactsAre([
        {
          id: "c1",
          firstName: "Carol",
          email: "carol@example.com",
          undeliveredToken: "c".repeat(64),
        },
      ]);

      await service.runDailyCheck();

      // A credential is a credential: once there is nothing left to re-send it
      // must not outlive the delivery it existed for.
      const cleared = contactsRepo.createQueryBuilder.mock.results
        .flatMap((result) =>
          result.type === "return"
            ? (result.value as { set: jest.Mock }).set.mock.calls
            : [],
        )
        .map((call) => call[0] as Record<string, unknown>);
      expect(cleared).toContainEqual(
        expect.objectContaining({ claimTokenCiphertext: null }),
      );
    });

    it("rotates a token this version cannot re-send, and says so", async () => {
      // A legacy row: hash present, no stored credential. Replacing it is
      // deliberate -- a link that is delivered beats one nobody can confirm, and
      // asserting delivery instead would disarm the safeguard permanently
      // (audit RV4-003).
      grantedButUndelivered();
      contactsAre([
        {
          id: "c1",
          firstName: "Carol",
          email: "carol@example.com",
          unrecoverableToken: true,
        },
      ]);
      const warn = jest
        .spyOn(service["logger"], "warn")
        .mockImplementation(() => undefined);

      await service.runDailyCheck();

      expect(mintedCredentials()).toHaveLength(1);
      expect(sentClaimUrls()).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("cannot re-send"),
      );
    });

    it("rotates and reports when the stored credential does not decrypt", async () => {
      grantedButUndelivered();
      contactsAre([
        {
          id: "c1",
          firstName: "Carol",
          email: "carol@example.com",
          undeliveredToken: "d".repeat(64),
        },
      ]);
      encryption.decrypt.mockImplementation(() => {
        throw new Error("bad key");
      });
      const error = jest
        .spyOn(service["logger"], "error")
        .mockImplementation(() => undefined);

      await service.runDailyCheck();

      expect(mintedCredentials()).toHaveLength(1);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("Could not read the stored"),
      );
    });

    it("rotates when the stored credential no longer matches its hash", async () => {
      grantedButUndelivered();
      contactsAre([
        {
          id: "c1",
          firstName: "Carol",
          email: "carol@example.com",
          undeliveredToken: "e".repeat(64),
        },
      ]);
      // The ciphertext decrypts, but to something the hash does not verify -- the
      // pair is inconsistent, so neither can be trusted to be what was delivered.
      encryption.decrypt.mockReturnValue("f".repeat(64));
      const error = jest
        .spyOn(service["logger"], "error")
        .mockImplementation(() => undefined);

      await service.runDailyCheck();

      expect(mintedCredentials()).toHaveLength(1);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("does not match its hash"),
      );
    });

    it("stores the credential with its hash, before the first send", async () => {
      grantedButUndelivered();
      contactsAre([{ id: "c1", firstName: "Carol", email: "c@example.com" }]);

      await service.runDailyCheck();

      const saved = mintedCredentials()[0];
      expect(saved.claimTokenCiphertext).toBe(`enc(${sentClaimUrls()[0]})`);
      expect(saved.claimTokenHash).toBe(hashToken(sentClaimUrls()[0]));
      // Committed before the send, since a hash with no recoverable token is
      // exactly the state that forces a rotation later.
      expect(saved.order).toBeLessThan(
        emailService.sendMail.mock.invocationCallOrder[0],
      );
    });

    it("leaves a returning owner to the revoke path instead of resuming", async () => {
      settingsRepo.find.mockResolvedValue([
        {
          ownerUserId: userId,
          enabled: true,
          grantAfterDays: 14,
          reminderAfterDays: 7,
          messageCiphertext: null,
          lastReminderSentAt: null,
          grantedAt: daysAgo(1),
        },
      ]);
      usersRepo.findOne.mockResolvedValue({
        id: userId,
        email: "owner@example.com",
        isActive: true,
        // Signed back in: the grant is being revoked, not resumed.
        lastActivityAt: daysAgo(1),
      });
      contactsAre([{ id: "c1", firstName: "Carol", email: "c@example.com" }]);

      await service.runDailyCheck();

      // The one email is the owner's revocation notice, not a contact's link.
      expect(emailService.sendMail.mock.calls.map((c) => c[0])).toEqual([
        "owner@example.com",
      ]);
      expect(notifiedContactIds()).toEqual([]);
    });
  });

  /**
   * RRV4-004: the delivery record belongs to one grant cycle, not to the row.
   *
   * `claim_notified_at IS NULL` was the pending predicate and nothing ever set it
   * back, so emergency access fired at most once per contact for the row's
   * lifetime. The owner returns, `revokeAfterReturn` clears `granted_at` and logs
   * that monitoring is re-armed, and the next grant finds nobody owed and skips --
   * silently, with the settings page still showing the feature as armed.
   *
   * The fix is not "clear the marker in each re-arm path": there are five of those
   * in three files and a missed one is invisible. It is a generation advanced by the
   * one statement that opens a cycle, which is what these specs pin down.
   */
  describe("a second grant cycle", () => {
    const inactiveOwnerWithNoGrant = (grantGeneration: number) => {
      settingsRepo.find.mockResolvedValue([
        {
          ownerUserId: userId,
          enabled: true,
          grantAfterDays: 14,
          reminderAfterDays: 7,
          messageCiphertext: null,
          lastReminderSentAt: null,
          // Re-armed: whatever cleared `granted_at` -- the owner returning, a
          // disable/re-enable, a manual reset -- left the contacts alone.
          grantedAt: null,
          grantGeneration,
        },
      ]);
      usersRepo.findOne.mockResolvedValue({
        id: userId,
        email: "owner@example.com",
        firstName: "Owner",
        isActive: true,
        lastActivityAt: daysAgo(20),
      });
    };

    it("advances the generation in the statement that claims the grant", async () => {
      inactiveOwnerWithNoGrant(CURRENT_GENERATION - 1);
      contactsAre([{ id: "c1", firstName: "Carol", email: "c@example.com" }]);

      await service.runDailyCheck();

      // One statement, so there is no window in which a cycle is open with a
      // generation nobody has advanced -- and no re-arm path has to remember it.
      const claimSql = scopedManagerQuery.mock.calls
        .map((c) => String(c[0]))
        .find((sql) => sql.includes("UPDATE emergency_access_settings"));
      expect(claimSql).toContain("grant_generation = grant_generation + 1");
      expect(claimSql).toContain("granted_at IS NULL");
      expect(claimSql).toContain("RETURNING grant_generation");
    });

    it("owes a previously notified contact a link again", async () => {
      inactiveOwnerWithNoGrant(CURRENT_GENERATION - 1);
      contactsAre([
        {
          id: "c1",
          firstName: "Carol",
          email: "carol@example.com",
          // Notified in the cycle before this one, and never reset.
          notifiedGeneration: CURRENT_GENERATION - 1,
        },
      ]);

      await service.runDailyCheck();

      // Under the lifetime marker this was zero emails and a silent skip, for an
      // owner whose settings page said the safeguard was armed.
      expect(emailService.sendMail.mock.calls.map((c) => c[0])).toEqual([
        "carol@example.com",
      ]);
      expect(notifiedContactIds()).toEqual(["c1"]);
    });

    it("records the delivery against the cycle it was sent for", async () => {
      inactiveOwnerWithNoGrant(CURRENT_GENERATION - 1);
      contactsAre([{ id: "c1", firstName: "Carol", email: "c@example.com" }]);

      await service.runDailyCheck();

      const stamped = contactsRepo.createQueryBuilder.mock.results
        .flatMap((result) =>
          result.type === "return"
            ? (result.value as { set: jest.Mock }).set.mock.calls
            : [],
        )
        .map((call) => call[0] as Record<string, unknown>);
      // The generation is the predicate; the timestamp is for operators. One
      // statement writes both, so they cannot disagree.
      expect(stamped).toContainEqual(
        expect.objectContaining({
          notifiedGrantGeneration: CURRENT_GENERATION,
          claimNotifiedAt: expect.any(Date),
        }),
      );
    });

    it("stamps the delivery forward-only, so a stale cycle cannot lower it", async () => {
      // DR-V4R3-01: a step-1b resume that ran long while the owner re-armed must
      // not write its older generation over a newer one and re-open a served
      // contact. The write carries the generation as a predicate, not just a value.
      inactiveOwnerWithNoGrant(CURRENT_GENERATION - 1);
      contactsAre([{ id: "c1", firstName: "Carol", email: "c@example.com" }]);

      await service.runDailyCheck();

      const guarded = contactsRepo.createQueryBuilder.mock.results.some(
        (result) =>
          result.type === "return" &&
          (result.value as { andWhere: jest.Mock }).andWhere.mock.calls.some(
            (call) =>
              String(call[0]).includes("notified_grant_generation") &&
              (call[1] as { generation?: number })?.generation ===
                CURRENT_GENERATION,
          ),
      );
      expect(guarded).toBe(true);
    });

    it("still skips a contact already notified for this cycle when resuming", async () => {
      // The generation must not undo FV4-004: within one cycle a delivered link is
      // still a delivered link, and re-issuing it kills what is in the inbox.
      settingsRepo.find.mockResolvedValue([
        {
          ownerUserId: userId,
          enabled: true,
          grantAfterDays: 14,
          reminderAfterDays: 7,
          messageCiphertext: null,
          lastReminderSentAt: null,
          grantedAt: daysAgo(1),
          grantGeneration: CURRENT_GENERATION,
        },
      ]);
      usersRepo.findOne.mockResolvedValue({
        id: userId,
        email: "owner@example.com",
        isActive: true,
        lastActivityAt: daysAgo(20),
      });
      contactsAre([
        {
          id: "c1",
          firstName: "Carol",
          email: "carol@example.com",
          notifiedGeneration: CURRENT_GENERATION,
        },
        { id: "c2", firstName: "Dave", email: "dave@example.com" },
      ]);

      await service.runDailyCheck();

      expect(emailService.sendMail.mock.calls.map((c) => c[0])).toEqual([
        "dave@example.com",
      ]);
    });

    it("asks only whether the owner has contacts before opening a cycle", async () => {
      // The cycle about to open has notified nobody by definition, and its number
      // is unknown until the claim wins -- so the pre-claim question is the roster,
      // not the pending set. Asking the pending set instead would have to guess the
      // generation.
      inactiveOwnerWithNoGrant(CURRENT_GENERATION - 1);
      contactsAre([]);

      await service.runDailyCheck();

      expect(contactsRepo.count).toHaveBeenCalledWith({
        where: { ownerUserId: userId },
      });
      // `toContain` compares array members with SameValueZero, so an asymmetric
      // matcher is never a member and `.not.toContain(expect.stringContaining(...))`
      // passes whatever the service did. `arrayContaining` is the form that
      // actually applies the matcher to each element.
      expect(
        scopedManagerQuery.mock.calls.map((c) => String(c[0])),
      ).not.toEqual(
        expect.arrayContaining([expect.stringContaining("grant_generation")]),
      );
      expect(emailService.sendMail).not.toHaveBeenCalled();
    });
  });

  /**
   * RRV4-005: a reused credential is only reusable while it still works.
   *
   * The reuse itself is right -- it is what stops a retry killing the link already
   * in a recipient's inbox -- but it returned only the raw token while the caller
   * rendered the email from a fresh `now + 30 days`. So the email could state an
   * expiry the database would not honour, and a sufficiently delayed retry could
   * send a link that was already dead and then record it as delivered.
   */
  describe("the expiration a reused credential is sent with", () => {
    const grantedButUndelivered = () => {
      settingsRepo.find.mockResolvedValue([
        {
          ownerUserId: userId,
          enabled: true,
          grantAfterDays: 14,
          reminderAfterDays: 7,
          messageCiphertext: null,
          lastReminderSentAt: null,
          grantedAt: daysAgo(1),
          grantGeneration: CURRENT_GENERATION,
        },
      ]);
      usersRepo.findOne.mockResolvedValue({
        id: userId,
        email: "owner@example.com",
        isActive: true,
        lastActivityAt: daysAgo(20),
      });
    };

    /** The expiry date the grant email told the recipient, as `YYYY-MM-DD`. */
    const statedExpiry = (): string | undefined =>
      /valid until[^0-9]*(\d{4}-\d{2}-\d{2})/i.exec(
        String(emailService.sendMail.mock.calls[0]?.[2]),
      )?.[1] ??
      /(\d{4}-\d{2}-\d{2})/.exec(
        String(emailService.sendMail.mock.calls[0]?.[2]),
      )?.[1];

    const isoDay = (d: Date): string => d.toISOString().split("T")[0];

    it("states the stored expiry, not thirty days from the retry", async () => {
      grantedButUndelivered();
      contactsAre([
        {
          id: "c1",
          firstName: "Carol",
          email: "carol@example.com",
          undeliveredToken: "a".repeat(64),
          // Issued ten days ago with a thirty-day life: twenty days left, not
          // thirty, and the email must not claim otherwise.
          tokenExpiresInDays: 20,
        },
      ]);

      await service.runDailyCheck();

      expect(statedExpiry()).toBe(isoDay(daysAgo(-20)));
      expect(statedExpiry()).not.toBe(isoDay(daysAgo(-30)));
      // And the row is untouched, so the link in the inbox keeps working.
      expect(mintedCredentials()).toEqual([]);
    });

    it("mints a fresh credential when the stored one has expired", async () => {
      grantedButUndelivered();
      const dead = "b".repeat(64);
      contactsAre([
        {
          id: "c1",
          firstName: "Carol",
          email: "carol@example.com",
          undeliveredToken: dead,
          tokenExpiresInDays: -1,
        },
      ]);
      const warn = jest
        .spyOn(service["logger"], "warn")
        .mockImplementation(() => undefined);

      await service.runDailyCheck();

      // Sending the stored token here would deliver a link the claim endpoint
      // refuses, and then record it as delivered -- a contact left with a dead
      // link and no retry. Rotating destroys nothing, because an expired token is
      // already worth nothing.
      expect(sentClaimUrls()).not.toEqual([dead]);
      expect(sentClaimUrls()).toHaveLength(1);
      const saved = mintedCredentials()[0];
      expect(saved.claimTokenHash).toBe(hashToken(sentClaimUrls()[0]));
      expect(saved.claimTokenCiphertext).toBe(`enc(${sentClaimUrls()[0]})`);
      expect(saved.claimTokenExpiresAt?.getTime()).toBeGreaterThan(Date.now());
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("expired before it could be delivered"),
      );
    });

    it("states the fresh expiry for a freshly minted credential", async () => {
      grantedButUndelivered();
      contactsAre([{ id: "c1", firstName: "Carol", email: "c@example.com" }]);

      await service.runDailyCheck();

      const saved = mintedCredentials()[0];
      // Same value in the row and in the email: one function decides it.
      expect(statedExpiry()).toBe(isoDay(saved.claimTokenExpiresAt as Date));
    });
  });

  it("stamps a contact's delivery record only after their own email is sent", async () => {
    settingsRepo.find.mockResolvedValue([
      {
        ownerUserId: userId,
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: null,
        lastReminderSentAt: null,
        grantedAt: null,
      },
    ]);
    usersRepo.findOne.mockResolvedValue({
      id: userId,
      email: "owner@example.com",
      isActive: true,
      lastActivityAt: daysAgo(20),
    });
    contactsAre([
      { id: "c1", firstName: "Carol", email: "carol@example.com" },
      { id: "c2", firstName: "Dave", email: "dave@example.com" },
    ]);
    // Carol's send fails; Dave's succeeds.
    emailService.sendMail
      .mockRejectedValueOnce(new Error("smtp down"))
      .mockResolvedValueOnce(undefined);

    await service.runDailyCheck();

    // Only Dave is recorded as delivered, so tomorrow's sweep still owes Carol a
    // link -- the partial failure is recoverable rather than silent.
    expect(notifiedContactIds()).toEqual(["c2"]);
  });

  it("does not double-send the daily reminder", async () => {
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    settingsRepo.find.mockResolvedValue([
      {
        ownerUserId: userId,
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: null,
        lastReminderSentAt: today,
        grantedAt: null,
      },
    ]);
    usersRepo.findOne.mockResolvedValue({
      id: userId,
      email: "owner@example.com",
      isActive: true,
      lastActivityAt: daysAgo(10),
    });

    await service.runDailyCheck();
    expect(emailService.sendMail).not.toHaveBeenCalled();
    // The refusal comes from the delivery record, not the claim: this replica
    // *won* the lease and still declined, which is what makes "once per day"
    // survive a process death (audit FV4-005). Under a permanent pre-send claim
    // the lease would already have been consumed by whoever died holding it.
    expect(jobClaims.claimLease).toHaveBeenCalledWith(
      "emergency_access_reminder",
      userId,
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      expect.any(Number),
    );
    // And the lease goes back immediately rather than being held for its TTL.
    expect(jobClaims.releaseLease).toHaveBeenCalledWith(
      "emergency_access_reminder",
      userId,
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      // By token: a stalled attempt must not release a lease another replica has
      // retaken and is relying on (audit DR-RRV4-01).
      TEST_LEASE_TOKEN,
    );
  });

  it("leaves the reminder owed when the send fails, and hands the lease back", async () => {
    settingsRepo.find.mockResolvedValue([
      {
        ownerUserId: userId,
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: null,
        lastReminderSentAt: null,
        grantedAt: null,
      },
    ]);
    usersRepo.findOne.mockResolvedValue({
      id: userId,
      email: "owner@example.com",
      isActive: true,
      lastActivityAt: daysAgo(10),
    });
    emailService.sendMail.mockRejectedValue(new Error("smtp down"));

    await service.runDailyCheck();

    // Nothing was delivered, so the delivery record must not move -- that is what
    // keeps the notice owed rather than silently spent.
    expect(settingsRepo.createQueryBuilder).not.toHaveBeenCalled();
    expect(jobClaims.releaseLease).toHaveBeenCalledWith(
      "emergency_access_reminder",
      userId,
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      // By token: a stalled attempt must not release a lease another replica has
      // retaken and is relying on (audit DR-RRV4-01).
      TEST_LEASE_TOKEN,
    );
  });

  it("skips users without a last_activity_at or last_login timestamp", async () => {
    settingsRepo.find.mockResolvedValue([
      {
        ownerUserId: userId,
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: null,
        lastReminderSentAt: null,
        grantedAt: null,
      },
    ]);
    usersRepo.findOne.mockResolvedValue({
      id: userId,
      email: "owner@example.com",
      isActive: true,
      lastActivityAt: null,
      lastLogin: null,
    });

    await service.runDailyCheck();
    expect(emailService.sendMail).not.toHaveBeenCalled();
  });

  it("falls back to last_login when last_activity_at is null", async () => {
    settingsRepo.find.mockResolvedValue([
      {
        ownerUserId: userId,
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: null,
        lastReminderSentAt: null,
        grantedAt: null,
      },
    ]);
    usersRepo.findOne.mockResolvedValue({
      id: userId,
      email: "owner@example.com",
      firstName: "Owner",
      isActive: true,
      lastActivityAt: null,
      lastLogin: daysAgo(10),
    });
    contactsRepo.find.mockResolvedValue([]);

    await service.runDailyCheck();
    expect(emailService.sendMail).toHaveBeenCalledTimes(1);
    expect(emailService.sendMail.mock.calls[0][0]).toBe("owner@example.com");
  });

  it("returns early when nobody has emergency access enabled", async () => {
    settingsRepo.find.mockResolvedValue([]);
    await service.runDailyCheck();
    expect(usersRepo.findOne).not.toHaveBeenCalled();
    expect(emailService.sendMail).not.toHaveBeenCalled();
  });

  it("logs and continues when one contact's grant email fails to send", async () => {
    settingsRepo.find.mockResolvedValue([
      {
        ownerUserId: userId,
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: null,
        lastReminderSentAt: null,
        grantedAt: null,
      },
    ]);
    usersRepo.findOne.mockResolvedValue({
      id: userId,
      email: "owner@example.com",
      firstName: "Owner",
      isActive: true,
      lastActivityAt: daysAgo(20),
    });
    contactsRepo.find.mockResolvedValue([
      { id: "c1", firstName: "Carol", email: "carol@example.com" },
      { id: "c2", firstName: "Dave", email: "dave@example.com" },
    ]);
    emailService.sendMail
      .mockRejectedValueOnce(new Error("smtp down"))
      .mockResolvedValueOnce(undefined);

    await service.runDailyCheck();

    expect(emailService.sendMail).toHaveBeenCalledTimes(2);
  });

  it("localizes the grant email to the contact's own account language when they are a Monize user", async () => {
    settingsRepo.find.mockResolvedValue([
      {
        ownerUserId: userId,
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: null,
        lastReminderSentAt: null,
        grantedAt: null,
      },
    ]);
    usersRepo.findOne.mockImplementation((opts) =>
      opts?.where?.email === "carol@example.com"
        ? Promise.resolve({ id: "contact-1", email: "carol@example.com" })
        : Promise.resolve({
            id: userId,
            email: "owner@example.com",
            firstName: "Owner",
            isActive: true,
            lastActivityAt: daysAgo(20),
          }),
    );
    contactsRepo.find.mockResolvedValue([
      { id: "c1", firstName: "Carol", email: "carol@example.com" },
    ]);
    prefsRepo.findOne.mockResolvedValue({
      userId: "contact-1",
      language: "fr",
    });

    await service.runDailyCheck();

    expect(usersRepo.findOne).toHaveBeenCalledWith({
      where: { email: "carol@example.com" },
    });
    expect(prefsRepo.findOne).toHaveBeenCalledWith({
      where: { userId: "contact-1" },
    });
    expect(emailService.sendMail).toHaveBeenCalledTimes(1);
  });

  it("skips a user gracefully when their settings row is inactive (no email)", async () => {
    settingsRepo.find.mockResolvedValue([
      {
        ownerUserId: userId,
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: null,
        lastReminderSentAt: null,
        grantedAt: null,
      },
    ]);
    usersRepo.findOne.mockResolvedValue({
      id: userId,
      email: null,
      isActive: true,
      lastActivityAt: daysAgo(20),
    });

    await service.runDailyCheck();
    expect(emailService.sendMail).not.toHaveBeenCalled();
  });

  it("does nothing if the grant threshold is reached but the user has no contacts", async () => {
    settingsRepo.find.mockResolvedValue([
      {
        ownerUserId: userId,
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: null,
        lastReminderSentAt: null,
        grantedAt: null,
      },
    ]);
    usersRepo.findOne.mockResolvedValue({
      id: userId,
      email: "owner@example.com",
      isActive: true,
      lastActivityAt: daysAgo(20),
    });
    contactsRepo.find.mockResolvedValue([]);

    await service.runDailyCheck();
    expect(emailService.sendMail).not.toHaveBeenCalled();
    expect(settingsRepo.save).not.toHaveBeenCalled();
  });

  it("emits a grant email with no message body when decryption fails", async () => {
    encryption.decrypt.mockImplementation(() => {
      throw new Error("bad key");
    });
    settingsRepo.find.mockResolvedValue([
      {
        ownerUserId: userId,
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: "enc(corrupt)",
        lastReminderSentAt: null,
        grantedAt: null,
      },
    ]);
    usersRepo.findOne.mockResolvedValue({
      id: userId,
      email: "owner@example.com",
      firstName: "Owner",
      isActive: true,
      lastActivityAt: daysAgo(20),
    });
    contactsRepo.find.mockResolvedValue([
      { id: "c1", firstName: "Carol", email: "carol@example.com" },
    ]);

    await service.runDailyCheck();
    expect(emailService.sendMail).toHaveBeenCalledTimes(1);
    // The HTML body should not include the original ciphertext or any block
    // that requires a non-null message.
    const html = emailService.sendMail.mock.calls[0][2] as string;
    expect(html).not.toContain("enc(corrupt)");
    expect(html).not.toContain("border-left: 4px solid");
  });

  it("skips the delivery sweep, sending nothing, when the encryption key is absent", async () => {
    // The grant path encrypts each contact's claim token, so without a key
    // `credentialFor` throws for every contact -- delivering nothing and, before
    // the gate, spinning that failure every day for an already-enabled owner
    // (audit V4R3-002). The check is a single early return: no per-contact storm,
    // and the settings view's readiness flag is what tells the owner why.
    encryption.isConfigured.mockReturnValue(false);
    settingsRepo.find.mockResolvedValue([
      {
        ownerUserId: userId,
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: "enc(unreadable)",
        lastReminderSentAt: null,
        grantedAt: null,
        grantGeneration: CURRENT_GENERATION - 1,
      },
    ]);
    usersRepo.findOne.mockResolvedValue({
      id: userId,
      email: "owner@example.com",
      isActive: true,
      lastActivityAt: daysAgo(20),
    });
    contactsAre([{ id: "c1", firstName: "Carol", email: "carol@example.com" }]);

    await service.runDailyCheck();

    expect(emailService.sendMail).not.toHaveBeenCalled();
    // No grant work happened: the revocation sweep skipped the ungranted row
    // without loading its owner, and the keyless gate stopped everything else.
    expect(usersRepo.findOne).not.toHaveBeenCalled();
    expect(contactsRepo.find).not.toHaveBeenCalled();
  });

  it("uses singular phrasing in the reminder subject when daysSinceLogin === 1", async () => {
    settingsRepo.find.mockResolvedValue([
      {
        ownerUserId: userId,
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 1,
        messageCiphertext: null,
        lastReminderSentAt: null,
        grantedAt: null,
      },
    ]);
    usersRepo.findOne.mockResolvedValue({
      id: userId,
      email: "owner@example.com",
      firstName: "Owner",
      isActive: true,
      lastActivityAt: daysAgo(1),
    });
    contactsRepo.find.mockResolvedValue([]);

    await service.runDailyCheck();
    const subject = emailService.sendMail.mock.calls[0][1] as string;
    expect(subject).toContain("1 day");
    expect(subject).not.toContain("1 days");
  });

  it("logs without crashing when the outer catch sees a non-Error throw", async () => {
    settingsRepo.find.mockResolvedValue([
      {
        ownerUserId: userId,
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: null,
        lastReminderSentAt: null,
        grantedAt: null,
      },
    ]);
    usersRepo.findOne.mockImplementation(() => {
      throw "string-not-an-Error";
    });

    await expect(service.runDailyCheck()).resolves.toBeUndefined();
    expect(emailService.sendMail).not.toHaveBeenCalled();
  });

  it("logs without crashing when a per-contact send throws a non-Error value", async () => {
    settingsRepo.find.mockResolvedValue([
      {
        ownerUserId: userId,
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: null,
        lastReminderSentAt: null,
        grantedAt: null,
      },
    ]);
    usersRepo.findOne.mockResolvedValue({
      id: userId,
      email: "owner@example.com",
      isActive: true,
      lastActivityAt: daysAgo(20),
    });
    contactsRepo.find.mockResolvedValue([
      { id: "c1", firstName: "Carol", email: "carol@example.com" },
    ]);
    emailService.sendMail.mockRejectedValueOnce("smtp-string-error");

    await expect(service.runDailyCheck()).resolves.toBeUndefined();
    expect(emailService.sendMail).toHaveBeenCalledTimes(1);
  });

  it("logs without crashing when decrypt throws a non-Error value", async () => {
    encryption.decrypt.mockImplementation(() => {
      throw "decrypt-string-error";
    });
    settingsRepo.find.mockResolvedValue([
      {
        ownerUserId: userId,
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: "enc(corrupt)",
        lastReminderSentAt: null,
        grantedAt: null,
      },
    ]);
    usersRepo.findOne.mockResolvedValue({
      id: userId,
      email: "owner@example.com",
      isActive: true,
      lastActivityAt: daysAgo(20),
    });
    contactsRepo.find.mockResolvedValue([
      { id: "c1", firstName: "Carol", email: "carol@example.com" },
    ]);

    await service.runDailyCheck();
    expect(emailService.sendMail).toHaveBeenCalledTimes(1);
  });

  it("does not crash when processOne itself throws and continues to the next user", async () => {
    settingsRepo.find.mockResolvedValue([
      {
        ownerUserId: "u1",
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: null,
        lastReminderSentAt: null,
        grantedAt: null,
      },
      {
        ownerUserId: "u2",
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: null,
        lastReminderSentAt: null,
        grantedAt: null,
      },
    ]);
    usersRepo.findOne
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce({
        id: "u2",
        email: "two@example.com",
        isActive: true,
        lastActivityAt: daysAgo(10),
        lastLogin: null,
      });

    await expect(service.runDailyCheck()).resolves.toBeUndefined();
    expect(emailService.sendMail).toHaveBeenCalledTimes(1);
    expect(emailService.sendMail.mock.calls[0][0]).toBe("two@example.com");
  });

  it("continues processing other users when one fails", async () => {
    settingsRepo.find.mockResolvedValue([
      {
        ownerUserId: "u1",
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: null,
        lastReminderSentAt: null,
        grantedAt: null,
      },
      {
        ownerUserId: "u2",
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: null,
        lastReminderSentAt: null,
        grantedAt: null,
      },
    ]);
    usersRepo.findOne
      .mockResolvedValueOnce(null) // u1 missing -> skipped path
      .mockResolvedValueOnce({
        id: "u2",
        email: "two@example.com",
        isActive: true,
        lastActivityAt: daysAgo(10),
        lastLogin: null,
      });

    await service.runDailyCheck();
    expect(emailService.sendMail).toHaveBeenCalledTimes(1);
    expect(emailService.sendMail.mock.calls[0][0]).toBe("two@example.com");
  });

  it("does not commit the grant when every contact email fails to send", async () => {
    const settings = {
      ownerUserId: userId,
      enabled: true,
      grantAfterDays: 14,
      reminderAfterDays: 7,
      messageCiphertext: null,
      lastReminderSentAt: null,
      grantedAt: null,
    };
    settingsRepo.find.mockResolvedValue([settings]);
    usersRepo.findOne.mockResolvedValue({
      id: userId,
      email: "owner@example.com",
      firstName: "Owner",
      isActive: true,
      lastActivityAt: daysAgo(20),
    });
    contactsRepo.find.mockResolvedValue([
      { id: "c1", firstName: "Carol", email: "carol@example.com" },
      { id: "c2", firstName: "Dave", email: "dave@example.com" },
    ]);
    emailService.sendMail.mockRejectedValue(new Error("smtp down"));

    await service.runDailyCheck();

    // Both sends attempted, but grantedAt must stay null so the next daily
    // run retries instead of permanently disabling the safeguard.
    expect(emailService.sendMail).toHaveBeenCalledTimes(2);
    expect(settings.grantedAt).toBeNull();
    expect(settingsRepo.save).not.toHaveBeenCalled();
  });

  it("voids outstanding links and notifies the owner when they return after a grant", async () => {
    const settings = {
      ownerUserId: userId,
      enabled: true,
      grantAfterDays: 14,
      reminderAfterDays: 7,
      messageCiphertext: null,
      lastReminderSentAt: daysAgo(8),
      grantedAt: daysAgo(3),
    };
    settingsRepo.find.mockResolvedValue([settings]);
    usersRepo.findOne.mockResolvedValue({
      id: userId,
      email: "owner@example.com",
      firstName: "Owner",
      isActive: true,
      // Active again: well under the 14-day grant threshold.
      lastActivityAt: daysAgo(1),
    });
    const execute = jest.fn().mockResolvedValue({ affected: 2 });
    contactsRepo.createQueryBuilder.mockReturnValue({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute,
    });

    await service.runDailyCheck();

    // Outstanding links voided, grant state re-armed, owner emailed.
    expect(execute).toHaveBeenCalledTimes(1);
    // Re-armed with a targeted UPDATE rather than by re-saving the snapshot the
    // sweep read, so a setting the owner changed in the meantime survives.
    expect(settingsRepo.createQueryBuilder).toHaveBeenCalled();
    expect(emailService.sendMail).toHaveBeenCalledTimes(1);
    const [to, subject] = emailService.sendMail.mock.calls[0];
    expect(to).toBe("owner@example.com");
    expect(subject).toContain("while you were away");
  });
});
