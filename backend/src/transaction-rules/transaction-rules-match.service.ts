import { Inject, Injectable, forwardRef } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import {
  buildPaginationMeta,
  clampPagination,
} from "../common/dto/pagination-query.dto";
import {
  TransactionsService,
  type PaginatedTransactions,
} from "../transactions/transactions.service";
import { MatchDraftRuleDto } from "./dto/rule-run.dto";
import { ruleConditionMatches } from "./rule-effects";
import { buildRuleFacts, loadAttachmentPresence } from "./rule-facts";
import { loadCandidateUnits, unitRowInput } from "./rule-run-candidates";
import { TransactionRulesApplierService } from "./transaction-rules-applier.service";
import { TransactionRulesService } from "./transaction-rules.service";
import {
  DEFAULT_RULE_MATCH_PAGE_LIMIT,
  MAX_RULE_MATCH_PAGE_LIMIT,
  MAX_RULE_MATCH_SCAN,
} from "./transaction-rules.limits";

/** One page of the transactions a draft condition matches, as the register lists them. */
export interface RuleMatchPage extends Pick<
  PaginatedTransactions,
  "data" | "pagination"
> {
  /** Transactions examined: the newest, up to `MAX_RULE_MATCH_SCAN`. */
  scanned: number;
  /** More transactions were in range than the scan examined; older ones were not looked at. */
  truncated: boolean;
}

/**
 * The editor's Test match: which existing transactions an unsaved condition
 * reaches, inside the draft's active window. Writes nothing.
 *
 * The rows are the run's evaluation units (`loadCandidateUnits`), so a
 * transfer is one match, read from the leg a run reads; the facts are built
 * by `unitRowInput`, the spelling the run's plan uses, and decided by
 * `ruleConditionMatches`, the question the planner asks before any action.
 * The page is then loaded through the register's own row query, so it is
 * drawn exactly as the Transactions page draws it.
 */
@Injectable()
export class TransactionRulesMatchService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly rulesService: TransactionRulesService,
    private readonly applier: TransactionRulesApplierService,
    // forwardRef: TransactionsModule imports this module for create()'s rules step.
    @Inject(forwardRef(() => TransactionsService))
    private readonly transactionsService: TransactionsService,
  ) {}

  async matchDraft(
    userId: string,
    dto: MatchDraftRuleDto,
  ): Promise<RuleMatchPage> {
    const { page, limit, skip } = clampPagination(dto.page, dto.limit, {
      defaultLimit: DEFAULT_RULE_MATCH_PAGE_LIMIT,
      maxLimit: MAX_RULE_MATCH_PAGE_LIMIT,
    });
    // A blank side is open, exactly as a save reads it.
    const window = {
      activeFrom: dto.activeFrom || null,
      activeTo: dto.activeTo || null,
    };
    if (
      window.activeFrom &&
      window.activeTo &&
      window.activeFrom > window.activeTo
    ) {
      throw this.rulesService.activeWindowInvalid();
    }
    return withScopedDb(this.dataSource, async (m) => {
      const condition = await this.rulesService.checkedCondition(
        m,
        userId,
        dto.condition,
      );
      const rule = { ...window, condition };
      // INV-RULE-004: the window narrows the scan; `ruleConditionMatches`
      // still decides every row.
      const { units, truncated } = await loadCandidateUnits(
        m,
        userId,
        {
          startDate: rule.activeFrom ?? undefined,
          endDate: rule.activeTo ?? undefined,
          limit: MAX_RULE_MATCH_SCAN,
        },
        { lock: false, maxLimit: MAX_RULE_MATCH_SCAN },
      );
      const legIds = units.flatMap((unit) => unit.legs.map((leg) => leg.id));
      const tagsByRow =
        legIds.length > 0
          ? await this.applier.loadTagIds(m, legIds)
          : new Map<string, string[]>();
      const attached = await loadAttachmentPresence(
        m,
        userId,
        units.map((unit) => unit.primary.id),
      );
      const chains = await this.applier.chainsFor(
        m,
        userId,
        [],
        units.map((unit) => unit.primary.categoryId),
      );

      const matchedIds: string[] = [];
      for (const unit of units) {
        const input = unitRowInput(unit, tagsByRow, attached);
        const facts = buildRuleFacts({
          ...input,
          categoryAncestorIds:
            input.categoryId === null ? [] : chains.get(input.categoryId),
        });
        if (ruleConditionMatches(rule, facts)) matchedIds.push(unit.primary.id);
      }

      const data = await this.transactionsService.findRegisterRowsByIds(
        userId,
        matchedIds.slice(skip, skip + limit),
      );
      return {
        data,
        pagination: buildPaginationMeta(page, limit, matchedIds.length),
        scanned: units.length,
        truncated,
      };
    });
  }
}
