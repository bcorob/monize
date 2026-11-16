import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";

import { withScopedDb } from "../common/db/scoped-db";
import { todayInTimezone, todayYMD } from "../common/date-utils";
import {
  buildPaginationMeta,
  clampPagination,
} from "../common/dto/pagination-query.dto";
import { getEffectiveTimezoneOfUser } from "../common/users-by-timezone.util";
import { primaryAttachmentSql } from "../attachments/primary-attachment.util";
import { Currency } from "../currencies/entities/currency.entity";
import { tr } from "../i18n/translate";
import { Payee } from "../payees/entities/payee.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { escapeLikePattern } from "../transactions/transaction-search.util";
import {
  CreateWarrantyDto,
  isBlank,
  nullableText,
} from "./dto/create-warranty.dto";
import { ListWarrantiesDto } from "./dto/list-warranties.dto";
import { UpdateWarrantyDto } from "./dto/update-warranty.dto";
import {
  WarrantyListResult,
  WarrantySummary,
  WarrantyView,
} from "./dto/warranty-response.dto";
import { WarrantyClaim } from "./entities/warranty-claim.entity";
import { Warranty } from "./entities/warranty.entity";
import { WarrantyTerm, termToExpiresOn } from "./warranty-expiry.util";
import {
  isTransactionInScope,
  loadLinkedTransactions,
} from "./warranty-linked-transaction";
import { loadWarrantyPayees } from "./warranty-payee";
import {
  LlmWarrantyList,
  LlmWarrantyQuery,
  llmWarrantyListQuery,
  toLlmWarrantyList,
} from "./warranty-llm-shape";
import {
  WARRANTY_EXPIRING_WINDOW_DAYS,
  WARRANTY_STATUSES,
  WarrantyStatus,
  warrantyStatus,
  warrantyStatusBounds,
} from "./warranty-status.util";

/**
 * What a read needs to know about its reader beyond the user id. `today`
 * defaults to the request's own date (`todayYMD`, the user's stored timezone
 * via `RequestContextInterceptor`); a caller outside a request passes the
 * user's date itself. `accountScope` is `delegateReadableAccountScope`'s
 * answer, resolved once per request by the controller: `undefined` for the
 * owner, and for an acting delegate the accounts they may read, possibly none.
 * A warranty itself is not account-scoped (the section admits the delegate to
 * every row); the scope decides only whether its linked purchase is shown
 * (WTY-007, design truth table C), and whether the list's `transactionId`
 * filter can match that purchase at all.
 */
export interface WarrantyReadContext {
  today?: string;
  accountScope?: readonly string[];
}

/** The stored fields that decide whether a row satisfies the table's CHECKs. */
interface WarrantyShape {
  purchaseDate: string;
  expiresOn: string | null;
  isLifetime: boolean;
  purchasePrice: number | null;
  currencyCode: string | null;
}

function cleanSerialNumbers(values: string[] | undefined): string[] {
  return (values ?? [])
    .map((value) => value.trim())
    .filter((value) => value !== "");
}

function sameSerials(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/**
 * The SQL for "this row has `status` on `today`", built from
 * `warrantyStatusBounds` so the list's filter and the summary's counts select
 * exactly the rows `warrantyStatus` labels that way (WTY-002). Parameter
 * names carry the status, so several predicates share one query.
 */
function statusPredicate(
  alias: string,
  status: WarrantyStatus,
  today: string,
): { sql: string; params: Record<string, unknown> } {
  const bounds = warrantyStatusBounds(
    status,
    today,
    WARRANTY_EXPIRING_WINDOW_DAYS,
  );
  const clauses = [`${alias}.is_lifetime = :${status}IsLifetime`];
  const params: Record<string, unknown> = {
    [`${status}IsLifetime`]: bounds.isLifetime,
  };
  if (bounds.expiresFrom !== null) {
    clauses.push(`${alias}.expires_on >= :${status}ExpiresFrom`);
    params[`${status}ExpiresFrom`] = bounds.expiresFrom;
  }
  if (bounds.expiresTo !== null) {
    clauses.push(`${alias}.expires_on <= :${status}ExpiresTo`);
    params[`${status}ExpiresTo`] = bounds.expiresTo;
  }
  return { sql: clauses.join(" AND "), params };
}

/**
 * Warranties: a purchased item, when its cover ends, and the proof of it
 * (docs/specs/warranty-tracker.md).
 *
 * A warranty never writes a ledger row, a balance or a holding (WTY-001,
 * held by `warranties.guard.spec.ts`): it reads a transaction and a payee to
 * link them and nothing else. Every refusal -- a foreign transaction or payee,
 * an unknown currency, a shape the table's CHECKs would refuse -- happens
 * inside the transaction that writes, before the write (WTY-005).
 */
@Injectable()
export class WarrantiesService {
  constructor(private readonly dataSource: DataSource) {}

  async findAll(
    userId: string,
    query: ListWarrantiesDto,
    ctx: WarrantyReadContext = {},
  ): Promise<WarrantyListResult> {
    const today = ctx.today ?? todayYMD();
    const { page, limit, skip } = clampPagination(query.page, query.limit);

    return withScopedDb(this.dataSource, async (m) => {
      // WTY-007: a delegate filtering by a purchase outside their scope gets
      // the answer an unknown id gets, an empty page, so the filter cannot
      // confirm which warranties an unreadable purchase bought.
      if (
        query.transactionId &&
        ctx.accountScope !== undefined &&
        !(await isTransactionInScope(
          m,
          userId,
          query.transactionId,
          ctx.accountScope,
        ))
      ) {
        return { data: [], pagination: buildPaginationMeta(page, limit, 0) };
      }

      const qb = m
        .getRepository(Warranty)
        .createQueryBuilder("w")
        .where("w.user_id = :userId", { userId });

      if (query.archived === true) {
        qb.andWhere("w.archived_at IS NOT NULL");
      } else {
        qb.andWhere("w.archived_at IS NULL");
      }

      if (query.status && query.status !== "all") {
        const { sql, params } = statusPredicate("w", query.status, today);
        qb.andWhere(`(${sql})`, params);
      }

      if (query.transactionId) {
        qb.andWhere("w.transaction_id = :transactionId", {
          transactionId: query.transactionId,
        });
      }

      const search = query.q?.trim();
      if (search) {
        qb.andWhere(
          "(w.name ILIKE :q OR w.vendor_name ILIKE :q OR w.model_number ILIKE :q" +
            " OR EXISTS (SELECT 1 FROM unnest(w.serial_numbers) AS sn(value) WHERE sn.value ILIKE :q))",
          { q: `%${escapeLikePattern(search)}%` },
        );
      }

      const sortDir = (defaultDir: "ASC" | "DESC") =>
        query.sortDir
          ? query.sortDir === "desc"
            ? "DESC"
            : "ASC"
          : defaultDir;
      switch (query.sort ?? "expiresOn") {
        case "name":
          qb.orderBy("w.name", sortDir("ASC"));
          break;
        case "purchaseDate":
          qb.orderBy("w.purchaseDate", sortDir("DESC")).addOrderBy(
            "w.name",
            "ASC",
          );
          break;
        case "expiresOn":
          // Lifetime rows carry no date and sort after every dated one, in
          // either direction.
          qb.orderBy("w.expiresOn", sortDir("ASC"), "NULLS LAST").addOrderBy(
            "w.name",
            "ASC",
          );
          break;
      }
      qb.addOrderBy("w.id", "ASC").skip(skip).take(limit);

      const [rows, total] = await qb.getManyAndCount();
      const data = await this.toViews(m, userId, rows, today, ctx.accountScope);
      return { data, pagination: buildPaginationMeta(page, limit, total) };
    });
  }

  async findOne(
    userId: string,
    id: string,
    ctx: WarrantyReadContext = {},
  ): Promise<WarrantyView> {
    const today = ctx.today ?? todayYMD();
    return withScopedDb(this.dataSource, async (m) => {
      const row = await this.loadOwned(m, userId, id);
      const [view] = await this.toViews(
        m,
        userId,
        [row],
        today,
        ctx.accountScope,
      );
      return view;
    });
  }

  /** Unarchived warranties counted per status on the reader's `today`. */
  async summary(
    userId: string,
    ctx: WarrantyReadContext = {},
  ): Promise<WarrantySummary> {
    const today = ctx.today ?? todayYMD();
    return withScopedDb(this.dataSource, async (m) => {
      const qb = m
        .getRepository(Warranty)
        .createQueryBuilder("w")
        .select("COUNT(*)", "total")
        .where("w.user_id = :userId", { userId })
        .andWhere("w.archived_at IS NULL");
      for (const status of WARRANTY_STATUSES) {
        const { sql, params } = statusPredicate("w", status, today);
        qb.addSelect(`COUNT(*) FILTER (WHERE ${sql})`, status).setParameters(
          params,
        );
      }
      const raw = await qb.getRawOne<Record<string, string>>();
      const counts = Object.fromEntries(
        WARRANTY_STATUSES.map((status) => [status, Number(raw?.[status] ?? 0)]),
      ) as Record<WarrantyStatus, number>;
      return {
        today,
        windowDays: WARRANTY_EXPIRING_WINDOW_DAYS,
        counts,
        total: Number(raw?.total ?? 0),
      };
    });
  }

  async create(
    userId: string,
    dto: CreateWarrantyDto,
    ctx: WarrantyReadContext = {},
  ): Promise<WarrantyView> {
    const today = ctx.today ?? todayYMD();
    return withScopedDb(this.dataSource, async (m) => {
      const saved = await this.createRow(m, userId, dto);
      const [view] = await this.toViews(m, userId, [saved], today);
      return view;
    });
  }

  /**
   * The insert behind `create`, for a caller already inside a `withScopedDb`
   * transaction that has no use for the view (the CSV import, which writes up
   * to a file's worth of rows and reads none of them back). Every refusal
   * lives here, on `m`, before the INSERT (WTY-005): the transaction and the
   * payee loaded by (id, userId), the currency by code, the table's CHECKs
   * re-validated on the merged shape. `m` must be the caller's transaction
   * manager, so a refusal rolls back whatever the caller already wrote.
   */
  async createRow(
    m: EntityManager,
    userId: string,
    dto: CreateWarrantyDto,
  ): Promise<Warranty> {
    const transactionId = nullableText(dto.transactionId);
    const payeeId = nullableText(dto.payeeId);
    const currencyCode = nullableText(dto.currencyCode);

    if (transactionId !== null) {
      await this.assertOwnedTransaction(m, userId, transactionId);
    }
    if (payeeId !== null) {
      await this.assertOwnedPayee(m, userId, payeeId);
    }
    if (currencyCode !== null) {
      await this.assertKnownCurrency(m, currencyCode);
    }

    const expiry = this.resolveExpiry(dto, dto.purchaseDate, null);
    const shape: WarrantyShape = {
      purchaseDate: dto.purchaseDate,
      expiresOn: expiry?.expiresOn ?? null,
      isLifetime: expiry?.isLifetime ?? false,
      purchasePrice: dto.purchasePrice ?? null,
      currencyCode,
    };
    this.assertShape(shape);

    const repo = m.getRepository(Warranty);
    return repo.save(
      repo.create({
        userId,
        name: dto.name.trim(),
        vendorName: nullableText(dto.vendorName),
        payeeId,
        transactionId,
        modelNumber: nullableText(dto.modelNumber),
        serialNumbers: cleanSerialNumbers(dto.serialNumbers),
        warrantyKind: dto.warrantyKind ?? "manufacturer",
        ...shape,
        productUrl: nullableText(dto.productUrl),
        notes: nullableText(dto.notes),
        archivedAt: null,
      }),
    );
  }

  /**
   * A value difference against the stored row, never a field being present:
   * the form resends every field, so a link that did not move is not loaded
   * again and a row with nothing changed is not written.
   */
  async update(
    userId: string,
    id: string,
    dto: UpdateWarrantyDto,
    ctx: WarrantyReadContext = {},
  ): Promise<WarrantyView> {
    const today = ctx.today ?? todayYMD();
    return withScopedDb(this.dataSource, async (m) => {
      const row = await this.loadOwned(m, userId, id);
      const next: Partial<Warranty> = {};

      // The DTO refuses `null` for the two NOT NULL columns; the type checks
      // here keep a null from reaching `trim()` or the write regardless.
      if (typeof dto.name === "string" && dto.name.trim() !== row.name) {
        next.name = dto.name.trim();
      }
      this.diffText(row, next, "vendorName", dto.vendorName);
      this.diffText(row, next, "modelNumber", dto.modelNumber);
      this.diffText(row, next, "productUrl", dto.productUrl);
      this.diffText(row, next, "notes", dto.notes);
      if (dto.warrantyKind != null && dto.warrantyKind !== row.warrantyKind) {
        next.warrantyKind = dto.warrantyKind;
      }
      if (dto.serialNumbers !== undefined) {
        const serials = cleanSerialNumbers(dto.serialNumbers);
        if (!sameSerials(serials, row.serialNumbers)) {
          next.serialNumbers = serials;
        }
      }

      if (dto.transactionId !== undefined) {
        const transactionId = nullableText(dto.transactionId);
        if (transactionId !== row.transactionId) {
          if (transactionId !== null) {
            await this.assertOwnedTransaction(m, userId, transactionId);
          }
          next.transactionId = transactionId;
        }
      }
      if (dto.payeeId !== undefined) {
        const payeeId = nullableText(dto.payeeId);
        if (payeeId !== row.payeeId) {
          if (payeeId !== null) {
            await this.assertOwnedPayee(m, userId, payeeId);
          }
          next.payeeId = payeeId;
        }
      }

      const purchaseDate = dto.purchaseDate ?? row.purchaseDate;
      const expiry = this.resolveExpiry(dto, purchaseDate, row);
      const shape: WarrantyShape = {
        purchaseDate,
        expiresOn: expiry ? expiry.expiresOn : row.expiresOn,
        isLifetime: expiry ? expiry.isLifetime : row.isLifetime,
        purchasePrice:
          dto.purchasePrice !== undefined
            ? dto.purchasePrice
            : row.purchasePrice,
        currencyCode:
          dto.currencyCode !== undefined
            ? nullableText(dto.currencyCode)
            : row.currencyCode,
      };
      this.assertShape(shape);

      if (
        shape.currencyCode !== null &&
        shape.currencyCode !== row.currencyCode
      ) {
        await this.assertKnownCurrency(m, shape.currencyCode);
      }
      for (const key of Object.keys(shape) as Array<keyof WarrantyShape>) {
        if (shape[key] !== row[key]) {
          Object.assign(next, { [key]: shape[key] });
        }
      }

      let current = row;
      if (Object.keys(next).length > 0) {
        current = await m.getRepository(Warranty).save({ ...row, ...next });
      }
      const [view] = await this.toViews(m, userId, [current], today);
      return view;
    });
  }

  async remove(userId: string, id: string): Promise<void> {
    await withScopedDb(this.dataSource, async (m) => {
      const result = await m.getRepository(Warranty).delete({ id, userId });
      if (!result.affected) throw this.notFound(id);
    });
  }

  /** Idempotent: archiving an archived warranty keeps its first date. */
  async archive(
    userId: string,
    id: string,
    ctx: WarrantyReadContext = {},
  ): Promise<WarrantyView> {
    return this.setArchived(userId, id, true, ctx);
  }

  async unarchive(
    userId: string,
    id: string,
    ctx: WarrantyReadContext = {},
  ): Promise<WarrantyView> {
    return this.setArchived(userId, id, false, ctx);
  }

  private async setArchived(
    userId: string,
    id: string,
    archived: boolean,
    ctx: WarrantyReadContext,
  ): Promise<WarrantyView> {
    const today = ctx.today ?? todayYMD();
    return withScopedDb(this.dataSource, async (m) => {
      let row = await this.loadOwned(m, userId, id);
      if ((row.archivedAt !== null) !== archived) {
        row = await m
          .getRepository(Warranty)
          .save({ ...row, archivedAt: archived ? new Date() : null });
      }
      const [view] = await this.toViews(m, userId, [row], today);
      return view;
    });
  }

  private diffText(
    row: Warranty,
    next: Partial<Warranty>,
    key: "vendorName" | "modelNumber" | "productUrl" | "notes",
    value: string | null | undefined,
  ): void {
    if (value === undefined) return;
    const cleaned = nullableText(value);
    if (cleaned !== row[key]) next[key] = cleaned;
  }

  /**
   * The expiry the payload names, or `null` when it names none (an update
   * keeping the stored one). The DTO has already refused two sources.
   */
  private resolveExpiry(
    dto: {
      expiresOn?: string | null;
      term?: WarrantyTerm | null;
      isLifetime?: boolean;
    },
    purchaseDate: string,
    row: Warranty | null,
  ): { expiresOn: string | null; isLifetime: boolean } | null {
    if (dto.isLifetime === true) return { expiresOn: null, isLifetime: true };
    if (!isBlank(dto.expiresOn)) {
      return { expiresOn: dto.expiresOn as string, isLifetime: false };
    }
    if (!isBlank(dto.term)) {
      try {
        return {
          expiresOn: termToExpiresOn(purchaseDate, dto.term as WarrantyTerm),
          isLifetime: false,
        };
      } catch {
        throw new BadRequestException(
          tr(
            "errors.warranties.invalidTerm",
            "A warranty term must be longer than zero",
          ),
        );
      }
    }
    // `isLifetime: false` alone ends a lifetime warranty without saying when;
    // the shape check refuses the result rather than inventing a date.
    if (dto.isLifetime === false && row?.isLifetime) {
      return { expiresOn: row.expiresOn, isLifetime: false };
    }
    return null;
  }

  /** The table's three CHECKs, refused as a 400 before the write. */
  private assertShape(shape: WarrantyShape): void {
    if (!shape.isLifetime && shape.expiresOn === null) {
      throw new BadRequestException(
        tr(
          "errors.warranties.expiryRequired",
          "A warranty that is not lifetime needs an expiry date or a term",
        ),
      );
    }
    if (shape.expiresOn !== null && shape.expiresOn < shape.purchaseDate) {
      throw new BadRequestException(
        tr(
          "errors.warranties.expiresBeforePurchase",
          "A warranty cannot expire before its purchase date",
        ),
      );
    }
    if ((shape.purchasePrice === null) !== (shape.currencyCode === null)) {
      throw new BadRequestException(
        tr(
          "errors.warranties.priceNeedsCurrency",
          "A purchase price and its currency are set together or not at all",
        ),
      );
    }
  }

  private notFound(id: string): NotFoundException {
    return new NotFoundException(
      tr("errors.warranties.notFound", `Warranty with ID ${id} not found`, {
        id,
      }),
    );
  }

  private async loadOwned(
    m: EntityManager,
    userId: string,
    id: string,
  ): Promise<Warranty> {
    const row = await m.getRepository(Warranty).findOne({
      where: { id, userId },
    });
    if (!row) throw this.notFound(id);
    return row;
  }

  /**
   * The purchase must be the caller's, and a parent row: a warranty links to
   * the whole purchase, never to the leg a split transfer wrote in another
   * account (design decision 5).
   */
  private async assertOwnedTransaction(
    m: EntityManager,
    userId: string,
    transactionId: string,
  ): Promise<void> {
    const transaction = await m.getRepository(Transaction).findOne({
      where: { id: transactionId, userId },
      select: { id: true, parentTransactionId: true },
    });
    if (!transaction) {
      throw new NotFoundException(
        tr(
          "errors.warranties.transactionNotFound",
          `Transaction with ID ${transactionId} not found`,
          { id: transactionId },
        ),
      );
    }
    if (transaction.parentTransactionId !== null) {
      throw new BadRequestException(
        tr(
          "errors.warranties.transactionIsSplitLine",
          "A warranty links to the whole purchase, not to one of its split lines",
        ),
      );
    }
  }

  private async assertOwnedPayee(
    m: EntityManager,
    userId: string,
    payeeId: string,
  ): Promise<void> {
    const payee = await m.getRepository(Payee).findOne({
      where: { id: payeeId, userId },
      select: { id: true },
    });
    if (!payee) {
      throw new NotFoundException(
        tr(
          "errors.warranties.payeeNotFound",
          `Payee with ID ${payeeId} not found`,
          {
            id: payeeId,
          },
        ),
      );
    }
  }

  /** An unknown code would fail the foreign key as a 500; refuse it as a 404. */
  private async assertKnownCurrency(
    m: EntityManager,
    code: string,
  ): Promise<void> {
    const currency = await m.getRepository(Currency).findOne({
      where: { code },
      select: { code: true },
    });
    if (!currency) {
      throw new NotFoundException(
        tr("errors.currencies.notFound", `Currency "${code}" not found`, {
          code,
        }),
      );
    }
  }

  /**
   * Rows to views: one status per row from `warrantyStatus`, and the page's
   * document counts, open-claim counts, linked purchases and vendor payees as
   * four grouped reads over the page's ids (the register's `attachmentCount` pattern),
   * awaited one after another on the transaction's connection. The writes
   * pass no `accountScope`: they are owner-only, and an owner reads every
   * account.
   */
  private async toViews(
    m: EntityManager,
    userId: string,
    rows: Warranty[],
    today: string,
    accountScope?: readonly string[],
  ): Promise<WarrantyView[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);

    // `warranty_id` is the attachment's second parent (design 6.3); a scan
    // pair counts once, as the register's paperclip does.
    const documentRows: Array<{ warranty_id: string; count: string }> =
      await m.query(
        `SELECT ta.warranty_id, COUNT(*) AS count
           FROM transaction_attachments ta
          WHERE ta.warranty_id = ANY($1::uuid[])
            AND ta.user_id = $2
            AND ${primaryAttachmentSql("ta")}
          GROUP BY ta.warranty_id`,
        [ids, userId],
      );
    const documentCounts = new Map(
      documentRows.map((r) => [r.warranty_id, Number(r.count)]),
    );

    const claimRows = await m
      .getRepository(WarrantyClaim)
      .createQueryBuilder("c")
      .select("c.warranty_id", "warrantyId")
      .addSelect("COUNT(*)", "count")
      .where("c.warranty_id IN (:...ids)", { ids })
      .andWhere("c.user_id = :userId", { userId })
      .andWhere("c.status = :open", { open: "open" })
      .groupBy("c.warranty_id")
      .getRawMany<{ warrantyId: string; count: string }>();
    const openClaimCounts = new Map(
      claimRows.map((r) => [r.warrantyId, Number(r.count)]),
    );

    const linked = await loadLinkedTransactions(m, userId, rows, accountScope);
    const payees = await loadWarrantyPayees(m, userId, rows);

    return rows.map((row) => {
      const { status, daysLeft } = warrantyStatus(
        row.expiresOn,
        row.isLifetime,
        today,
        WARRANTY_EXPIRING_WINDOW_DAYS,
      );
      const linkedTransaction =
        row.transactionId !== null
          ? (linked.get(row.transactionId) ?? null)
          : null;
      const view: WarrantyView = {
        id: row.id,
        name: row.name,
        vendorName: row.vendorName,
        payeeId: row.payeeId,
        payee: row.payeeId !== null ? (payees.get(row.payeeId) ?? null) : null,
        modelNumber: row.modelNumber,
        serialNumbers: row.serialNumbers ?? [],
        warrantyKind: row.warrantyKind,
        purchaseDate: row.purchaseDate,
        expiresOn: row.expiresOn,
        isLifetime: row.isLifetime,
        purchasePrice:
          row.purchasePrice === null ? null : Number(row.purchasePrice),
        currencyCode: row.currencyCode,
        productUrl: row.productUrl,
        notes: row.notes,
        today,
        status,
        daysLeft,
        documentCount: documentCounts.get(row.id) ?? 0,
        openClaimCount: openClaimCounts.get(row.id) ?? 0,
        linkedTransaction,
        linkedTransactionHidden:
          accountScope !== undefined &&
          row.transactionId !== null &&
          linkedTransaction === null,
        archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
      // Truth table C: the owner always learns the id; a delegate learns it
      // only with the purchase itself, so a link they may not read leaves no
      // trace in the response.
      if (
        row.transactionId !== null &&
        (accountScope === undefined || linkedTransaction !== null)
      ) {
        view.transactionId = row.transactionId;
      }
      return view;
    });
  }

  /**
   * The `list_warranties` tool on both AI surfaces (design decision 11): the
   * MCP tool and the assistant's executor are thin adapters over this one
   * method, so they answer the same shape. It reads through `findAll`, so the
   * status filter, the search and every row's `status` and `daysLeft` are the
   * list route's own (WTY-002), and the linked purchase is narrowed by
   * `ctx.accountScope` exactly as the route narrows it (WTY-007):
   * `linkedTransactionId` is null both when there is no link and when the
   * reader may not see it. Unarchived rows only, soonest expiry first.
   */
  /**
   * Today in the user's effective timezone (`getEffectiveTimezoneOfUser`: the
   * explicit preference, else the last client timezone seen, else UTC), for a
   * caller with no request timezone to read, such as the MCP transport. A zone
   * that does not resolve counts in UTC, as the expiry reminder does.
   */
  async todayForUser(userId: string, now: Date = new Date()): Promise<string> {
    const timezone = await withScopedDb(this.dataSource, (m) =>
      getEffectiveTimezoneOfUser(m, userId),
    );
    return (
      todayInTimezone(timezone, now) ?? (todayInTimezone("UTC", now) as string)
    );
  }

  async getLlmWarranties(
    userId: string,
    query: LlmWarrantyQuery,
    ctx: WarrantyReadContext = {},
  ): Promise<LlmWarrantyList> {
    const today = ctx.today ?? todayYMD();
    const { data, pagination } = await this.findAll(
      userId,
      llmWarrantyListQuery(query),
      { ...ctx, today },
    );
    return toLlmWarrantyList(today, data, pagination.total);
  }
}
