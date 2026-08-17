import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  BadRequestException,
} from "@nestjs/common";
import { tr } from "../i18n/translate";
import { DataSource, EntityManager, In } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { Security } from "./entities/security.entity";
import { SecurityTag } from "./entities/security-tag.entity";
import { Holding } from "./entities/holding.entity";
import { InvestmentTransaction } from "./entities/investment-transaction.entity";
import { Tag } from "../tags/entities/tag.entity";
import { CreateSecurityDto } from "./dto/create-security.dto";
import { UpdateSecurityDto } from "./dto/update-security.dto";
import { SecurityPriceService } from "./security-price.service";
import { YahooFinanceService } from "./yahoo-finance.service";
import { ActionHistoryService } from "../action-history/action-history.service";
import { SecurityLookupResult } from "./providers/quote-provider.interface";
import { UserPreference } from "../users/entities/user-preference.entity";
import { normalizeWebsite } from "../common/normalize-website";
import {
  normalizeCountryName,
  normalizeAssetName,
  isOtherAllocationName,
  countryForCurrency,
  COUNTRY_OPTIONS,
} from "./security-enums";

/** A single {name, weight} allocation slice; weight is a decimal 0-1. */
export interface AllocationWeight {
  name: string;
  weight: number;
}

export interface FavouriteSecurityQuote {
  securityId: string;
  symbol: string;
  name: string;
  currencyCode: string;
  currentPrice: number | null;
  previousPrice: number | null;
  dailyChange: number;
  dailyChangePercent: number;
}

/**
 * Outcome of resolving a free-text security reference (symbol or name).
 * `match` is the single resolved security; when the reference is ambiguous,
 * `match` is null and `candidates` lists the securities it could mean so the
 * caller can ask the user to disambiguate.
 */
export interface SecurityMatchResult {
  match: Security | null;
  candidates: Security[];
}

/**
 * Resolved, validated security a `create_security` proposal will persist. The
 * symbol/name/exchange/securityType/currency are filled from the user's
 * configured quote provider (Yahoo/MSN) so the AI does not invent them; an
 * AI-supplied `exchange`/`securityType` (constrained to the known lists)
 * overrides the looked-up value when given. Display-only on the confirmation
 * card and turned into a signed descriptor by the action builder.
 */
export interface CreateSecurityPreview {
  symbol: string;
  name: string;
  securityType: string | null;
  exchange: string | null;
  currencyCode: string;
  isFavourite: boolean;
  quoteProvider: "yahoo" | "msn" | null;
  msnInstrumentId: string | null;
}

/**
 * Resolved preview of a proposed security edit. Carries the resulting
 * classification/display fields so the confirmation card shows what the edit
 * will do and confirm applies an idempotent overwrite of the identified
 * security.
 */
export interface UpdateSecurityPreview {
  securityId: string;
  symbol: string;
  name: string;
  securityType: string | null;
  exchange: string | null;
  currencyCode: string;
  isFavourite: boolean;
  /** Manual country allocation (decimal 0-1 weights), when the edit sets it. */
  countryWeightings: { name: string; weight: number }[] | null;
  /** Manual asset-class allocation (decimal 0-1 weights), when the edit sets it. */
  assetWeightings: { name: string; weight: number }[] | null;
}

/** Resolved preview of a proposed security deletion. */
export interface DeleteSecurityPreview {
  securityId: string;
  symbol: string;
  name: string;
}

/** One candidate returned by the LLM/MCP security lookup tool. */
export interface LlmSecurityLookupCandidate {
  symbol: string;
  name: string;
  exchange: string | null;
  securityType: string | null;
  currencyCode: string | null;
  /** Quote provider that produced this match (yahoo/msn), when known. */
  provider: string | null;
  /** True when a security with this symbol is already in the user's list. */
  alreadyAdded: boolean;
}

/** Compact, LLM-friendly result of a Yahoo/MSN security lookup. */
export interface LlmSecurityLookup {
  query: string;
  count: number;
  candidates: LlmSecurityLookupCandidate[];
}

@Injectable()
export class SecuritiesService {
  private readonly logger = new Logger(SecuritiesService.name);

  constructor(
    private securityPriceService: SecurityPriceService,
    private yahooFinanceService: YahooFinanceService,
    private actionHistoryService: ActionHistoryService,
    private dataSource: DataSource,
  ) {}

  /**
   * Best-effort suggested description for a security from the Yahoo provider's
   * profile data, for the "Fetch from Yahoo" pre-fill button. Read-only and
   * advisory: it persists nothing and the user always reviews/edits the result
   * before saving. Returns `description: null` when Yahoo has nothing usable.
   */
  async getSuggestedDescription(
    symbol: string,
    exchange?: string | null,
  ): Promise<{
    symbol: string;
    description: string | null;
    website: string | null;
  }> {
    // One call gives both: the website rides along in the `summaryProfile` this
    // already requested. Advisory like the description -- the user reviews the
    // pre-fill before saving. Null for a fund, where Yahoo publishes no URL.
    const { description, website } =
      await this.yahooFinanceService.fetchSecurityProfile(
        symbol,
        exchange ?? null,
      );
    return { symbol, description, website };
  }

  /**
   * Clean a manual country (or similar) allocation breakdown before persisting:
   * snaps names to canonical countries, trims blanks, sums duplicate names,
   * clamps each weight into [0,1], drops zero-weight slices, and rejects a set
   * whose weights total more than 1.0 (with a small rounding tolerance). The
   * slices need not sum to 1.0 -- the shortfall is "Other" and is not stored.
   * Returns null when nothing meaningful remains so the column clears cleanly.
   */
  normalizeAllocationWeightings(
    input: AllocationWeight[] | null | undefined,
  ): AllocationWeight[] | null {
    return this.normalizeWeightings(input, normalizeCountryName);
  }

  /**
   * Same cleaning as `normalizeAllocationWeightings`, for the manual asset-class
   * breakdown. Asset classes have no canonical vocabulary, so names are only
   * trimmed/whitespace-collapsed (never snapped to a list); duplicates that
   * differ only by case are summed under the first spelling seen.
   */
  normalizeAssetWeightings(
    input: AllocationWeight[] | null | undefined,
  ): AllocationWeight[] | null {
    return this.normalizeWeightings(input, normalizeAssetName);
  }

  /**
   * Shared cleaning for a manual {name, weight} breakdown. `normalizeName`
   * decides how far a raw name is tidied (canonical country vs free-text asset
   * class); everything else -- de-duping, clamping, dropping the "Other"
   * bucket, the over-100% guard and the weight-descending sort -- is common.
   */
  private normalizeWeightings(
    input: AllocationWeight[] | null | undefined,
    normalizeName: (name: string) => string,
  ): AllocationWeight[] | null {
    if (!input || input.length === 0) return null;

    // Keyed case-insensitively so "equity" and "Equity" are one slice; the
    // first spelling seen is the one stored.
    const byKey = new Map<string, { name: string; weight: number }>();
    for (const slice of input) {
      const name = normalizeName(slice?.name ?? "");
      // A provider-supplied "Other" bucket is not a real slice: drop it so its
      // weight falls into the computed (100 - sum) remainder instead.
      if (!name || isOtherAllocationName(name)) continue;
      const weight = Number(slice?.weight);
      if (!Number.isFinite(weight) || weight <= 0) continue;
      const clamped = Math.min(weight, 1);
      const key = name.toLowerCase();
      const existing = byKey.get(key);
      byKey.set(key, {
        name: existing?.name ?? name,
        weight: (existing?.weight ?? 0) + clamped,
      });
    }

    if (byKey.size === 0) return null;

    const total = [...byKey.values()].reduce((sum, s) => sum + s.weight, 0);
    if (total > 1.0001) {
      throw new BadRequestException(
        tr(
          "errors.securities.allocationExceedsTotal",
          "Allocation percentages add up to more than 100%.",
        ),
      );
    }

    return [...byKey.values()]
      .map(({ name, weight }) => ({
        name,
        weight: Math.round(weight * 10000) / 10000,
      }))
      .sort((a, b) => b.weight - a.weight);
  }

  /**
   * The country names offered by the manual ETF/fund allocation picker for this
   * user: the canonical `COUNTRY_OPTIONS` list plus any custom countries the
   * user has already saved on a security (so a country added once is available
   * for every other security). Sorted alphabetically, with the user's
   * base-currency country floated to the top when it maps to a known country.
   */
  async getCountryOptions(userId: string): Promise<string[]> {
    const pref = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(UserPreference).findOne({
        where: { userId },
      }),
    );
    const baseCountry = countryForCurrency(pref?.defaultCurrency);

    // Distinct country names already stored in this user's manual breakdowns.
    const rows: { name: string | null }[] = await withScopedDb(
      this.dataSource,
      (m) =>
        m
          .getRepository(Security)
          .createQueryBuilder("s")
          .select(
            "DISTINCT jsonb_array_elements(s.country_weightings)->>'name'",
            "name",
          )
          .where("s.user_id = :userId", { userId })
          .andWhere("s.country_weightings IS NOT NULL")
          .getRawMany(),
    );

    const seen = new Set<string>(COUNTRY_OPTIONS.map((c) => c.toLowerCase()));
    const custom: string[] = [];
    for (const row of rows) {
      const name = normalizeCountryName(row.name ?? "");
      if (!name || isOtherAllocationName(name)) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      custom.push(name);
    }

    const sorted = [...COUNTRY_OPTIONS, ...custom].sort((a, b) =>
      a.localeCompare(b),
    );

    // Float the base-currency country to the top, keeping the rest alphabetical.
    if (
      baseCountry &&
      sorted.some((c) => c.toLowerCase() === baseCountry.toLowerCase())
    ) {
      return [
        baseCountry,
        ...sorted.filter((c) => c.toLowerCase() !== baseCountry.toLowerCase()),
      ];
    }
    return sorted;
  }

  /**
   * The asset-class names offered by the manual ETF/fund allocation picker for
   * this user. Unlike countries there is no canonical vocabulary: the list is
   * exactly what the user has already saved on their own securities, so a class
   * entered once is available for every other security. Sorted alphabetically.
   */
  async getAssetOptions(userId: string): Promise<string[]> {
    const rows: { name: string | null }[] = await withScopedDb(
      this.dataSource,
      (m) =>
        m
          .getRepository(Security)
          .createQueryBuilder("s")
          .select(
            "DISTINCT jsonb_array_elements(s.asset_weightings)->>'name'",
            "name",
          )
          .where("s.user_id = :userId", { userId })
          .andWhere("s.asset_weightings IS NOT NULL")
          .getRawMany(),
    );

    const seen = new Set<string>();
    const names: string[] = [];
    for (const row of rows) {
      const name = normalizeAssetName(row.name ?? "");
      if (!name || isOtherAllocationName(name)) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(name);
    }

    return names.sort((a, b) => a.localeCompare(b));
  }

  /**
   * Drop an asset class from the user's picker list by removing its slice from
   * every security that uses it. Nothing is re-apportioned: the freed weight
   * simply becomes part of each security's computed (100 - sum) "Other"
   * remainder, which is how a sub-100% breakdown already renders. Returns how
   * many securities were touched.
   */
  async deleteAssetOption(
    userId: string,
    rawName: string,
  ): Promise<{ name: string; removedFrom: number }> {
    const name = normalizeAssetName(rawName);
    if (!name) {
      throw new BadRequestException(
        tr(
          "errors.securities.assetOptionNameRequired",
          "An asset class name is required.",
        ),
      );
    }
    const key = name.toLowerCase();

    const removedFrom = await withScopedDb(this.dataSource, async (m) => {
      const repo = m.getRepository(Security);
      const securities = await repo
        .createQueryBuilder("s")
        .where("s.user_id = :userId", { userId })
        .andWhere("s.asset_weightings IS NOT NULL")
        .getMany();

      let touched = 0;
      for (const security of securities) {
        const remaining = (security.assetWeightings ?? []).filter(
          (slice) =>
            normalizeAssetName(slice?.name ?? "").toLowerCase() !== key,
        );
        if (remaining.length === (security.assetWeightings ?? []).length) {
          continue;
        }
        await repo.update(
          { id: security.id, userId },
          { assetWeightings: remaining.length > 0 ? remaining : null },
        );
        touched += 1;
      }
      return touched;
    });

    return { name, removedFrom };
  }

  /** Shared with institutions and payees; see `common/normalize-website`. */
  private normalizeWebsite(
    value: string | null | undefined,
  ): string | null | undefined {
    return normalizeWebsite(value);
  }

  async create(
    userId: string,
    createSecurityDto: CreateSecurityDto,
  ): Promise<Security> {
    // tagIds is a relation, not a column on securities -- pull it out so the
    // spread that builds the entity never tries to persist it as a field.
    const { tagIds, countryWeightings, assetWeightings, ...securityData } =
      createSecurityDto;

    // Both address fields are rendered as links, so they are stored absolute.
    if ("website" in securityData) {
      securityData.website = this.normalizeWebsite(securityData.website);
    }
    if ("irWebsite" in securityData) {
      securityData.irWebsite = this.normalizeWebsite(securityData.irWebsite);
    }

    const saved = await withScopedDb(this.dataSource, async (m) => {
      // Check if symbol already exists for this user
      const existing = await m.findOne(Security, {
        where: { symbol: securityData.symbol, userId },
      });

      if (existing) {
        throw new ConflictException(
          tr(
            "errors.securities.symbolAlreadyExists",
            `Security with symbol ${securityData.symbol} already exists`,
            { symbol: securityData.symbol },
          ),
        );
      }

      const security = m.create(Security, {
        ...securityData,
        countryWeightings:
          this.normalizeAllocationWeightings(countryWeightings),
        assetWeightings: this.normalizeAssetWeightings(assetWeightings),
        userId,
      });
      const persisted = await m.save(security);

      if (tagIds && tagIds.length > 0) {
        await this.setSecurityTags(persisted.id, tagIds, userId, m);
      }

      return persisted;
    });

    // Fire-and-forget: backfill 1Y of daily prices for the new security
    this.securityPriceService.backfillSecurity(saved).catch((err) => {
      this.logger.warn(
        `Background price backfill failed for ${saved.symbol}: ${err.message}`,
      );
    });

    this.actionHistoryService.record(userId, {
      entityType: "security",
      entityId: saved.id,
      action: "create",
      afterData: { ...saved },
      description: `Created security "${saved.symbol}"`,
      descriptionKey: "createdSecurity",
      descriptionParams: { symbol: saved.symbol },
    });

    return saved;
  }

  async findAll(
    userId: string,
    includeInactive: boolean = false,
  ): Promise<Array<Security & { lastPriceSource: string | null }>> {
    const where: Record<string, unknown> = { userId };
    if (!includeInactive) {
      where.isActive = true;
    }
    const securities = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Security).find({
        where,
        relations: ["tags"],
        order: { symbol: "ASC" },
      }),
    );
    return this.attachLastPriceSource(securities);
  }

  /**
   * Decorate each security with the `source` from its most recent price row
   * (via a single grouped query for efficiency). Returns null when the
   * security has no prices yet.
   */
  private async attachLastPriceSource(
    securities: Security[],
  ): Promise<Array<Security & { lastPriceSource: string | null }>> {
    if (securities.length === 0) return [];
    const ids = securities.map((s) => s.id);
    const rows: Array<{ security_id: string; source: string | null }> =
      await withScopedDb(this.dataSource, (m) =>
        m.query(
          `SELECT DISTINCT ON (security_id) security_id, source
         FROM security_prices
         WHERE security_id = ANY($1::uuid[])
         ORDER BY security_id, price_date DESC, created_at DESC`,
          [ids],
        ),
      );
    const sourceById = new Map(rows.map((r) => [r.security_id, r.source]));
    return securities.map((s) => ({
      ...s,
      lastPriceSource: sourceById.get(s.id) ?? null,
    }));
  }

  async findOne(userId: string, id: string): Promise<Security> {
    const security = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Security).findOne({
        where: { id, userId },
        relations: ["tags"],
      }),
    );
    if (!security) {
      throw new NotFoundException(
        tr(
          "errors.securities.notFoundById",
          `Security with ID ${id} not found`,
          { id },
        ),
      );
    }
    return security;
  }

  async findBySymbol(userId: string, symbol: string): Promise<Security> {
    const security = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Security).findOne({
        where: { symbol, userId },
      }),
    );
    if (!security) {
      throw new NotFoundException(
        tr(
          "errors.securities.notFoundBySymbol",
          `Security with symbol ${symbol} not found`,
          { symbol },
        ),
      );
    }
    return security;
  }

  async update(
    userId: string,
    id: string,
    updateSecurityDto: UpdateSecurityDto,
  ): Promise<Security> {
    const security = await this.findOne(userId, id);
    const beforeData = { ...security };

    // Same normalisation as on create, and `""` clears the field.
    if ("website" in updateSecurityDto) {
      updateSecurityDto.website = this.normalizeWebsite(
        updateSecurityDto.website,
      );
    }
    if ("irWebsite" in updateSecurityDto) {
      updateSecurityDto.irWebsite = this.normalizeWebsite(
        updateSecurityDto.irWebsite,
      );
    }

    // Check for symbol conflicts if updating symbol
    if (
      updateSecurityDto.symbol &&
      updateSecurityDto.symbol !== security.symbol
    ) {
      const existing = await withScopedDb(this.dataSource, (m) =>
        m.getRepository(Security).findOne({
          where: { symbol: updateSecurityDto.symbol, userId },
        }),
      );
      if (existing) {
        throw new ConflictException(
          tr(
            "errors.securities.symbolAlreadyExists",
            `Security with symbol ${updateSecurityDto.symbol} already exists`,
            { symbol: updateSecurityDto.symbol },
          ),
        );
      }
    }

    // SECURITY: Explicit property mapping instead of Object.assign to prevent mass assignment
    if (updateSecurityDto.symbol !== undefined)
      security.symbol = updateSecurityDto.symbol;
    if (updateSecurityDto.name !== undefined)
      security.name = updateSecurityDto.name;
    if (updateSecurityDto.securityType !== undefined)
      security.securityType = updateSecurityDto.securityType;
    if (updateSecurityDto.exchange !== undefined)
      security.exchange = updateSecurityDto.exchange;
    if (updateSecurityDto.currencyCode !== undefined)
      security.currencyCode = updateSecurityDto.currencyCode;
    if (updateSecurityDto.description !== undefined)
      security.description = updateSecurityDto.description ?? null;
    // Both addresses were normalised above ("" -> null, bare domain -> https).
    // They must be copied onto the entity here like every other scalar: this
    // block replaces Object.assign, so a field it omits is silently dropped and
    // the edit never persists -- which is exactly what happened to these two.
    if (updateSecurityDto.website !== undefined)
      security.website = updateSecurityDto.website ?? null;
    if (updateSecurityDto.irWebsite !== undefined)
      security.irWebsite = updateSecurityDto.irWebsite ?? null;
    if (updateSecurityDto.isActive !== undefined)
      security.isActive = updateSecurityDto.isActive;
    if (updateSecurityDto.isFavourite !== undefined)
      security.isFavourite = updateSecurityDto.isFavourite;
    if (updateSecurityDto.quoteProvider !== undefined)
      security.quoteProvider = updateSecurityDto.quoteProvider ?? null;
    if (updateSecurityDto.msnInstrumentId !== undefined)
      security.msnInstrumentId = updateSecurityDto.msnInstrumentId ?? null;
    if (updateSecurityDto.countryWeightings !== undefined)
      security.countryWeightings = this.normalizeAllocationWeightings(
        updateSecurityDto.countryWeightings,
      );
    if (updateSecurityDto.assetWeightings !== undefined)
      security.assetWeightings = this.normalizeAssetWeightings(
        updateSecurityDto.assetWeightings,
      );

    // The user explicitly opted into a quote source — auto-clear the
    // skipPriceUpdates flag that QIF/OFX import sets on auto-generated
    // symbols so refresh actually picks them up afterwards.
    if (security.quoteProvider || security.msnInstrumentId) {
      security.skipPriceUpdates = false;
    }

    // Persist the scalar fields and the tag set together so a security and its
    // classification never drift apart on a partial failure.
    await withScopedDb(this.dataSource, async (m) => {
      // The relation is loaded onto `security`; strip it before save so
      // TypeORM does not try to cascade-write the join table itself.
      const { tags: _tags, ...scalars } = security;
      await m.save(Security, scalars);
      if (updateSecurityDto.tagIds !== undefined) {
        await this.setSecurityTags(id, updateSecurityDto.tagIds, userId, m);
      }
    });

    const saved = await this.findOne(userId, id);

    this.actionHistoryService.record(userId, {
      entityType: "security",
      entityId: id,
      action: "update",
      beforeData,
      afterData: { ...saved },
      description: `Updated security "${saved.symbol}"`,
      descriptionKey: "updatedSecurity",
      descriptionParams: { symbol: saved.symbol },
    });

    return saved;
  }

  async deactivate(userId: string, id: string): Promise<Security> {
    const security = await this.findOne(userId, id);

    // Check if security has any holdings with non-zero quantity
    // Using ABS() to handle potential small negative values from rounding
    const holdingsCount = await withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(Holding)
        .createQueryBuilder("holding")
        .leftJoin("holding.account", "account")
        .where("holding.securityId = :securityId", { securityId: id })
        .andWhere("account.userId = :userId", { userId })
        .andWhere("ABS(holding.quantity) > :threshold", {
          threshold: 0.00000001,
        })
        .getCount(),
    );

    if (holdingsCount > 0) {
      throw new ForbiddenException(
        tr(
          "errors.securities.cannotDeactivateWithHoldings",
          "Cannot deactivate security with active holdings. Please sell all shares first.",
        ),
      );
    }

    security.isActive = false;
    return withScopedDb(this.dataSource, (m) =>
      m.getRepository(Security).save(security),
    );
  }

  async activate(userId: string, id: string): Promise<Security> {
    const security = await this.findOne(userId, id);
    security.isActive = true;
    return withScopedDb(this.dataSource, (m) =>
      m.getRepository(Security).save(security),
    );
  }

  async remove(userId: string, id: string): Promise<void> {
    const security = await this.findOne(userId, id);

    // Check for any holdings with non-zero quantity
    // Using ABS() to handle potential small negative values from rounding
    const holdingsCount = await withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(Holding)
        .createQueryBuilder("holding")
        .leftJoin("holding.account", "account")
        .where("holding.securityId = :securityId", { securityId: id })
        .andWhere("account.userId = :userId", { userId })
        .andWhere("ABS(holding.quantity) > :threshold", {
          threshold: 0.00000001,
        })
        .getCount(),
    );

    if (holdingsCount > 0) {
      throw new ForbiddenException(
        tr(
          "errors.securities.cannotDeleteWithHoldings",
          "Cannot delete security that has holdings. Remove all holdings first.",
        ),
      );
    }

    // Check for any investment transactions referencing this security
    // includes VOID rows: records read -- a VOID row still references the
    // security and would be orphaned by the delete.
    const transactionsCount = await withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(InvestmentTransaction)
        .createQueryBuilder("tx")
        .where("tx.securityId = :securityId", { securityId: id })
        .andWhere("tx.userId = :userId", { userId })
        .getCount(),
    );

    if (transactionsCount > 0) {
      throw new ForbiddenException(
        tr(
          "errors.securities.cannotDeleteWithTransactions",
          "Cannot delete security that has investment transactions. Delete all related transactions first.",
        ),
      );
    }

    // Clean up any zero-quantity holding records before deleting the security,
    // then delete the security itself -- one transaction so a failure can never
    // strand the holdings without their security.
    const beforeData = { ...security };
    await withScopedDb(this.dataSource, async (m) => {
      const holdingsRepo = m.getRepository(Holding);
      const zeroHoldings = await holdingsRepo
        .createQueryBuilder("holding")
        .leftJoin("holding.account", "account")
        .where("holding.securityId = :securityId", { securityId: id })
        .andWhere("account.userId = :userId", { userId })
        .getMany();
      if (zeroHoldings.length > 0) {
        await holdingsRepo.remove(zeroHoldings);
      }

      // Security prices cascade-delete via FK constraint
      await m.getRepository(Security).remove(security);
    });

    this.actionHistoryService.record(userId, {
      entityType: "security",
      entityId: beforeData.id,
      action: "delete",
      beforeData,
      description: `Deleted security "${beforeData.symbol}"`,
      descriptionKey: "deletedSecurity",
      descriptionParams: { symbol: beforeData.symbol },
    });
  }

  /**
   * Favourite securities for the dashboard widget, decorated with their latest
   * price and the day-over-day change. Favourites are independent of holdings
   * (a user can pin a security they don't own), so this is keyed off the
   * is_favourite flag rather than the holdings table. Securities with fewer
   * than two price points report a zero daily change.
   */
  async getFavouriteSecurities(
    userId: string,
  ): Promise<FavouriteSecurityQuote[]> {
    const securities = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Security).find({
        where: { userId, isFavourite: true, isActive: true },
        order: { symbol: "ASC" },
      }),
    );
    if (securities.length === 0) return [];

    const ids = securities.map((s) => s.id);
    // Two most recent prices per security in a single pass.
    const priceRows: Array<{
      security_id: string;
      close_price: string;
      rn: string;
    }> = await withScopedDb(this.dataSource, (m) =>
      m.query(
        `SELECT security_id, close_price, rn FROM (
         SELECT security_id, close_price,
                ROW_NUMBER() OVER (PARTITION BY security_id ORDER BY price_date DESC) as rn
         FROM security_prices
         WHERE security_id = ANY($1::uuid[])
       ) sub
       WHERE rn <= 2
       ORDER BY security_id, rn`,
        [ids],
      ),
    );

    const priceMap = new Map<string, number[]>();
    for (const row of priceRows) {
      const existing = priceMap.get(row.security_id) || [];
      existing.push(Number(row.close_price));
      priceMap.set(row.security_id, existing);
    }

    return securities.map((s) => {
      const prices = priceMap.get(s.id) || [];
      const currentPrice = prices[0] ?? null;
      const previousPrice = prices[1] ?? null;
      let dailyChange = 0;
      let dailyChangePercent = 0;
      if (
        currentPrice != null &&
        previousPrice != null &&
        previousPrice !== 0
      ) {
        dailyChange = currentPrice - previousPrice;
        dailyChangePercent = (dailyChange / previousPrice) * 100;
      }
      return {
        securityId: s.id,
        symbol: s.symbol,
        name: s.name,
        currencyCode: s.currencyCode,
        currentPrice,
        previousPrice,
        dailyChange,
        dailyChangePercent,
      };
    });
  }

  async getSecurityIdsWithTransactions(userId: string): Promise<string[]> {
    // includes VOID rows: records read -- "referenced anywhere", not an effect.
    const results = await withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(InvestmentTransaction)
        .createQueryBuilder("tx")
        .select("DISTINCT tx.securityId", "securityId")
        .where("tx.userId = :userId", { userId })
        .andWhere("tx.securityId IS NOT NULL")
        .getRawMany(),
    );

    return results.map((r) => r.securityId);
  }

  async search(userId: string, query: string): Promise<Security[]> {
    return withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(Security)
        .createQueryBuilder("security")
        .where("security.userId = :userId", { userId })
        .andWhere("security.isActive = :isActive", { isActive: true })
        .andWhere(
          "(LOWER(security.symbol) LIKE LOWER(:query) OR LOWER(security.name) LIKE LOWER(:query))",
          { query: `%${query}%` },
        )
        .orderBy("security.symbol", "ASC")
        .take(20)
        .getMany(),
    );
  }

  /**
   * Resolve a free-text security reference (a ticker symbol or a security name)
   * to a single owned security. Matching is layered so common references
   * resolve unambiguously while a vague substring that hits several securities
   * is reported back as candidates rather than guessed:
   *   1. Exact symbol (case-insensitive). Symbols are unique per user, so this
   *      yields at most one match.
   *   2. Exact name (case-insensitive). Names are not guaranteed unique;
   *      multiple hits become candidates.
   *   3. Substring on symbol or name among active securities -- a single hit
   *      wins, multiple become candidates, none resolves to no match.
   *
   * Shared by the AI Assistant `create_investment_transaction` tool and the MCP
   * server so both surfaces match securities identically.
   */
  async resolveBySymbolOrName(
    userId: string,
    query: string,
  ): Promise<SecurityMatchResult> {
    const trimmed = (query ?? "").trim();
    if (!trimmed) {
      return { match: null, candidates: [] };
    }

    const bySymbol = await withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(Security)
        .createQueryBuilder("security")
        .where("security.userId = :userId", { userId })
        .andWhere("LOWER(security.symbol) = LOWER(:q)", { q: trimmed })
        .getOne(),
    );
    if (bySymbol) {
      return { match: bySymbol, candidates: [] };
    }

    const byName = await withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(Security)
        .createQueryBuilder("security")
        .where("security.userId = :userId", { userId })
        .andWhere("LOWER(security.name) = LOWER(:q)", { q: trimmed })
        // Prefer an active security when several share a name (e.g. a delisted
        // duplicate); fall back to the symbol for a stable order.
        .orderBy("security.isActive", "DESC")
        .addOrderBy("security.symbol", "ASC")
        .getMany(),
    );
    if (byName.length === 1) {
      return { match: byName[0], candidates: [] };
    }
    if (byName.length > 1) {
      return { match: null, candidates: byName };
    }

    const partial = await withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(Security)
        .createQueryBuilder("security")
        .where("security.userId = :userId", { userId })
        .andWhere("security.isActive = :isActive", { isActive: true })
        .andWhere(
          "(LOWER(security.symbol) LIKE LOWER(:like) OR LOWER(security.name) LIKE LOWER(:like))",
          { like: `%${trimmed}%` },
        )
        .orderBy("security.symbol", "ASC")
        .take(10)
        .getMany(),
    );
    if (partial.length === 1) {
      return { match: partial[0], candidates: [] };
    }
    return { match: null, candidates: partial };
  }

  /**
   * Resolve an existing security by symbol or name for an edit/delete, throwing
   * a clear error when nothing matches or the reference is ambiguous. Used by
   * the manage_securities confirmation flow.
   */
  private async resolveSecurityForManage(
    userId: string,
    query: string,
  ): Promise<Security> {
    const { match, candidates } = await this.resolveBySymbolOrName(
      userId,
      query,
    );
    if (match) {
      return match;
    }
    if (candidates.length > 1) {
      throw new BadRequestException(
        tr(
          "errors.securities.ambiguousSecurity",
          `"${query}" matches multiple securities: ${candidates
            .map((c) => c.symbol)
            .join(", ")}. Use the exact ticker symbol.`,
          { query, list: candidates.map((c) => c.symbol).join(", ") },
        ),
      );
    }
    throw new NotFoundException(
      tr(
        "errors.securities.securityNotFoundByQuery",
        `No security matches "${query}". Add the security first or check the ticker symbol.`,
        { query },
      ),
    );
  }

  /**
   * Validate + resolve a proposed security edit WITHOUT persisting. Resolves the
   * target security by symbol/name and merges the supplied classification/
   * display fields over its current values.
   */
  async previewUpdateSecurity(
    userId: string,
    input: {
      query: string;
      securityType?: string | null;
      exchange?: string | null;
      currencyCode?: string;
      isFavourite?: boolean;
      countryWeightings?: AllocationWeight[];
      assetWeightings?: AllocationWeight[];
    },
  ): Promise<UpdateSecurityPreview> {
    const security = await this.resolveSecurityForManage(userId, input.query);
    return {
      securityId: security.id,
      symbol: security.symbol,
      name: security.name,
      securityType:
        input.securityType !== undefined
          ? input.securityType
          : (security.securityType ?? null),
      exchange:
        input.exchange !== undefined
          ? input.exchange
          : (security.exchange ?? null),
      currencyCode: input.currencyCode ?? security.currencyCode,
      isFavourite: input.isFavourite ?? security.isFavourite,
      countryWeightings:
        input.countryWeightings !== undefined
          ? this.normalizeAllocationWeightings(input.countryWeightings)
          : (security.countryWeightings ?? null),
      assetWeightings:
        input.assetWeightings !== undefined
          ? this.normalizeAssetWeightings(input.assetWeightings)
          : (security.assetWeightings ?? null),
    };
  }

  /** Validate + resolve a proposed security deletion (by symbol/name). */
  async previewDeleteSecurity(
    userId: string,
    input: { query: string },
  ): Promise<DeleteSecurityPreview> {
    const security = await this.resolveSecurityForManage(userId, input.query);
    return {
      securityId: security.id,
      symbol: security.symbol,
      name: security.name,
    };
  }

  /**
   * Resolve and validate a new security from a free-text reference (ticker
   * symbol or name) via the user's configured quote provider, returning the
   * fully-populated values a confirmation card / signed descriptor needs. Does
   * not persist anything.
   *
   * Shared by the AI Assistant `create_security` tool and the MCP server so both
   * surfaces look securities up, validate, and pre-fill them identically:
   *   - The provider lookup supplies symbol, name, exchange, security type, and
   *     currency so the AI never guesses them. An `exchange` (used to
   *     disambiguate the lookup) or `securityType` the caller passes -- both
   *     constrained to the known lists -- overrides the looked-up value.
   *   - When the reference matches several distinct tickers and no exchange was
   *     given, it throws a 4xx listing the candidates so the caller can re-run
   *     with an exchange rather than picking one blindly.
   *   - The per-user unique `(userId, symbol)` constraint is checked up front so
   *     a duplicate fails at preview with the same message the real write uses.
   */
  async previewCreateSecurity(
    userId: string,
    input: {
      query: string;
      exchange?: string;
      securityType?: string;
      isFavourite?: boolean;
      /**
       * Override the looked-up currency. Takes precedence over the provider's
       * value, and lets creation proceed when the lookup can't determine one.
       */
      currencyCode?: string;
    },
  ): Promise<CreateSecurityPreview> {
    const query = (input.query ?? "").trim();
    if (!query) {
      throw new BadRequestException(
        tr(
          "errors.securities.lookupQueryRequired",
          "Provide a ticker symbol or security name to look up.",
        ),
      );
    }

    const candidates: SecurityLookupResult[] =
      await this.securityPriceService.lookupSecurityCandidates(
        userId,
        query,
        input.exchange ? [input.exchange] : undefined,
      );

    if (candidates.length === 0) {
      throw new BadRequestException(
        tr(
          "errors.securities.lookupNotFound",
          `No security found matching "${query}". Check the symbol or name, or specify an exchange.`,
          { query },
        ),
      );
    }

    // Without an explicit exchange, a reference that resolves to several
    // different tickers is ambiguous -- surface the options instead of guessing.
    const distinctSymbols = new Set(
      candidates.map((c) => c.symbol.toUpperCase()),
    );
    if (!input.exchange && distinctSymbols.size > 1) {
      const list = candidates
        .slice(0, 5)
        .map(
          (c) =>
            `${c.symbol} (${c.name}${c.exchange ? `, ${c.exchange}` : ""})`,
        )
        .join("; ");
      throw new BadRequestException(
        tr(
          "errors.securities.lookupAmbiguous",
          `"${query}" matches multiple securities: ${list}. Re-run specifying an exchange.`,
          { query, list },
        ),
      );
    }

    const lookup = candidates[0];

    // Currency precedence: the instrument's live-quote currency is
    // authoritative (the lookup guesses from the exchange, which is wrong for
    // non-local-currency listings such as a USD/EUR ETF on the LSE); an
    // explicit override is the fallback that also rescues a lookup the provider
    // can't price; the exchange-derived guess is the last resort.
    let currencyCode =
      input.currencyCode?.trim() || lookup.currencyCode?.trim();
    const authoritativeCurrency =
      await this.securityPriceService.fetchAuthoritativeCurrency(
        userId,
        lookup.symbol,
        lookup.exchange,
      );
    if (authoritativeCurrency) {
      currencyCode = authoritativeCurrency;
    }
    if (!currencyCode) {
      throw new BadRequestException(
        tr(
          "errors.securities.lookupNoCurrency",
          `Could not determine the currency for "${lookup.symbol}". Add the security manually instead.`,
          { symbol: lookup.symbol },
        ),
      );
    }

    // Enforce the per-user unique symbol up front so a duplicate is reported at
    // preview time with the same message the REST/confirm write would throw.
    const existing = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Security).findOne({
        where: { symbol: lookup.symbol, userId },
      }),
    );
    if (existing) {
      throw new ConflictException(
        tr(
          "errors.securities.symbolAlreadyExists",
          `Security with symbol ${lookup.symbol} already exists`,
          { symbol: lookup.symbol },
        ),
      );
    }

    return {
      symbol: lookup.symbol,
      name: lookup.name,
      securityType: input.securityType ?? lookup.securityType ?? null,
      exchange: input.exchange ?? lookup.exchange ?? null,
      currencyCode: currencyCode.toUpperCase(),
      isFavourite: input.isFavourite ?? false,
      quoteProvider: lookup.provider ?? null,
      msnInstrumentId: lookup.msnInstrumentId ?? null,
    };
  }

  /**
   * Look up a ticker symbol or company name against the user's configured quote
   * provider (Yahoo/MSN) and return every plausible match so an AI agent can
   * help the user pick the right one before adding it. Read-only: it neither
   * persists anything nor enforces the unique-symbol rule. Each candidate is
   * flagged when a security with that symbol is already in the user's list.
   * Shared by the AI Assistant `lookup_securities` tool and the MCP tool.
   */
  async lookupSecuritiesForLlm(
    userId: string,
    input: {
      query: string;
      exchange?: string;
      provider?: "yahoo" | "msn" | "auto";
    },
  ): Promise<LlmSecurityLookup> {
    const query = (input.query ?? "").trim();
    if (!query) {
      throw new BadRequestException(
        tr(
          "errors.securities.lookupQueryRequired",
          "Provide a ticker symbol or security name to look up.",
        ),
      );
    }

    const results = await this.securityPriceService.lookupSecurityCandidates(
      userId,
      query,
      input.exchange ? [input.exchange] : undefined,
      input.provider,
    );

    const owned = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Security).find({
        where: { userId },
        select: ["symbol"],
      }),
    );
    const ownedSymbols = new Set(owned.map((s) => s.symbol.toUpperCase()));

    const candidates: LlmSecurityLookupCandidate[] = results.map((r) => ({
      symbol: r.symbol,
      name: r.name,
      exchange: r.exchange ?? null,
      securityType: r.securityType ?? null,
      currencyCode: r.currencyCode ?? null,
      provider: r.provider ?? null,
      alreadyAdded: ownedSymbols.has(r.symbol.toUpperCase()),
    }));

    return { query, count: candidates.length, candidates };
  }

  /**
   * Replace the tag set on a security with `tagIds`, mirroring
   * `TagsService.setTransactionTags`. Validates every tag belongs to the user,
   * then clears and re-inserts the join rows. Pass a `queryRunner` to enlist in
   * a caller's transaction (security create/update do this so the security and
   * its tags commit atomically).
   */
  async setSecurityTags(
    securityId: string,
    tagIds: string[],
    userId: string,
    manager?: EntityManager,
  ): Promise<void> {
    const apply = async (m: EntityManager): Promise<void> => {
      if (tagIds.length > 0) {
        const tags = await m.find(Tag, {
          where: { id: In(tagIds), userId },
        });
        if (tags.length !== tagIds.length) {
          throw new NotFoundException(
            tr("errors.tags.oneOrMoreNotFound", "One or more tags not found"),
          );
        }
      }

      await m.delete(SecurityTag, { securityId });

      if (tagIds.length > 0) {
        const newTags = tagIds.map((tagId) =>
          m.create(SecurityTag, { securityId, tagId }),
        );
        await m.save(SecurityTag, newTags);
      }
    };
    return manager ? apply(manager) : withScopedDb(this.dataSource, apply);
  }

  /**
   * All of the user's securities carrying a given tag, ordered by symbol.
   * Mirrors the per-user scoping of the rest of the service.
   */
  async findByTag(userId: string, tagId: string): Promise<Security[]> {
    return withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(Security)
        .createQueryBuilder("security")
        .innerJoin(
          SecurityTag,
          "st",
          "st.security_id = security.id AND st.tag_id = :tagId",
          { tagId },
        )
        .where("security.userId = :userId", { userId })
        .orderBy("security.symbol", "ASC")
        .getMany(),
    );
  }
}
