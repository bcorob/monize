import {
  Injectable,
  Logger,
  ConflictException,
  NotFoundException,
  ForbiddenException,
  OnApplicationBootstrap,
} from "@nestjs/common";
import { tr } from "../i18n/translate";
import { DataSource, EntityManager } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { withSystemContext } from "../common/db/with-context";
import { Currency } from "./entities/currency.entity";
import { UserCurrencyPreference } from "./entities/user-currency-preference.entity";
import { CreateCurrencyDto } from "./dto/create-currency.dto";
import { UpdateCurrencyDto } from "./dto/update-currency.dto";
import {
  CURRENCY_METADATA,
  resolveCurrencyMetadata,
  getCurrencyCatalog,
  type CurrencyMetadata,
} from "./currency-metadata";
import { FALLBACK_DEFAULT_CURRENCY } from "../common/default-currency.util";

export interface CurrencyLookupResult {
  code: string;
  name: string;
  symbol: string;
  decimalPlaces: number;
}

export interface CurrencyUsageMap {
  [code: string]: { accounts: number; securities: number };
}

export interface UserCurrencyView {
  code: string;
  name: string;
  symbol: string;
  decimalPlaces: number;
  isActive: boolean;
  isSystem: boolean;
  createdAt: Date;
}

// The currency every new user's preferences default to (see
// buildDefaultPreferences), and the one every reporting surface falls back to
// when a preference row is missing -- so it is the SAME constant, derived rather
// than restated. It must exist because user_preferences.default_currency has a
// foreign key to currencies(code), and because a fallback to a currency with no
// row resolves no rate at all: every converted total would be withheld.
const DEFAULT_CURRENCY_CODE = FALLBACK_DEFAULT_CURRENCY;

@Injectable()
export class CurrenciesService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CurrenciesService.name);

  constructor(private dataSource: DataSource) {}

  /**
   * Currencies are created on demand rather than pre-seeded, but a brand-new
   * instance still needs the default-preference currency to exist: registration
   * writes user_preferences.default_currency = 'USD', which has a foreign key to
   * currencies(code). Guarantee that single currency on startup so the first
   * user can register before anyone picks a currency at onboarding. Idempotent.
   *
   * RLS: this is a bootstrap hook, so there is no request/user context for
   * `withScopedDb` to spend -- and the row it writes is a system currency owned
   * by nobody. It runs under `withSystemContext`, like the seeders (C3).
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await withSystemContext(() =>
        this.ensureSystemCurrency(DEFAULT_CURRENCY_CODE),
      );
    } catch (err) {
      this.logger.warn(
        `Could not ensure default currency ${DEFAULT_CURRENCY_CODE} on startup: ${err?.message ?? err}`,
      );
    }
  }

  async create(
    userId: string,
    dto: CreateCurrencyDto,
  ): Promise<UserCurrencyView> {
    const code = dto.code.toUpperCase();

    // One transaction: every branch below is "look, then insert", so splitting
    // the read from the write would let a concurrent request slip between them.
    return withScopedDb(this.dataSource, async (manager) =>
      this.createWithin(manager, userId, dto, code),
    );
  }

  private async createWithin(
    manager: EntityManager,
    userId: string,
    dto: CreateCurrencyDto,
    code: string,
  ): Promise<UserCurrencyView> {
    const currencyRepo = manager.getRepository(Currency);

    const existing = await currencyRepo.findOne({
      where: { code },
    });

    if (existing) {
      // Check if this user already has this currency in their list
      const existingPref = await manager
        .getRepository(UserCurrencyPreference)
        .findOne({
          where: { userId, currencyCode: code },
        });
      if (existingPref) {
        // Distinguish an already-active currency from one the user previously
        // deactivated: the inactive case ships a machine-readable `errorCode`
        // so the UI can offer to reactivate it instead of leaving the user
        // stuck (the currency is hidden from their active list).
        if (!existingPref.isActive) {
          throw new ConflictException({
            message: tr(
              "errors.currencies.alreadyInListInactive",
              `Currency "${code}" is already in your list but currently inactive. Reactivate it to use it.`,
              { code },
            ),
            errorCode: "CURRENCY_INACTIVE",
            currencyCode: code,
          });
        }
        throw new ConflictException(
          tr(
            "errors.currencies.alreadyInList",
            `Currency "${code}" is already in your list`,
            { code },
          ),
        );
      }

      // Add preference row so user can see/use the existing currency
      await manager.query(
        `INSERT INTO user_currency_preferences (user_id, currency_code, is_active)
         VALUES ($1, $2, true)
         ON CONFLICT (user_id, currency_code) DO NOTHING`,
        [userId, code],
      );

      return this.buildUserCurrencyView(existing, true);
    }

    // Currency doesn't exist — create it as a user-created currency
    const currency = currencyRepo.create({
      ...dto,
      code,
      decimalPlaces: dto.decimalPlaces ?? 2,
      isActive: true,
      createdByUserId: userId,
    });
    await currencyRepo.save(currency);

    // Add preference row for the creator
    await manager.query(
      `INSERT INTO user_currency_preferences (user_id, currency_code, is_active)
       VALUES ($1, $2, true)
       ON CONFLICT (user_id, currency_code) DO NOTHING`,
      [userId, code],
    );

    return this.buildUserCurrencyView(currency, true);
  }

  async findAll(
    userId: string,
    includeInactive = false,
  ): Promise<UserCurrencyView[]> {
    let query = `
      SELECT c.code, c.name, c.symbol,
             c.decimal_places AS "decimalPlaces",
             COALESCE(ucp.is_active, c.is_active) AS "isActive",
             (c.created_by_user_id IS NULL) AS "isSystem",
             c.created_at AS "createdAt"
      FROM currencies c
      LEFT JOIN user_currency_preferences ucp
        ON ucp.currency_code = c.code AND ucp.user_id = $1
      WHERE (c.created_by_user_id IS NULL OR ucp.user_id IS NOT NULL)`;

    if (!includeInactive) {
      query += ` AND COALESCE(ucp.is_active, c.is_active) = true`;
    }

    query += ` ORDER BY c.code ASC`;

    // One transaction around the whole block: the lazy-create fallback re-runs
    // the same query and must see the row it just wrote. The nested
    // `ensureSystemCurrency` joins this transaction (scoped-db re-entrancy).
    return withScopedDb(this.dataSource, async (manager) => {
      const rows: UserCurrencyView[] = await manager.query(query, [userId]);

      // A fresh instance no longer pre-seeds a list of currencies; the user's
      // chosen currency is created when they pick it at onboarding. If they
      // skipped onboarding this list is empty on first use, so lazily create
      // their default-preference currency (with a proper symbol) here.
      if (rows.length === 0) {
        const prefRows: Array<{ default_currency: string | null }> =
          await manager.query(
            `SELECT default_currency FROM user_preferences WHERE user_id = $1`,
            [userId],
          );
        const defaultCurrency = prefRows[0]?.default_currency;
        if (defaultCurrency) {
          await this.ensureSystemCurrency(defaultCurrency);
          return manager.query(query, [userId]);
        }
      }

      return rows;
    });
  }

  /**
   * The catalog of known currencies (curated metadata) used to populate the
   * onboarding picker without pre-seeding every currency into the database.
   */
  getCatalog(): CurrencyLookupResult[] {
    return getCurrencyCatalog();
  }

  /**
   * Ensure a system currency row exists for `code`, creating it from the
   * curated/derived metadata (name, symbol, decimal places) when missing.
   * Idempotent and safe to call on every default-currency change. Used so we
   * create a currency on demand -- with a real symbol -- instead of seeding a
   * whole list up front.
   */
  async ensureSystemCurrency(code: string): Promise<void> {
    const upper = code.toUpperCase();
    await withScopedDb(this.dataSource, async (manager) => {
      const existing = await manager.getRepository(Currency).findOne({
        where: { code: upper },
      });
      if (existing) return;

      const meta = resolveCurrencyMetadata(upper);
      await manager.query(
        `INSERT INTO currencies (code, name, symbol, decimal_places, is_active, created_by_user_id)
       VALUES ($1, $2, $3, $4, true, NULL)
       ON CONFLICT (code) DO NOTHING`,
        [upper, meta.name, meta.symbol, meta.decimalPlaces],
      );
    });
  }

  async findOne(code: string): Promise<Currency> {
    const currency = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(Currency).findOne({
        where: { code: code.toUpperCase() },
      }),
    );
    if (!currency) {
      throw new NotFoundException(
        tr("errors.currencies.notFound", `Currency "${code}" not found`, {
          code,
        }),
      );
    }
    return currency;
  }

  async update(
    userId: string,
    code: string,
    dto: UpdateCurrencyDto,
  ): Promise<UserCurrencyView> {
    // Read-modify-write: the ownership check, the metadata save and the
    // preference upsert are one unit. Nested calls join this transaction.
    return withScopedDb(this.dataSource, (manager) =>
      this.updateWithin(manager, userId, code, dto),
    );
  }

  private async updateWithin(
    manager: EntityManager,
    userId: string,
    code: string,
    dto: UpdateCurrencyDto,
  ): Promise<UserCurrencyView> {
    const currency = await this.findOne(code);

    // System currencies: cannot modify metadata
    if (currency.createdByUserId === null) {
      throw new ForbiddenException(
        tr(
          "errors.currencies.cannotModifySystem",
          "Cannot modify system currency metadata",
        ),
      );
    }

    // Non-system currencies: only the creator can modify metadata
    if (currency.createdByUserId !== userId) {
      throw new ForbiddenException(
        tr(
          "errors.currencies.cannotModifyOther",
          "Cannot modify another user's currency",
        ),
      );
    }

    // Handle isActive separately via preference row
    const { isActive, ...metadataUpdates } = dto;

    if (Object.keys(metadataUpdates).length > 0) {
      Object.assign(currency, metadataUpdates);
      await manager.getRepository(Currency).save(currency);
    }

    if (isActive !== undefined) {
      await this.upsertPreference(userId, currency.code, isActive);
    }

    const pref = await manager.getRepository(UserCurrencyPreference).findOne({
      where: { userId, currencyCode: currency.code },
    });

    return this.buildUserCurrencyView(
      currency,
      pref ? pref.isActive : currency.isActive,
    );
  }

  async deactivate(userId: string, code: string): Promise<UserCurrencyView> {
    const currency = await this.findOne(code);
    await this.upsertPreference(userId, currency.code, false);
    return this.buildUserCurrencyView(currency, false);
  }

  async activate(userId: string, code: string): Promise<UserCurrencyView> {
    const currency = await this.findOne(code);
    await this.upsertPreference(userId, currency.code, true);
    return this.buildUserCurrencyView(currency, true);
  }

  async remove(userId: string, code: string): Promise<void> {
    // The in-use checks and the two deletes are one read-modify-write: a
    // concurrent account referencing the currency between them would strand a
    // foreign key. Nested calls join this transaction.
    await withScopedDb(this.dataSource, (manager) =>
      this.removeWithin(manager, userId, code),
    );
  }

  private async removeWithin(
    manager: EntityManager,
    userId: string,
    code: string,
  ): Promise<void> {
    const upperCode = code.toUpperCase();
    const currency = await this.findOne(upperCode);

    // Lock the parent row before anything that depends on its liveness.
    //
    // Without this, the transaction boundary alone is not enough. A concurrent
    // activation is an INSERT into `user_currency_preferences`, whose FK to
    // `currencies(code)` is `ON DELETE CASCADE`: another user could insert and
    // commit a preference after the global liveness check said the code was free
    // and before the DELETE ran, and the cascade then removed the row they had
    // just been told was saved. They got a success response and lost the setting.
    //
    // `FOR UPDATE` on the parent is what serialises this, and it does so through
    // the FK machinery rather than in spite of it: an FK check takes `FOR KEY
    // SHARE` on the parent row, which conflicts with `FOR UPDATE`. So B's insert
    // waits, and once this transaction commits the delete, B's FK check fails
    // with a plain violation -- a clear error instead of a silent removal.
    //
    // `findOne` above is a plain read and cannot carry the lock, so this is a
    // separate statement rather than a locked variant of it: the row identity is
    // already known, and what is needed here is the lock, not the columns.
    await manager.query("SELECT 1 FROM currencies WHERE code = $1 FOR UPDATE", [
      upperCode,
    ]);

    // Check if in use by this user
    const inUse = await this.isInUse(userId, upperCode);
    if (inUse) {
      throw new ConflictException(
        tr(
          "errors.currencies.inUse",
          `Currency "${code}" is in use by your accounts, securities, or other records. Deactivate it instead.`,
          { code },
        ),
      );
    }

    const prefRepo = manager.getRepository(UserCurrencyPreference);

    // Remove this user's preference row
    await prefRepo.delete({
      userId,
      currencyCode: upperCode,
    });

    // The currency row itself is cleaned up only by its **creator**, and only
    // when nothing anywhere still points at it (INV-CURRENCY-001). Deactivation
    // above is every activator's own action, so a non-creator reaches here too
    // -- but `createdByUserId !== null` ("is this a custom currency") was the
    // wrong gate: it let user B, who had merely activated user A's custom
    // currency, delete A's shared row out from under them once the global count
    // hit zero. The row belongs to A; B removing their activation leaves it for
    // A to keep or clean up. `=== userId` is the creator check, and because
    // `userId` is never null it still skips system currencies exactly as before.
    //
    // The preference row above is deleted as of this transaction, so a remaining
    // reference is somebody else's -- and the check has to be able to see
    // somebody else's rows, which is what makes it a SECURITY DEFINER function
    // rather than a query here.
    //
    // The counting query this replaced (`prefRepo.count({ currencyCode })`) ran
    // under the caller's RLS scope, so it only ever counted the row just
    // deleted: it reported zero for a code another user had activated, and the
    // ON DELETE CASCADE on `user_currency_preferences.currency_code` then took
    // that user's activation with it.
    if (currency.createdByUserId === userId) {
      if (!(await this.isInUseGlobally(manager, upperCode))) {
        await manager.getRepository(Currency).remove(currency);
      }
    }
  }

  /**
   * Does this user's own data still depend on `code`?
   *
   * The referencing columns are not spelled out here. They were, and the list
   * was missing `budgets.currency_code`: a user with a budget denominated in a
   * custom currency was told the code was not "in use by your accounts,
   * securities, or other records", had their activation row deleted, and was
   * left holding a budget in a currency that no longer appeared anywhere in
   * their settings -- so they could neither see it nor reactivate it. That is
   * the third time this list has been written out and been wrong, which is why
   * it now lives in `currency_codes_referenced_by_user_data` (migration 137)
   * where `currency-references.spec.ts` can check it against the schema.
   *
   * The `_data` variant, not the composite: this runs *before* the caller's own
   * `user_currency_preferences` row is deleted, and the composite counts that
   * row -- so it would report every visible currency as in use and no currency
   * could ever be deleted.
   */
  async isInUse(userId: string, code: string): Promise<boolean> {
    const result = await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `SELECT EXISTS (
           SELECT 1 FROM currency_codes_referenced_by_user_data($2) AS referenced(code)
            WHERE referenced.code = $1
         ) AS "inUse"`,
        [code.toUpperCase(), userId],
      ),
    );
    return result[0]?.inUse === true;
  }

  async getUsage(userId: string): Promise<CurrencyUsageMap> {
    const rows: Array<{
      code: string;
      accounts: string;
      securities: string;
    }> = await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `SELECT c.code,
        COALESCE(a.cnt, 0)::text AS accounts,
        COALESCE(s.cnt, 0)::text AS securities
      FROM currencies c
      LEFT JOIN user_currency_preferences ucp
        ON ucp.currency_code = c.code AND ucp.user_id = $1
      LEFT JOIN (
        SELECT currency_code, COUNT(*) AS cnt
        FROM accounts WHERE is_closed = false AND user_id = $1
        GROUP BY currency_code
      ) a ON a.currency_code = c.code
      LEFT JOIN (
        SELECT currency_code, COUNT(*) AS cnt
        FROM securities WHERE is_active = true AND user_id = $1
        GROUP BY currency_code
      ) s ON s.currency_code = c.code
      WHERE c.created_by_user_id IS NULL OR ucp.user_id IS NOT NULL`,
        [userId],
      ),
    );

    const usage: CurrencyUsageMap = {};
    for (const row of rows) {
      usage[row.code] = {
        accounts: parseInt(row.accounts, 10),
        securities: parseInt(row.securities, 10),
      };
    }
    return usage;
  }

  async lookupCurrency(query: string): Promise<CurrencyLookupResult | null> {
    const trimmed = query.trim();
    if (trimmed.length < 2) return null;

    try {
      // 1. Check if query matches a currency code directly
      const upperQuery = trimmed.toUpperCase();
      const directMetadata = CURRENCY_METADATA[upperQuery];
      if (directMetadata) {
        return this.verifyAndReturnCurrency(upperQuery, directMetadata);
      }

      // 2. Search our metadata by name (handles country names, currency names, etc.)
      const metadataMatch = this.searchMetadataByText(trimmed);
      if (metadataMatch) {
        return this.verifyAndReturnCurrency(
          metadataMatch.code,
          metadataMatch.metadata,
        );
      }

      // 3. Fall back to Yahoo Finance search API for unknown currencies
      const searchUrl = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(trimmed)}&quotesCount=20&newsCount=0`;
      const searchResponse = await fetch(searchUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
      });

      if (!searchResponse.ok) {
        this.logger.warn(
          `Yahoo Finance search returned ${searchResponse.status} for currency query: ${query}`,
        );
        return null;
      }

      const searchData = await searchResponse.json();
      const quotes = searchData.quotes || [];

      // Find currency-type results (forex pairs like EURUSD=X)
      const currencyQuotes = quotes.filter(
        (q: any) =>
          q.quoteType === "CURRENCY" || (q.symbol && q.symbol.includes("=X")),
      );

      if (currencyQuotes.length === 0) {
        return null;
      }

      // Extract the currency code from the first forex pair result
      const firstResult = currencyQuotes[0];
      const resultCode = this.extractCurrencyCode(
        firstResult.symbol,
        upperQuery,
      );

      const resultMetadata = CURRENCY_METADATA[resultCode];

      return {
        code: resultCode,
        name: resultMetadata?.name || resultCode,
        symbol: resultMetadata?.symbol || resultCode,
        decimalPlaces: resultMetadata?.decimalPlaces ?? 2,
      };
    } catch (error) {
      this.logger.error(`Failed to lookup currency: ${error.message}`);
      return null;
    }
  }

  // ── Private helpers ─────────────────────────────────────────────

  private async upsertPreference(
    userId: string,
    code: string,
    isActive: boolean,
  ): Promise<void> {
    await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `INSERT INTO user_currency_preferences (user_id, currency_code, is_active)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, currency_code)
       DO UPDATE SET is_active = $3`,
        [userId, code.toUpperCase(), isActive],
      ),
    );
  }

  /**
   * Whether any row anywhere still references the code -- including rows this
   * tenant cannot see.
   *
   * Written out here, this query answered a different question than its name
   * claimed. It listed only some of the columns that reference
   * `currencies(code)` (missing `budgets.currency_code` and both
   * `exchange_rates` columns), and it ran inside the caller's scoped
   * transaction, where RLS filters every table to the current user. So
   * "referenced by anybody" was really "referenced by me" -- and the caller had
   * already established that it was not, which made the check a no-op that
   * cleared the way for the `user_currency_preferences` cascade to delete
   * another user's activation.
   *
   * `currency_code_in_use_globally` (migration 136) is SECURITY DEFINER, so it
   * sees every row, and it runs inside this transaction, so the answer cannot
   * go stale between the check and the delete it guards.
   */
  private async isInUseGlobally(
    manager: EntityManager,
    code: string,
  ): Promise<boolean> {
    const result = await manager.query(
      `SELECT currency_code_in_use_globally($1) AS "inUse"`,
      [code.toUpperCase()],
    );
    return result[0]?.inUse === true;
  }

  private buildUserCurrencyView(
    currency: Currency,
    isActive: boolean,
  ): UserCurrencyView {
    return {
      code: currency.code,
      name: currency.name,
      symbol: currency.symbol,
      decimalPlaces: currency.decimalPlaces,
      isActive,
      isSystem: currency.createdByUserId === null,
      createdAt: currency.createdAt,
    };
  }

  /**
   * Search CURRENCY_METADATA entries by name text (case-insensitive substring match).
   * Supports queries like "Malaysia", "Ringgit", "Canadian Dollar", "Japan", etc.
   */
  private searchMetadataByText(
    query: string,
  ): { code: string; metadata: CurrencyMetadata } | null {
    const lowerQuery = query.toLowerCase();

    // Exact name match first
    for (const [code, meta] of Object.entries(CURRENCY_METADATA)) {
      if (meta.name.toLowerCase() === lowerQuery) {
        return { code, metadata: meta };
      }
    }

    // Substring match (e.g., "Ringgit" matches "Malaysian Ringgit")
    const matches: Array<{
      code: string;
      metadata: CurrencyMetadata;
    }> = [];
    for (const [code, meta] of Object.entries(CURRENCY_METADATA)) {
      if (meta.name.toLowerCase().includes(lowerQuery)) {
        matches.push({ code, metadata: meta });
      }
    }

    return matches.length === 1 ? matches[0] : null;
  }

  /**
   * Verify a currency exists on Yahoo Finance and return our metadata name.
   */
  private async verifyAndReturnCurrency(
    code: string,
    metadata: CurrencyMetadata,
  ): Promise<CurrencyLookupResult> {
    try {
      const yahooSymbol = `${code}USD=X`;
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1d&range=1d`;
      const response = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
      });

      if (response.ok) {
        // Verified on Yahoo - use our metadata name (not Yahoo's forex pair name)
        return {
          code,
          name: metadata.name,
          symbol: metadata.symbol,
          decimalPlaces: metadata.decimalPlaces,
        };
      }
    } catch (err) {
      this.logger.debug(
        `Yahoo verification failed for ${code}, falling back to local metadata: ${err instanceof Error ? err.message : err}`,
      );
    }

    return {
      code,
      name: metadata.name,
      symbol: metadata.symbol,
      decimalPlaces: metadata.decimalPlaces,
    };
  }

  /**
   * Extract a currency code from a Yahoo Finance forex symbol like "EURUSD=X"
   */
  private extractCurrencyCode(symbol: string, originalQuery: string): string {
    // Remove =X suffix
    const pair = symbol.replace("=X", "");
    // Forex pairs are 6 chars: EURUSD -> EUR + USD
    if (pair.length === 6) {
      const base = pair.substring(0, 3);
      const quote = pair.substring(3, 6);
      // Return whichever part matches the query
      const upperQuery = originalQuery.toUpperCase();
      if (base === upperQuery) return base;
      if (quote === upperQuery) return quote;
      return base; // Default to base currency
    }
    return originalQuery.toUpperCase();
  }
}
