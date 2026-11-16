import { describe, expect, it } from 'vitest';
import { applySuggestion, complete, parseCondition } from '@/lib/rule-cel';
import { MAX_ENTITY_SUGGESTIONS } from '@/lib/rule-cel/complete';
import { INDEX } from '@/test/rule-cel-support';
import { RULE_CONDITION_FIELDS, RULE_FIELDS } from '@/lib/rule-fields';

/** The last `|` marks the caret (an earlier one is the `||` operator); returns the labels offered there. */
function at(marked: string) {
  const caret = marked.lastIndexOf('|');
  const text = marked.slice(0, caret) + marked.slice(caret + 1);
  const completion = complete(text, caret, INDEX);
  return { text, caret, completion, labels: completion?.items.map((i) => i.label) ?? [] };
}

/** Types `marked`, picks the item labelled `label`, and returns the text with the caret marked. */
function pick(marked: string, label: string): string {
  const { text, completion } = at(marked);
  const item = completion?.items.find((i) => i.label === label);
  if (!completion || !item) throw new Error(`no ${label} in ${completion?.items.map((i) => i.label).join(', ')}`);
  const next = applySuggestion(text, completion, item);
  return `${next.text.slice(0, next.caret)}|${next.text.slice(next.caret)}`;
}

describe('complete: fields', () => {
  it('offers every field after transaction.', () => {
    expect(at('transaction.|').labels).toEqual([...RULE_FIELDS]);
  });

  it('filters by what is typed, without regard to case', () => {
    expect(at('transaction.am|').labels).toEqual(['amount']);
    expect(at('transaction.PAYEE|').labels).toEqual(['payeeId', 'payeeText']);
    expect(at('transaction.zzz|').completion).toBeNull();
  });

  it('carries the field label as the hint, and replaces the whole word the caret is in', () => {
    const { completion } = at('transaction.pay|eeText == "x"');
    expect(completion?.items[0]).toMatchObject({ label: 'payeeId', hint: 'fields.payeeId' });
    expect(pick('a && transaction.referenceN|', 'referenceNumber')).toBe('a && transaction.referenceNumber|');
    expect(pick('transaction.acc|ountId == 1', 'accountId')).toBe('transaction.accountId| == 1');
  });
});

describe('complete: methods and operators', () => {
  it('offers the methods the field allows after transaction.field.', () => {
    expect(at('transaction.referenceNumber.|').labels).toEqual(['contains', 'startsWith', 'matchesGlob']);
    expect(at('transaction.amount.|').labels).toEqual(['between']);
    expect(at('transaction.tagIds.|').labels).toEqual(['hasAny', 'hasAll', 'hasNone']);
    expect(at('transaction.categoryId.|').labels).toEqual(['inSubtree']);
    expect(at('transaction.type.|').completion).toBeNull();
    expect(at('transaction.referenceNumber.st|').labels).toEqual(['startsWith']);
  });

  it('inserts the method with its opening parenthesis and explains it by the operator label', () => {
    expect(pick('transaction.referenceNumber.con|', 'contains')).toBe('transaction.referenceNumber.contains(|');
    expect(at('transaction.referenceNumber.|').completion?.items[2]).toMatchObject({
      insert: 'matchesGlob(',
      hint: 'operators.matches',
    });
  });

  it('offers the comparisons the field allows after the field and a space', () => {
    expect(at('transaction.amount |').labels).toEqual(['==', '<', '<=', '>', '>=']);
    expect(at('transaction.type |').labels).toEqual(['==', '!=', 'in']);
    expect(at('transaction.accountId |').labels).toEqual(['==', '!=', 'in']);
    expect(at('transaction.hasSplits |').labels).toEqual(['==']);
    expect(at('transaction.referenceNumber |').labels).toEqual(['==']);
    expect(at('transaction.tagIds |').completion).toBeNull();
  });

  it('narrows the operators by the symbols or letters typed', () => {
    expect(at('transaction.amount <|').labels).toEqual(['<', '<=']);
    expect(at('transaction.amount =|').labels).toEqual(['==']);
    expect(at('transaction.type !|').labels).toEqual(['!=']);
    expect(at('transaction.type i|').labels).toEqual(['in']);
    expect(pick('transaction.amount >|', '>=')).toBe('transaction.amount >= |');
  });
});

describe('complete: values', () => {
  it('offers the enum members after a comparison, and inside quotes', () => {
    expect(at('transaction.type == |').labels).toEqual(['"EXPENSE"', '"INCOME"', '"TRANSFER"']);
    expect(at('transaction.type == INC|').labels).toEqual(['"INCOME"']);
    expect(at('transaction.type in ["EXPENSE", |').labels).toEqual(['"EXPENSE"', '"INCOME"', '"TRANSFER"']);
    expect(at('transaction.type == "TR|').labels).toEqual(['TRANSFER']);
    expect(pick('transaction.type == "TR|', 'TRANSFER')).toBe('transaction.type == "TRANSFER"|');
    expect(at('transaction.type == |').completion?.items[0].hint).toBe('types.EXPENSE');
  });

  it('closes over the rest of a string that was already there', () => {
    expect(pick('transaction.type == "TR|ANSFER" && x', 'TRANSFER')).toBe('transaction.type == "TRANSFER"| && x');
    expect(pick("transaction.type == 'TR|", 'TRANSFER')).toBe('transaction.type == "TRANSFER"|');
  });

  it('offers true and false for a boolean field', () => {
    expect(at('transaction.hasSplits == |').labels).toEqual(['true', 'false']);
    expect(at('transaction.hasSplits == t|').labels).toEqual(['true']);
  });

  it('offers no value for a number or a text', () => {
    expect(at('transaction.amount > |').completion).toBeNull();
    expect(at('transaction.referenceNumber == |').completion).toBeNull();
    expect(at('transaction.referenceNumber == "ab|').completion).toBeNull();
  });

  it('offers the written form of an item after a comparison, never an id', () => {
    const { labels, completion } = at('transaction.accountId == |');
    expect(labels).toEqual(['account("Chequing", 1)', 'account("RRSP")', 'account("Chequing", 2)', 'account("Say \\"hi\\" \\\\ there")']);
    expect(JSON.stringify(completion)).not.toMatch(/acc-\d/);
    expect(at('transaction.tagIds.hasAny([|').labels).toEqual(['tag("Coffee run")', 'tag("Work")', 'tag("Line\\nbreak")']);
    expect(at('transaction.categoryId.inSubtree(|').labels).toEqual(['category("Food")', 'category("Food: Coffee")', 'category("Zażółć gęślą")']);
    expect(at('transaction.payeeId == pa|').labels.length).toBe(MAX_ENTITY_SUGGESTIONS < 5 ? MAX_ENTITY_SUGGESTIONS : 5);
    expect(at('transaction.payeeId == ac|').completion).toBeNull();
  });
});

describe('complete: names inside a reference', () => {
  it('offers the names of that kind inside account("', () => {
    expect(at('transaction.accountId == account("|').labels).toEqual(['Chequing (1)', 'RRSP', 'Chequing (2)', 'Say "hi" \\ there']);
    expect(at('transaction.accountId == account("rr|').labels).toEqual(['RRSP']);
    expect(at('transaction.payeeId == payee("Ama|').labels).toEqual(['Amazon (1)', 'Amazon (2)', 'Amazon (3)']);
    expect(at('transaction.tagIds.hasAny([tag("wo|').labels).toEqual(['Work']);
    expect(at('transaction.categoryId == category("food: |').labels).toEqual(['Food: Coffee']);
  });

  it('ranks names that start with the text before names that merely contain it', () => {
    expect(at('transaction.categoryId == category("Coffee|').labels).toEqual(['Food: Coffee']);
    expect(at('transaction.categoryId == category("o|').labels).toEqual(['Food', 'Food: Coffee']);
  });

  it('inserts the name form with its closing quote and parenthesis, the number when the name is shared', () => {
    expect(pick('transaction.accountId == account("rr|', 'RRSP')).toBe('transaction.accountId == account("RRSP")|');
    expect(pick('transaction.payeeId == payee("Ama|', 'Amazon (2)')).toBe('transaction.payeeId == payee("Amazon", 2)|');
    expect(pick('transaction.accountId == account("Say|', 'Say "hi" \\ there')).toBe(
      'transaction.accountId == account("Say \\"hi\\" \\\\ there")|',
    );
    expect(pick('transaction.tagIds.hasAny([tag("Li|', 'Line\nbreak')).toBe('transaction.tagIds.hasAny([tag("Line\\nbreak")|');
  });

  it('replaces a closing quote and parenthesis that are already there', () => {
    expect(pick('transaction.accountId == account("rr|")', 'RRSP')).toBe('transaction.accountId == account("RRSP")|');
    expect(pick('transaction.accountId == account("rr|SP")', 'RRSP')).toBe('transaction.accountId == account("RRSP")|');
  });

  it('offers nothing for a kind that has no such name, or inside another function', () => {
    expect(at('transaction.accountId == account("zzz|').completion).toBeNull();
    expect(at('transaction.referenceNumber.contains("a|').completion).toBeNull();
  });

  it('yields text that parses once the reference is complete', () => {
    const text = pick('transaction.payeeId == payee("Ama|', 'Amazon (3)').replaceAll('|', '');
    const result = parseCondition(text, INDEX);
    expect(result.ok).toBe(true);
  });
});

describe('complete: where a condition can start', () => {
  it('offers the starting words after && || ( ! and while a word is typed at the start', () => {
    expect(at('transaction.referenceNumber == "a" && |').labels).toEqual([
      'transaction.',
      'isEmpty(',
      'all(',
      'any(',
      'true',
      'false',
    ]);
    expect(at('transaction.referenceNumber == "a" || tr|').labels).toEqual(['transaction.', 'true']);
    expect(at('(|').labels).toContain('transaction.');
    expect(at('! |').labels).toContain('transaction.');
    expect(at('is|').labels).toEqual(['isEmpty(']);
    expect(at('all(|').labels).toContain('transaction.');
  });

  it('offers the field inside isEmpty(', () => {
    expect(at('isEmpty(|').labels).toEqual(['transaction.']);
    expect(pick('isEmpty(tra|', 'transaction.')).toBe('isEmpty(transaction.|');
  });

  it('offers nothing on empty text, after a complete value, or after a symbol alone', () => {
    expect(at('|').completion).toBeNull();
    expect(at('transaction.referenceNumber == "a" |').completion).toBeNull();
    expect(at('transaction.referenceNumber == "a"|').completion).toBeNull();
    expect(at('transaction.referenceNumber == "a" &&|').completion?.items.length).toBeGreaterThan(0);
    expect(at('!|').completion).toBeNull();
    expect(at('zzz|').completion).toBeNull();
  });

  it('offers every operator the tables allow for every field', () => {
    for (const field of RULE_FIELDS) {
      const ops = RULE_CONDITION_FIELDS[field].operators;
      const labels = at(`transaction.${field} |`).labels;
      const expectedCount = ops.filter((op) => ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'in'].includes(op)).length;
      expect(labels.length, field).toBe(expectedCount);
    }
  });
});
