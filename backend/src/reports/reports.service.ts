import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { tr } from "../i18n/translate";
import { Brackets, DataSource, Repository } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import {
  brokerageExclusionForEntity,
  investmentLinkedTransactionExclusion,
  ordinarySplitLines,
  reportableTransactionAmount,
} from "../common/investment-filter.util";
import {
  CustomReport,
  TimeframeType,
  GroupByType,
  MetricType,
  DirectionFilter,
  ReportConfig,
  ReportFilters,
  TableColumn,
  SortDirection,
} from "./entities/custom-report.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { Category } from "../categories/entities/category.entity";
import { Payee } from "../payees/entities/payee.entity";
import { CreateCustomReportDto } from "./dto/create-custom-report.dto";
import { UpdateCustomReportDto } from "./dto/update-custom-report.dto";
import {
  ExecuteReportDto,
  ReportResult,
  AggregatedDataPoint,
  ReportSummary,
} from "./dto/execute-report.dto";
import { roundMoney, sumMoney } from "../common/round.util";
import { transferPayeeLabel } from "../transactions/transfer-payee-label.util";
import { BudgetsService } from "../budgets/budgets.service";
import { ActionHistoryService } from "../action-history/action-history.service";
import {
  subDays,
  subMonths,
  subYears,
  startOfYear,
  endOfYear,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  startOfDay,
  format,
  parseISO,
} from "date-fns";

@Injectable()
export class ReportsService {
  constructor(
    private dataSource: DataSource,
    private budgetsService: BudgetsService,
    private actionHistoryService: ActionHistoryService,
  ) {}

  async create(
    userId: string,
    dto: CreateCustomReportDto,
  ): Promise<CustomReport> {
    this.validateCustomTimeframe(dto.timeframeType, dto.config);

    // Set default config values if not provided
    const config: ReportConfig = {
      metric: dto.config?.metric || MetricType.TOTAL_AMOUNT,
      includeTransfers: dto.config?.includeTransfers ?? false,
      direction: dto.config?.direction || DirectionFilter.EXPENSES_ONLY,
      customStartDate: dto.config?.customStartDate,
      customEndDate: dto.config?.customEndDate,
      tableColumns: dto.config?.tableColumns,
      sortBy: dto.config?.sortBy,
      sortDirection: dto.config?.sortDirection,
    };

    const saved = await withScopedDb(this.dataSource, (m) => {
      const repo = m.getRepository(CustomReport);
      const report = repo.create({
        ...dto,
        userId,
        config,
        filters: dto.filters || {},
      });
      return repo.save(report);
    });

    this.actionHistoryService.record(userId, {
      entityType: "custom_report",
      entityId: saved.id,
      action: "create",
      afterData: { ...saved },
      description: `Created report "${saved.name}"`,
      descriptionKey: "createdReport",
      descriptionParams: { name: saved.name },
    });

    return saved;
  }

  async findAll(userId: string): Promise<CustomReport[]> {
    return withScopedDb(this.dataSource, (m) =>
      m.getRepository(CustomReport).find({
        where: { userId },
        order: { sortOrder: "ASC", createdAt: "DESC" },
      }),
    );
  }

  async findOne(userId: string, id: string): Promise<CustomReport> {
    const report = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(CustomReport).findOne({
        where: { id, userId },
      }),
    );

    if (!report) {
      throw new NotFoundException(
        tr("errors.reports.notFound", `Report with ID ${id} not found`, { id }),
      );
    }

    return report;
  }

  async update(
    userId: string,
    id: string,
    dto: UpdateCustomReportDto,
  ): Promise<CustomReport> {
    const report = await this.findOne(userId, id);
    const beforeData = { ...report };

    // Validate custom timeframe using the effective values after merge
    const effectiveTimeframe = dto.timeframeType ?? report.timeframeType;
    const effectiveConfig = dto.config
      ? { ...report.config, ...dto.config }
      : report.config;
    this.validateCustomTimeframe(effectiveTimeframe, effectiveConfig);

    // SECURITY: Explicit property mapping instead of Object.assign to prevent mass assignment
    if (dto.name !== undefined) report.name = dto.name;
    if (dto.description !== undefined) report.description = dto.description;
    if (dto.icon !== undefined) report.icon = dto.icon;
    if (dto.backgroundColor !== undefined)
      report.backgroundColor = dto.backgroundColor;
    if (dto.viewType !== undefined) report.viewType = dto.viewType;
    if (dto.timeframeType !== undefined)
      report.timeframeType = dto.timeframeType;
    if (dto.groupBy !== undefined) report.groupBy = dto.groupBy;
    if (dto.isFavourite !== undefined) report.isFavourite = dto.isFavourite;
    if (dto.sortOrder !== undefined) report.sortOrder = dto.sortOrder;

    // Replace config if provided (full replacement so cleared fields take effect)
    if (dto.config) {
      report.config = { ...report.config, ...dto.config };
    }

    // Replace filters if provided (full replacement so cleared filters take effect)
    if (dto.filters) {
      report.filters = dto.filters as ReportFilters;
    }

    const saved = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(CustomReport).save(report),
    );

    this.actionHistoryService.record(userId, {
      entityType: "custom_report",
      entityId: id,
      action: "update",
      beforeData,
      afterData: { ...saved },
      description: `Updated report "${saved.name}"`,
      descriptionKey: "updatedReport",
      descriptionParams: { name: saved.name },
    });

    return saved;
  }

  async remove(userId: string, id: string): Promise<void> {
    const report = await this.findOne(userId, id);
    const beforeData = { ...report };
    await withScopedDb(this.dataSource, (m) =>
      m.getRepository(CustomReport).remove(report),
    );

    this.actionHistoryService.record(userId, {
      entityType: "custom_report",
      entityId: beforeData.id,
      action: "delete",
      beforeData,
      description: `Deleted report "${beforeData.name}"`,
      descriptionKey: "deletedReport",
      descriptionParams: { name: beforeData.name },
    });
  }

  async execute(
    userId: string,
    id: string,
    overrides?: ExecuteReportDto,
  ): Promise<ReportResult> {
    const report = await this.findOne(userId, id);

    // Use override timeframe if provided, otherwise use saved report timeframe
    const effectiveTimeframe = overrides?.timeframeType || report.timeframeType;

    // Calculate date range
    const {
      startDate,
      endDate,
      label: timeframeLabel,
    } = this.getDateRange(
      effectiveTimeframe,
      overrides?.startDate || report.config.customStartDate,
      overrides?.endDate || report.config.customEndDate,
    );

    // Query transactions with filters
    const selected = await this.getFilteredTransactions(
      userId,
      startDate,
      endDate,
      report.filters,
      report.config,
    );
    // A split parent reached the aggregators whatever its own sign, so its lines
    // are narrowed here, where each line's own amount and kind are readable.
    const transactions = this.narrowSplitLines(selected, report.config);

    // Only fetch category/payee maps when the report groups by them (avoid over-fetching)
    const categoryMap = new Map<string, Category>();
    const payeeMap = new Map<string, Payee>();

    if (report.groupBy === GroupByType.CATEGORY) {
      const categories = await withScopedDb(this.dataSource, (m) =>
        m.getRepository(Category).find({
          where: { userId },
        }),
      );
      for (const c of categories) categoryMap.set(c.id, c);
    } else if (report.groupBy === GroupByType.PAYEE) {
      const payees = await withScopedDb(this.dataSource, (m) =>
        m.getRepository(Payee).find({ where: { userId } }),
      );
      for (const p of payees) payeeMap.set(p.id, p);
    }

    // Aggregate data based on groupBy type
    let data = this.aggregateData(
      transactions,
      report.groupBy,
      report.config.metric,
      categoryMap,
      payeeMap,
    );

    // For BUDGET_VARIANCE metric with CATEGORY grouping, enrich with budget data
    if (
      report.config.metric === MetricType.BUDGET_VARIANCE &&
      report.groupBy === GroupByType.CATEGORY
    ) {
      data = await this.enrichWithBudgetVariance(userId, data);
    }

    // Apply custom sorting if configured
    if (report.config.sortBy) {
      data = this.sortData(
        data,
        report.config.sortBy,
        report.config.sortDirection || SortDirection.DESC,
      );
    }

    // Calculate summary
    const summary = this.calculateSummary(data);

    return {
      reportId: report.id,
      name: report.name,
      viewType: report.viewType,
      groupBy: report.groupBy,
      timeframe: {
        startDate,
        endDate,
        label: timeframeLabel,
      },
      data,
      summary,
      tableColumns: report.config.tableColumns,
    };
  }

  private validateCustomTimeframe(
    timeframeType?: TimeframeType,
    config?: Partial<ReportConfig>,
  ): void {
    if (timeframeType !== TimeframeType.CUSTOM) {
      return;
    }
    if (!config?.customStartDate || !config?.customEndDate) {
      throw new BadRequestException(
        tr(
          "errors.reports.customTimeframeMissingDates",
          "Custom timeframe requires both start and end dates",
        ),
      );
    }
  }

  private getDateRange(
    timeframeType: TimeframeType,
    customStart?: string,
    customEnd?: string,
  ): { startDate: string; endDate: string; label: string } {
    const today = new Date();
    const endDate = format(today, "yyyy-MM-dd");
    let startDate: string;
    let label: string;

    switch (timeframeType) {
      case TimeframeType.LAST_7_DAYS:
        startDate = format(subDays(today, 7), "yyyy-MM-dd");
        label = "Last 7 Days";
        break;
      case TimeframeType.LAST_30_DAYS:
        startDate = format(subDays(today, 30), "yyyy-MM-dd");
        label = "Last 30 Days";
        break;
      case TimeframeType.LAST_MONTH: {
        const lastMonth = subMonths(today, 1);
        startDate = format(startOfMonth(lastMonth), "yyyy-MM-dd");
        const lastMonthEnd = format(endOfMonth(lastMonth), "yyyy-MM-dd");
        label = format(lastMonth, "MMMM yyyy");
        return { startDate, endDate: lastMonthEnd, label };
      }
      case TimeframeType.LAST_3_MONTHS:
        startDate = format(subMonths(today, 3), "yyyy-MM-dd");
        label = "Last 3 Months";
        break;
      case TimeframeType.LAST_6_MONTHS:
        startDate = format(subMonths(today, 6), "yyyy-MM-dd");
        label = "Last 6 Months";
        break;
      case TimeframeType.LAST_12_MONTHS:
        startDate = format(subMonths(today, 12), "yyyy-MM-dd");
        label = "Last 12 Months";
        break;
      case TimeframeType.LAST_YEAR: {
        const lastYear = subYears(today, 1);
        startDate = format(startOfYear(lastYear), "yyyy-MM-dd");
        const lastYearEnd = format(endOfYear(lastYear), "yyyy-MM-dd");
        label = format(lastYear, "yyyy");
        return { startDate, endDate: lastYearEnd, label };
      }
      case TimeframeType.YEAR_TO_DATE:
        startDate = format(startOfYear(today), "yyyy-MM-dd");
        label = "Year to Date";
        break;
      case TimeframeType.CUSTOM:
        if (!customStart || !customEnd) {
          throw new BadRequestException(
            tr(
              "errors.reports.customTimeframeMissingDates",
              "Custom timeframe requires both start and end dates",
            ),
          );
        }
        startDate = customStart;
        label = "Custom Range";
        return { startDate, endDate: customEnd, label };
      default:
        startDate = format(subMonths(today, 3), "yyyy-MM-dd");
        label = "Last 3 Months";
    }

    return { startDate, endDate, label };
  }

  /**
   * Narrows each split parent to the lines this report asked for, and drops a
   * parent left with none.
   *
   * Two decisions the SQL could only make about the PARENT, and a split parent
   * is not its lines:
   *
   * - **Direction.** `transaction.amount` is the sum of every line, so its sign
   *   is nobody's direction: a -60 expense beside a +500 embedded SELL is a +440
   *   parent (audit F-CUSTOM-DIR-001).
   * - **Transfers.** `transaction.isTransfer` is false on a split parent that
   *   carries a transfer LINE, so `includeTransfers: false` counted a -200
   *   transfer inside a -260 parent as 260 of spending.
   *
   * Both are the user's own configuration, applied to the representation the
   * decision belongs to -- which is what the built-in split-row-granular reports
   * have always done with the same rows. Investment provenance is NOT decided
   * here: the aggregators ask `ordinarySplitLines` for that, because it is a
   * property of the data rather than of the report.
   */
  private narrowSplitLines(
    transactions: Transaction[],
    config: ReportConfig,
  ): Transaction[] {
    const narrowsDirection = config.direction !== DirectionFilter.BOTH;
    if (!narrowsDirection && config.includeTransfers) return transactions;

    const wanted = (split: TransactionSplit): boolean => {
      if (!config.includeTransfers && split.transferAccountId != null) {
        return false;
      }
      if (!narrowsDirection) return true;
      const amount = Number(split.amount);
      return config.direction === DirectionFilter.INCOME_ONLY
        ? amount > 0
        : amount < 0;
    };

    return transactions.flatMap((tx) => {
      if (!tx.isSplit || !tx.splits || tx.splits.length === 0) return [tx];

      const splits = tx.splits.filter(wanted);
      if (splits.length === 0) return [];

      // A shallow copy: the entity is not re-saved, and the aggregators read
      // only `splits` plus the parent's own scalar fields.
      return [{ ...tx, splits } as Transaction];
    });
  }

  /**
   * The accounts this report explicitly names.
   *
   * Not "does the report restrict itself to accounts": a boolean cannot express
   * a mixed OR group, and both of its answers are wrong for one shape.
   * Conditions WITHIN a group are OR'd, groups are AND'ed, so
   * `[account = Brokerage, category = Salary]` explicitly asks for Brokerage
   * rows while `[account = Chequing, payee = Acme]` asks for none -- and a single
   * boolean that admits the first also admits the second (or refuses both).
   * The ids let the caller ask the question per row instead.
   *
   * Advanced filter groups REPLACE the legacy filters in
   * `getFilteredTransactions`, so a report holding groups and a stale
   * `accountIds` names nothing; and a condition carrying no values (what the
   * filter builder saves for a half-finished one) adds no SQL, so it names
   * nothing either.
   */
  private explicitAccountIds(filters: CustomReport["filters"]): string[] {
    const groups = filters.filterGroups ?? [];
    const named =
      groups.length > 0
        ? groups.flatMap((group) =>
            (group.conditions ?? [])
              .filter((condition) => condition.field === "account")
              .flatMap((condition) =>
                Array.isArray(condition.value)
                  ? condition.value.filter(Boolean)
                  : condition.value
                    ? [condition.value]
                    : [],
              ),
          )
        : (filters.accountIds ?? []);
    return [...new Set(named)];
  }

  private async getFilteredTransactions(
    userId: string,
    startDate: string,
    endDate: string,
    filters: CustomReport["filters"],
    config: ReportConfig,
  ): Promise<Transaction[]> {
    return withScopedDb(this.dataSource, (m) => {
      const queryBuilder = m
        .getRepository(Transaction)
        .createQueryBuilder("transaction")
        .leftJoinAndSelect("transaction.account", "account")
        .leftJoinAndSelect("transaction.category", "category")
        .leftJoinAndSelect("category.parent", "categoryParent")
        .leftJoinAndSelect("transaction.payee", "payee")
        .leftJoinAndSelect("transaction.tags", "tags")
        .leftJoinAndSelect("transaction.splits", "splits")
        // Hydrated so an embedded investment line is recognisable by BOTH of its
        // representations, exactly as the raw-SQL reports recognise it.
        .leftJoinAndSelect("splits.investmentTransaction", "splitInvestmentTx")
        .leftJoinAndSelect("splits.category", "splitCategory")
        .leftJoinAndSelect("splitCategory.parent", "splitCategoryParent")
        .leftJoinAndSelect("splits.tags", "splitTags")
        // For a blank-payee transfer the row label resolves from the
        // counterpart account (issue #1214). Restricted to same-owner legs in
        // SQL: reports have no delegation mask, and an unrestricted join
        // would leak a cross-owner counterpart's live account name after
        // unshare. A cross-owner transfer simply falls back to its
        // description here.
        .leftJoinAndSelect(
          "transaction.linkedTransaction",
          "linkedTransaction",
          "linkedTransaction.userId = transaction.userId",
        )
        .leftJoinAndSelect("linkedTransaction.account", "linkedAccount")
        .where("transaction.userId = :userId", { userId })
        .andWhere("transaction.transactionDate >= :startDate", { startDate })
        .andWhere("transaction.transactionDate <= :endDate", { endDate })
        .andWhere("transaction.status != 'VOID'");

      // INV-REPORT-001: a custom report reads the same ledger as the built-in
      // ones, so it owes the same answer. The cash leg a free-standing trade
      // generated is never ordinary cash -- including when an explicit funding
      // account put that leg in an ordinary account, where no account-type
      // predicate could see it.
      queryBuilder.andWhere(
        investmentLinkedTransactionExclusion("transaction"),
      );
      // The securities sleeve is noise in a whole-ledger figure -- built-in
      // reports have no account picker, so they always drop it -- but here the
      // user may have named that very account, and answering an explicitly
      // scoped report with nothing is worse than showing the rows they asked to
      // see. The exception is per ROW, not per report: a filter group reading
      // `account = Brokerage OR category = Salary` names Brokerage, while
      // `account = Chequing OR payee = Acme` does not name it, and a
      // whole-report boolean cannot tell those apart (audit F-CUSTOM-OR-001).
      const explicitAccountIds = this.explicitAccountIds(filters);
      if (explicitAccountIds.length === 0) {
        queryBuilder.andWhere(brokerageExclusionForEntity("account"));
      } else {
        queryBuilder.andWhere(
          new Brackets((scope) => {
            scope
              .where(brokerageExclusionForEntity("account"))
              .orWhere(
                "transaction.accountId IN (:...explicitReportAccountIds)",
                { explicitReportAccountIds: explicitAccountIds },
              );
          }),
        );
      }
      // The embedded-investment half cannot be expressed here at all: the parent
      // is a real row carrying real ordinary cash beside the investment line, so
      // it is classified per line during aggregation.

      // Advanced filter groups take precedence over legacy filters
      if (filters.filterGroups && filters.filterGroups.length > 0) {
        this.applyFilterGroups(queryBuilder, filters.filterGroups);
      } else {
        // Legacy simple filters (backward compat)
        if (filters.accountIds && filters.accountIds.length > 0) {
          queryBuilder.andWhere("transaction.accountId IN (:...accountIds)", {
            accountIds: filters.accountIds,
          });
        }

        if (filters.categoryIds && filters.categoryIds.length > 0) {
          queryBuilder.andWhere(
            "(transaction.categoryId IN (:...categoryIds) OR splits.categoryId IN (:...categoryIds))",
            { categoryIds: filters.categoryIds },
          );
        }

        if (filters.payeeIds && filters.payeeIds.length > 0) {
          queryBuilder.andWhere("transaction.payeeId IN (:...payeeIds)", {
            payeeIds: filters.payeeIds,
          });
        }

        if (filters.searchText && filters.searchText.trim()) {
          const searchTerm = `%${filters.searchText.trim().toLowerCase()}%`;
          queryBuilder.andWhere(
            "(LOWER(transaction.payeeName) LIKE :searchTerm OR LOWER(transaction.description) LIKE :searchTerm)",
            { searchTerm },
          );
        }
      }

      // Filter by direction. A split parent's own amount is the SUM of its
      // lines, so its sign is not the direction of any particular line: a -60
      // expense beside a +500 embedded SELL is a +440 parent, and rejecting it
      // here threw away the expense before provenance ever ran (audit
      // F-CUSTOM-DIR-001). Split parents therefore pass this gate and are
      // narrowed per line in `applyDirectionToSplitLines`.
      if (config.direction === DirectionFilter.INCOME_ONLY) {
        queryBuilder.andWhere(
          "(transaction.isSplit = true OR transaction.amount > 0)",
        );
      } else if (config.direction === DirectionFilter.EXPENSES_ONLY) {
        queryBuilder.andWhere(
          "(transaction.isSplit = true OR transaction.amount < 0)",
        );
      }

      // Filter transfers
      if (!config.includeTransfers) {
        queryBuilder.andWhere("transaction.isTransfer = false");
      }

      // M29: Limit result set to prevent unbounded memory consumption
      return queryBuilder
        .orderBy("transaction.transactionDate", "ASC")
        .take(50000)
        .getMany();
    });
  }

  private applyFilterGroups(
    queryBuilder: ReturnType<Repository<Transaction>["createQueryBuilder"]>,
    filterGroups: Array<{
      conditions: Array<{ field: string; value: string | string[] }>;
    }>,
  ): void {
    for (let gi = 0; gi < filterGroups.length; gi++) {
      const group = filterGroups[gi];
      if (!group.conditions || group.conditions.length === 0) continue;

      queryBuilder.andWhere(
        new Brackets((qb) => {
          for (let ci = 0; ci < group.conditions.length; ci++) {
            const condition = group.conditions[ci];
            const param = `p_g${gi}_c${ci}`;
            const method = ci === 0 ? "where" : "orWhere";

            switch (condition.field) {
              case "account": {
                const values = Array.isArray(condition.value)
                  ? condition.value
                  : [condition.value];
                if (values.length === 1) {
                  qb[method](`transaction.accountId = :${param}`, {
                    [param]: values[0],
                  });
                } else if (values.length > 1) {
                  qb[method](`transaction.accountId IN (:...${param})`, {
                    [param]: values,
                  });
                }
                break;
              }
              case "category": {
                const values = Array.isArray(condition.value)
                  ? condition.value
                  : [condition.value];
                if (values.length === 1) {
                  qb[method](
                    new Brackets((inner) => {
                      inner
                        .where(`transaction.categoryId = :${param}`, {
                          [param]: values[0],
                        })
                        .orWhere(`splits.categoryId = :${param}`, {
                          [param]: values[0],
                        });
                    }),
                  );
                } else if (values.length > 1) {
                  qb[method](
                    new Brackets((inner) => {
                      inner
                        .where(`transaction.categoryId IN (:...${param})`, {
                          [param]: values,
                        })
                        .orWhere(`splits.categoryId IN (:...${param})`, {
                          [param]: values,
                        });
                    }),
                  );
                }
                break;
              }
              case "payee": {
                const values = Array.isArray(condition.value)
                  ? condition.value
                  : [condition.value];
                if (values.length === 1) {
                  qb[method](`transaction.payeeId = :${param}`, {
                    [param]: values[0],
                  });
                } else if (values.length > 1) {
                  qb[method](`transaction.payeeId IN (:...${param})`, {
                    [param]: values,
                  });
                }
                break;
              }
              case "tag": {
                const values = Array.isArray(condition.value)
                  ? condition.value
                  : [condition.value];
                if (values.length === 1) {
                  qb[method](
                    new Brackets((inner) => {
                      inner
                        .where(`tags.id = :${param}`, {
                          [param]: values[0],
                        })
                        .orWhere(`splitTags.id = :${param}`, {
                          [param]: values[0],
                        });
                    }),
                  );
                } else if (values.length > 1) {
                  qb[method](
                    new Brackets((inner) => {
                      inner
                        .where(`tags.id IN (:...${param})`, {
                          [param]: values,
                        })
                        .orWhere(`splitTags.id IN (:...${param})`, {
                          [param]: values,
                        });
                    }),
                  );
                }
                break;
              }
              case "text": {
                const textValue = Array.isArray(condition.value)
                  ? condition.value[0] || ""
                  : condition.value;
                const textParam = `%${textValue.trim().toLowerCase()}%`;
                qb[method](
                  new Brackets((inner) => {
                    inner
                      .where(`LOWER(transaction.payeeName) LIKE :${param}`, {
                        [param]: textParam,
                      })
                      .orWhere(
                        `LOWER(transaction.description) LIKE :${param}`,
                        {
                          [param]: textParam,
                        },
                      );
                  }),
                );
                break;
              }
            }
          }
        }),
      );
    }
  }

  private aggregateData(
    transactions: Transaction[],
    groupBy: GroupByType,
    metric: MetricType,
    categoryMap: Map<string, Category>,
    payeeMap: Map<string, Payee>,
  ): AggregatedDataPoint[] {
    switch (groupBy) {
      case GroupByType.NONE:
        return this.aggregateNoGrouping(transactions, metric);
      case GroupByType.CATEGORY:
        return this.aggregateByCategory(transactions, metric, categoryMap);
      case GroupByType.PAYEE:
        return this.aggregateByPayee(transactions, metric, payeeMap);
      case GroupByType.YEAR:
        return this.aggregateByTime(transactions, metric, "year");
      case GroupByType.MONTH:
        return this.aggregateByTime(transactions, metric, "month");
      case GroupByType.WEEK:
        return this.aggregateByTime(transactions, metric, "week");
      case GroupByType.DAY:
        return this.aggregateByTime(transactions, metric, "day");
      case GroupByType.TAG:
        return this.aggregateByTag(transactions, metric);
      default:
        return this.aggregateNoGrouping(transactions, metric);
    }
  }

  private formatCategoryLabel(
    category: Category | null | undefined,
  ): string | undefined {
    if (!category) return undefined;
    if (category.parent) return `${category.parent.name}: ${category.name}`;
    return category.name;
  }

  private aggregateNoGrouping(
    transactions: Transaction[],
    metric: MetricType,
  ): AggregatedDataPoint[] {
    // For NONE metric, return individual transactions as data points
    if (metric === MetricType.NONE) {
      const result: AggregatedDataPoint[] = [];

      for (const tx of transactions) {
        // A blank-payee transfer leg reads "Transfer to/from <account>"
        // resolved from its (same-owner) linked leg, exactly as the register
        // shows it (issue #1214). Only that fallback is new: a stored payee
        // (or, for the label, the description) still wins as before.
        const transferLabel =
          !tx.payeeName &&
          !tx.payee?.name &&
          tx.isTransfer &&
          tx.linkedTransaction?.account?.name
            ? transferPayeeLabel(tx.amount, tx.linkedTransaction.account.name)
            : undefined;
        if (tx.isSplit && tx.splits && tx.splits.length > 0) {
          // Only the lines that are ordinary cash: an embedded investment line
          // is the trade's own cash side, not a row of this report.
          for (const split of ordinarySplitLines(tx)) {
            result.push({
              id: tx.id,
              label:
                split.memo ||
                tx.payeeName ||
                transferLabel ||
                tx.description ||
                "Transaction",
              value: Math.abs(Number(split.amount)),
              count: 1,
              // Transaction-specific fields
              date: tx.transactionDate,
              payee: tx.payeeName || tx.payee?.name || transferLabel,
              description: tx.description || undefined,
              memo: split.memo || undefined,
              category: this.formatCategoryLabel(split.category),
              account: tx.account?.name || undefined,
            });
          }
        } else {
          result.push({
            id: tx.id,
            label:
              tx.payeeName || transferLabel || tx.description || "Transaction",
            value: Math.abs(Number(tx.amount)),
            count: 1,
            // Transaction-specific fields
            date: tx.transactionDate,
            payee: tx.payeeName || tx.payee?.name || transferLabel,
            description: tx.description || undefined,
            memo: undefined, // Transactions don't have memo, only splits do
            category: this.formatCategoryLabel(tx.category),
            account: tx.account?.name || undefined,
          });
        }
      }

      return result;
    }

    // For other metrics, aggregate into a single total
    const amounts: number[] = [];

    for (const tx of transactions) {
      if (tx.isSplit && tx.splits && tx.splits.length > 0) {
        for (const split of ordinarySplitLines(tx)) {
          amounts.push(Math.abs(Number(split.amount)));
        }
      } else {
        amounts.push(Math.abs(Number(tx.amount)));
      }
    }

    const count = amounts.length;
    const sum = sumMoney(amounts);

    if (count === 0) {
      return [];
    }

    return [
      {
        id: "total",
        label: "Total",
        value: this.calculateMetricValue(sum, count, metric),
        percentage: 100,
        count,
      },
    ];
  }

  private aggregateByCategory(
    transactions: Transaction[],
    metric: MetricType,
    categoryMap: Map<string, Category>,
  ): AggregatedDataPoint[] {
    const dataMap = new Map<string, { sum: number; count: number }>();

    for (const tx of transactions) {
      if (tx.isSplit && tx.splits && tx.splits.length > 0) {
        // Handle split transactions. An embedded investment line carries no
        // category by definition, so counting it here filed a securities
        // purchase under "Uncategorized" spending (re-audit F-CUSTOM-001).
        for (const split of ordinarySplitLines(tx)) {
          const categoryId = split.categoryId || "uncategorized";
          const existing = dataMap.get(categoryId) || { sum: 0, count: 0 };
          existing.sum = roundMoney(
            existing.sum + Math.abs(Number(split.amount)),
          );
          existing.count += 1;
          dataMap.set(categoryId, existing);
        }
      } else {
        // Regular transaction
        const categoryId = tx.categoryId || "uncategorized";
        const existing = dataMap.get(categoryId) || { sum: 0, count: 0 };
        existing.sum = roundMoney(existing.sum + Math.abs(Number(tx.amount)));
        existing.count += 1;
        dataMap.set(categoryId, existing);
      }
    }

    const totalSum = sumMoney(Array.from(dataMap.values()).map((v) => v.sum));

    const result: AggregatedDataPoint[] = [];
    for (const [categoryId, data] of dataMap) {
      const category = categoryMap.get(categoryId);
      const parent = category?.parentId
        ? categoryMap.get(category.parentId)
        : null;
      const label = category
        ? parent
          ? `${parent.name}: ${category.name}`
          : category.name
        : "Uncategorized";
      result.push({
        id: categoryId,
        label,
        value: this.calculateMetricValue(data.sum, data.count, metric),
        color: category?.color || undefined,
        percentage: totalSum > 0 ? (data.sum / totalSum) * 100 : 0,
        count: data.count,
      });
    }

    return result.sort((a, b) => b.value - a.value);
  }

  private aggregateByPayee(
    transactions: Transaction[],
    metric: MetricType,
    payeeMap: Map<string, Payee>,
  ): AggregatedDataPoint[] {
    const dataMap = new Map<
      string,
      { sum: number; count: number; payeeName?: string }
    >();

    for (const tx of transactions) {
      // `tx.amount` on a split parent is the sum of EVERY line, so a payee total
      // has to ask for the ordinary part; `null` means this row represents no
      // ordinary cash at all.
      const reportable = reportableTransactionAmount(tx);
      if (reportable === null) continue;
      const payeeId = tx.payeeId || "unknown";
      const existing = dataMap.get(payeeId) || {
        sum: 0,
        count: 0,
        payeeName: tx.payeeName ?? undefined,
      };
      existing.sum = roundMoney(existing.sum + Math.abs(reportable));
      existing.count += 1;
      if (!existing.payeeName && tx.payeeName) {
        existing.payeeName = tx.payeeName;
      }
      dataMap.set(payeeId, existing);
    }

    const totalSum = sumMoney(Array.from(dataMap.values()).map((v) => v.sum));

    const result: AggregatedDataPoint[] = [];
    for (const [payeeId, data] of dataMap) {
      const payee = payeeMap.get(payeeId);
      result.push({
        id: payeeId,
        label: payee?.name || data.payeeName || "Unknown",
        value: this.calculateMetricValue(data.sum, data.count, metric),
        percentage: totalSum > 0 ? (data.sum / totalSum) * 100 : 0,
        count: data.count,
      });
    }

    return result.sort((a, b) => b.value - a.value);
  }

  private aggregateByTag(
    transactions: Transaction[],
    metric: MetricType,
  ): AggregatedDataPoint[] {
    const dataMap = new Map<
      string,
      { sum: number; count: number; tagName: string; color?: string }
    >();

    for (const tx of transactions) {
      const reportable = reportableTransactionAmount(tx);
      if (reportable === null) continue;
      // Collect all tags: transaction-level + split-level. A tag on an embedded
      // investment line describes the trade, not ordinary cash, so the lines
      // that are not reportable do not open a bucket either.
      const allTags = [...(tx.tags || [])];
      if (tx.splits) {
        for (const split of ordinarySplitLines(tx)) {
          if (split.tags) {
            for (const tag of split.tags) {
              if (!allTags.some((t) => t.id === tag.id)) {
                allTags.push(tag);
              }
            }
          }
        }
      }

      if (allTags.length === 0) {
        // Untagged transactions
        const existing = dataMap.get("untagged") || {
          sum: 0,
          count: 0,
          tagName: "Untagged",
        };
        existing.sum = roundMoney(existing.sum + Math.abs(reportable));
        existing.count += 1;
        dataMap.set("untagged", existing);
      } else {
        for (const tag of allTags) {
          const existing = dataMap.get(tag.id) || {
            sum: 0,
            count: 0,
            tagName: tag.name,
            color: tag.color ?? undefined,
          };
          existing.sum = roundMoney(existing.sum + Math.abs(reportable));
          existing.count += 1;
          dataMap.set(tag.id, existing);
        }
      }
    }

    const totalSum = sumMoney(Array.from(dataMap.values()).map((v) => v.sum));

    const result: AggregatedDataPoint[] = [];
    for (const [tagId, data] of dataMap) {
      result.push({
        id: tagId,
        label: data.tagName,
        value: this.calculateMetricValue(data.sum, data.count, metric),
        color: data.color,
        percentage: totalSum > 0 ? (data.sum / totalSum) * 100 : 0,
        count: data.count,
      });
    }

    return result.sort((a, b) => b.value - a.value);
  }

  private aggregateByTime(
    transactions: Transaction[],
    metric: MetricType,
    period: "year" | "month" | "week" | "day",
  ): AggregatedDataPoint[] {
    const dataMap = new Map<
      string,
      { sum: number; count: number; label: string }
    >();

    for (const tx of transactions) {
      const reportable = reportableTransactionAmount(tx);
      if (reportable === null) continue;
      const date = parseISO(tx.transactionDate);
      let key: string;
      let label: string;

      switch (period) {
        case "year":
          key = format(startOfYear(date), "yyyy");
          label = format(date, "yyyy");
          break;
        case "month":
          key = format(startOfMonth(date), "yyyy-MM");
          label = format(date, "MMM yyyy");
          break;
        case "week":
          key = format(startOfWeek(date), "yyyy-MM-dd");
          label = `Week of ${format(startOfWeek(date), "MMM d")}`;
          break;
        case "day":
          key = format(startOfDay(date), "yyyy-MM-dd");
          label = format(date, "MMM d, yyyy");
          break;
      }

      const existing = dataMap.get(key) || { sum: 0, count: 0, label };
      existing.sum = roundMoney(existing.sum + Math.abs(reportable));
      existing.count += 1;
      dataMap.set(key, existing);
    }

    const result: AggregatedDataPoint[] = [];
    for (const [key, data] of dataMap) {
      result.push({
        id: key,
        label: data.label,
        value: this.calculateMetricValue(data.sum, data.count, metric),
        count: data.count,
      });
    }

    // Sort by date key for time-based groupings
    return result.sort((a, b) => a.id!.localeCompare(b.id!));
  }

  private calculateMetricValue(
    sum: number,
    count: number,
    metric: MetricType,
  ): number {
    switch (metric) {
      case MetricType.NONE:
        return roundMoney(sum);
      case MetricType.TOTAL_AMOUNT:
        return roundMoney(sum);
      case MetricType.COUNT:
        return count;
      case MetricType.AVERAGE:
        return count > 0 ? roundMoney(sum / count) : 0;
      case MetricType.BUDGET_VARIANCE:
        // For budget variance, sum contains the variance (actual - budgeted)
        return roundMoney(sum);
      default:
        return sum;
    }
  }

  private async enrichWithBudgetVariance(
    userId: string,
    data: AggregatedDataPoint[],
  ): Promise<AggregatedDataPoint[]> {
    try {
      const budgets = await this.budgetsService.findAll(userId);
      const activeBudget = budgets.find((b) => b.isActive) || budgets[0];
      if (!activeBudget) return data;

      const budget = await this.budgetsService.findOne(userId, activeBudget.id);
      const budgetMap = new Map<string, number>();
      for (const bc of budget.categories || []) {
        if (bc.categoryId && !bc.isIncome) {
          budgetMap.set(bc.categoryId, Number(bc.amount) || 0);
        }
      }

      return data.map((point) => {
        const budgeted = budgetMap.get(point.id || "") || 0;
        const variance = point.value - budgeted;
        return {
          ...point,
          value: roundMoney(variance),
          budgeted: roundMoney(budgeted),
          actual: roundMoney(point.value),
        };
      });
    } catch {
      return data;
    }
  }

  private calculateSummary(data: AggregatedDataPoint[]): ReportSummary {
    const total = sumMoney(data.map((d) => d.value));
    const count = data.reduce((acc, d) => acc + (d.count || 1), 0);
    const average = count > 0 ? total / count : 0;

    return {
      total: roundMoney(total),
      count,
      average: roundMoney(average),
    };
  }

  private sortData(
    data: AggregatedDataPoint[],
    sortBy: TableColumn,
    sortDirection: SortDirection,
  ): AggregatedDataPoint[] {
    const multiplier = sortDirection === SortDirection.ASC ? 1 : -1;

    return [...data].sort((a, b) => {
      switch (sortBy) {
        case TableColumn.LABEL:
          return multiplier * a.label.localeCompare(b.label);
        case TableColumn.VALUE:
          return multiplier * (a.value - b.value);
        case TableColumn.COUNT:
          return multiplier * ((a.count || 0) - (b.count || 0));
        case TableColumn.PERCENTAGE:
          return multiplier * ((a.percentage || 0) - (b.percentage || 0));
        // Transaction-specific columns
        case TableColumn.DATE:
          return multiplier * (a.date || "").localeCompare(b.date || "");
        case TableColumn.PAYEE:
          return multiplier * (a.payee || "").localeCompare(b.payee || "");
        case TableColumn.DESCRIPTION:
          return (
            multiplier *
            (a.description || "").localeCompare(b.description || "")
          );
        case TableColumn.MEMO:
          return multiplier * (a.memo || "").localeCompare(b.memo || "");
        case TableColumn.CATEGORY:
          return (
            multiplier * (a.category || "").localeCompare(b.category || "")
          );
        case TableColumn.ACCOUNT:
          return multiplier * (a.account || "").localeCompare(b.account || "");
        default:
          return 0;
      }
    });
  }
}
