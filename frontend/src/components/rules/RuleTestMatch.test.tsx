import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@/test/render';
import { RuleTestMatch, RULE_MATCH_PAGE_SIZE } from './RuleTestMatch';
import { COFFEE_ID, FOOD_ID } from './rules-test-fixtures';
import { emptyDraft } from '@/lib/rule-draft';
import { createLeaf, type EditorGroup } from '@/lib/rule-tree';
import type { Category } from '@/types/category';
import type { Transaction } from '@/types/transaction';
import type { RuleMatchPage } from '@/types/transaction-rule-run';

const api = vi.hoisted(() => ({ matchDraft: vi.fn() }));

vi.mock('@/lib/transaction-rules-api', () => ({ transactionRulesApi: api }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

// The shared register list has its own tests; stub it so this one asserts the
// wiring (what is fetched, what is passed down) rather than re-testing rows.
const listProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));
vi.mock('@/components/transactions/TransactionList', () => ({
  TransactionList: (props: {
    transactions: Transaction[];
    onPageChange?: (page: number) => void;
    onRefresh?: () => void;
    categoryLabelMap?: Map<string, string>;
  }) => {
    listProps.last = props as unknown as Record<string, unknown>;
    return (
      <div data-testid="transaction-list">
        <span data-testid="row-ids">{props.transactions.map((row) => row.id).join(',')}</span>
        <span data-testid="label">{props.categoryLabelMap?.get(COFFEE_ID) ?? ''}</span>
        <button type="button" onClick={() => props.onPageChange?.(2)}>
          next-page
        </button>
        <button type="button" onClick={() => props.onRefresh?.()}>
          refresh
        </button>
      </div>
    );
  },
}));

const categories = [
  { id: FOOD_ID, name: 'Food', parentId: null },
  { id: COFFEE_ID, name: 'Coffee', parentId: FOOD_ID },
] as Category[];

function condition(value = 'coffee'): EditorGroup {
  return { ...emptyDraft().condition, children: [{ ...createLeaf('payeeText'), value }] };
}

function matchPage(ids: string[], over: Partial<RuleMatchPage> = {}): RuleMatchPage {
  return {
    data: ids.map((id) => ({ id }) as Transaction),
    pagination: { page: 1, limit: 10, total: ids.length, totalPages: ids.length > 0 ? 1 : 0, hasMore: false },
    scanned: 40,
    truncated: false,
    ...over,
  };
}

interface Props {
  condition?: EditorGroup;
  activeFrom?: string;
  activeTo?: string;
  blocked?: boolean;
}

async function renderMatch(props: Props = {}) {
  const make = (p: Props) => (
    <RuleTestMatch
      condition={p.condition ?? condition()}
      activeFrom={p.activeFrom ?? ''}
      activeTo={p.activeTo ?? ''}
      blocked={p.blocked}
      categories={categories}
    />
  );
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(make(props));
  });
  return {
    rerenderWith: async (next: Props) => {
      await act(async () => {
        result.rerender(make(next));
      });
    },
  };
}

const button = () => screen.getByRole('button', { name: 'Test rule conditions' });
const press = async () => {
  await act(async () => {
    fireEvent.click(button());
  });
};

describe('RuleTestMatch', () => {
  beforeEach(() => {
    api.matchDraft.mockReset();
    listProps.last = null;
  });

  it('shows the label Test rule and fetches nothing until it is pressed', async () => {
    await renderMatch();
    expect(button()).toHaveTextContent('Test rule');
    expect(api.matchDraft).not.toHaveBeenCalled();
    expect(screen.queryByTestId('rule-match-summary')).not.toBeInTheDocument();
  });

  it('sends the condition and the window, ten to a page, and lists the matches in the register list', async () => {
    api.matchDraft.mockResolvedValue(matchPage(['t1', 't2']));
    await renderMatch({ activeFrom: '2026-10-01' });
    await press();

    expect(api.matchDraft).toHaveBeenCalledWith({
      condition: { all: [{ field: 'payeeText', op: 'eq', value: 'coffee' }] },
      activeFrom: '2026-10-01',
      page: 1,
      limit: RULE_MATCH_PAGE_SIZE,
    });
    expect(RULE_MATCH_PAGE_SIZE).toBe(10);
    expect(screen.getByTestId('rule-match-summary')).toHaveTextContent('2 matching transactions');
    expect(screen.getByTestId('row-ids')).toHaveTextContent('t1,t2');
    expect(listProps.last).toMatchObject({
      densityView: 'ruleMatch',
      pageSize: 10,
      currentPage: 1,
      totalPages: 1,
      totalItems: 2,
    });
    // The hierarchical label the register shows.
    expect(screen.getByTestId('label')).toHaveTextContent('Food: Coffee');
  });

  it('turns the page through the same tested condition', async () => {
    api.matchDraft.mockResolvedValue(matchPage(['t1'], { pagination: { page: 1, limit: 10, total: 12, totalPages: 2, hasMore: true } }));
    await renderMatch();
    await press();
    api.matchDraft.mockResolvedValue(matchPage(['t11'], { pagination: { page: 2, limit: 10, total: 12, totalPages: 2, hasMore: false } }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'next-page' }));
    });

    expect(api.matchDraft).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2, limit: 10 }));
    expect(screen.getByTestId('row-ids')).toHaveTextContent('t11');
  });

  it('collapses and expands the list from its summary', async () => {
    api.matchDraft.mockResolvedValue(matchPage(['t1']));
    await renderMatch();
    await press();
    const details = screen.getByTestId('rule-match-summary').closest('details') as HTMLDetailsElement;
    expect(details.open).toBe(true);

    fireEvent.click(screen.getByTestId('rule-match-summary'));
    expect(details.open).toBe(false);
    fireEvent.click(screen.getByTestId('rule-match-summary'));
    expect(details.open).toBe(true);
  });

  it('says so when nothing matches, rather than drawing an empty list', async () => {
    api.matchDraft.mockResolvedValue(matchPage([]));
    await renderMatch();
    await press();
    expect(screen.getByTestId('rule-match-summary')).toHaveTextContent('No matching transactions');
    expect(screen.getByText('No existing transactions match these conditions.')).toBeInTheDocument();
    expect(screen.queryByTestId('transaction-list')).not.toBeInTheDocument();
  });

  it('names how far the search went when it stopped short of the register', async () => {
    api.matchDraft.mockResolvedValue(matchPage(['t1'], { truncated: true, scanned: 5000 }));
    await renderMatch();
    await press();
    expect(screen.getByText('Only the newest 5,000 transactions were checked.')).toBeInTheDocument();
  });

  it('shows a failed request as a failure, not as no matches', async () => {
    api.matchDraft.mockRejectedValue(new Error('boom'));
    await renderMatch();
    await press();
    expect(screen.getByText(/The matching transactions could not be loaded/)).toBeInTheDocument();
    expect(screen.queryByText('No existing transactions match these conditions.')).not.toBeInTheDocument();
  });

  it('marks the list out of date when the conditions change, and keeps the tested answer', async () => {
    api.matchDraft.mockResolvedValue(matchPage(['t1']));
    const view = await renderMatch();
    await press();
    await view.rerenderWith({ condition: condition('tea') });

    expect(screen.getByRole('status')).toHaveTextContent('The conditions changed since this test.');
    expect(screen.getByTestId('rule-match-result')).toHaveAttribute('data-stale', 'true');
    expect(api.matchDraft).toHaveBeenCalledTimes(1);
  });

  it('reads the page again when a row in it changes', async () => {
    api.matchDraft.mockResolvedValue(matchPage(['t1']));
    await renderMatch();
    await press();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'refresh' }));
    });
    expect(api.matchDraft).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['an incomplete condition', { condition: condition('') }, 'Complete the conditions above'],
    ['an expression that does not parse', { blocked: true }, 'Complete the conditions above'],
    ['a window that ends before it starts', { activeFrom: '2026-10-02', activeTo: '2026-10-01' }, 'The active dates end before they start'],
  ])('is disabled for %s', async (_label, props, text) => {
    await renderMatch(props);
    expect(button()).toBeDisabled();
    expect(screen.getByText(new RegExp(text))).toBeInTheDocument();
  });
});
