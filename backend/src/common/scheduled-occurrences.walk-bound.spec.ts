import { FrequencyType } from "./recurrence";

/**
 * The walk stops when nothing unwalked can change the answer.
 *
 * `maxOccurrences` is applied after ordering by due date, so the expander used to
 * walk the whole window and throw the rest away: the AI forecast asks for ONE
 * occurrence over a ten-year horizon, which is 3,650 steps for a daily schedule
 * -- past `OCCURRENCE_WALK_GUARD`, so the runaway backstop was silently doing the
 * bounding and the comment claiming a bounded horizon was arithmetically wrong.
 * For a user with forty daily schedules that is ~80,000 date constructions per
 * request, to select forty rows.
 *
 * This spec counts the steps, because the results are identical either way --
 * which is exactly why the waste survived review.
 */
const advanceCalls: string[] = [];

jest.mock("./recurrence", () => {
  const actual = jest.requireActual("./recurrence");
  return {
    ...actual,
    calculateNextDueDate: (date: string, frequency: string) => {
      advanceCalls.push(date);
      return actual.calculateNextDueDate(date, frequency);
    },
  };
});

// Imported after the mock so the module under test binds to it.
import {
  OCCURRENCE_WALK_GUARD,
  expandOccurrenceSlots,
} from "./scheduled-occurrences";

describe("expandOccurrenceSlots walk bound", () => {
  const daily = (nextDueDate: string) => ({
    frequency: "DAILY" as FrequencyType,
    nextDueDate,
    endDate: null,
    occurrencesRemaining: null,
  });

  beforeEach(() => {
    advanceCalls.length = 0;
  });

  it("takes one step past the first occurrence when one is asked for", () => {
    const found = expandOccurrenceSlots(daily("2026-03-01"), [], {
      from: "2026-03-01",
      // A ten-year horizon, as the AI forecast passes.
      through: "2036-03-01",
      maxOccurrences: 1,
    });

    expect(found).toHaveLength(1);
    expect(found[0].dueDate).toBe("2026-03-01");
    // One advance to establish that nothing earlier can follow, and no more.
    expect(advanceCalls).toHaveLength(1);
    expect(advanceCalls.length).toBeLessThan(OCCURRENCE_WALK_GUARD);
  });

  it("keeps walking for an override that reaches back from beyond the horizon", () => {
    // The occurrence at the 20th slot is moved to the 5th -- EARLIER than the
    // schedule's own next slot on the 10th. Asked for one occurrence, the answer
    // is the moved one, so an early exit that stopped at the first occurrence it
    // found would return the wrong occurrence, not merely fewer of them.
    const found = expandOccurrenceSlots(
      daily("2026-03-10"),
      [{ originalDate: "2026-03-20", overrideDate: "2026-03-05" }],
      { from: "2026-03-01", through: "2036-03-01", maxOccurrences: 1 },
    );

    expect(found).toHaveLength(1);
    expect(found[0].dueDate).toBe("2026-03-05");
    expect(found[0].originalDate).toBe("2026-03-20");
    expect(found[0].moved).toBe(true);
    // It walked to the 20th slot and stopped there rather than to 2036.
    expect(advanceCalls.length).toBeGreaterThanOrEqual(10);
    expect(advanceCalls.length).toBeLessThan(20);
  });

  it("still answers an uncapped window in full", () => {
    const found = expandOccurrenceSlots(daily("2026-03-01"), [], {
      from: "2026-03-01",
      through: "2026-03-05",
    });

    expect(found.map((o) => o.dueDate)).toEqual([
      "2026-03-01",
      "2026-03-02",
      "2026-03-03",
      "2026-03-04",
      "2026-03-05",
    ]);
  });

  it("walks a capped window no further than an uncapped one would answer", () => {
    expandOccurrenceSlots(daily("2026-03-01"), [], {
      from: "2026-03-01",
      through: "2026-03-31",
      maxOccurrences: 3,
    });

    // Three occurrences plus the step that proves the fourth cannot beat them.
    expect(advanceCalls).toHaveLength(3);
  });
});
