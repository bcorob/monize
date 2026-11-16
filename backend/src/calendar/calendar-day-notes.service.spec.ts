import { ConflictException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";

import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { CalendarDayNotesService } from "./calendar-day-notes.service";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("CalendarDayNotesService", () => {
  let service: CalendarDayNotesService;
  let mocks: ReturnType<typeof createScopedDbMocks>;

  const lastQuery = () => {
    const calls = mocks.manager.query.mock.calls;
    return {
      sql: calls[calls.length - 1][0],
      params: calls[calls.length - 1][1],
    };
  };

  beforeEach(async () => {
    mocks = createScopedDbMocks();
    mocks.manager.query.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CalendarDayNotesService,
        { provide: DataSource, useValue: mocks.dataSource },
      ],
    }).compile();

    service = module.get(CalendarDayNotesService);
  });

  describe("list", () => {
    it("returns the user's notes for the range, as calendar dates", async () => {
      mocks.manager.query.mockResolvedValue([
        {
          note_date: "2026-06-14",
          end_date: "2026-06-18",
          body: "Rent moved",
          updated_at: new Date("2026-06-14T10:00:00.000Z"),
        },
      ]);

      const notes = await service.list("user-1", "2026-06-01", "2026-06-30");

      expect(notes).toEqual([
        {
          startDate: "2026-06-14",
          endDate: "2026-06-18",
          body: "Rent moved",
          updatedAt: "2026-06-14T10:00:00.000Z",
        },
      ]);
      // `::TEXT` on both ends, not the entity transformer: a DATE read as a
      // Date is an instant in the server's zone, which shifts the day west of
      // UTC -- and a span that shifts loses a day off each end.
      expect(lastQuery().sql).toContain("note_date::TEXT");
      expect(lastQuery().sql).toContain("end_date::TEXT");
      expect(lastQuery().params).toEqual([
        "user-1",
        "2026-06-01",
        "2026-06-30",
      ]);
    });

    it("asks for spans that OVERLAP the range, not ones that start inside it", async () => {
      // A vacation that began in May and ends in June covers days the June
      // reader is looking at. Keyed on note_date alone, the middle of it would
      // come back unmarked.
      await service.list("user-1", "2026-06-01", "2026-06-30");
      const { sql } = lastQuery();
      expect(sql).toContain("note_date <= $3::DATE");
      expect(sql).toContain("end_date >= $2::DATE");
    });

    it("filters by the caller's own id, always", async () => {
      await service.list("user-1", "2026-06-01", "2026-06-30");
      expect(lastQuery().sql).toContain("WHERE user_id = $1");
    });

    it("orders by date so the client need not sort", async () => {
      await service.list("user-1", "2026-06-01", "2026-06-30");
      expect(lastQuery().sql).toContain("ORDER BY note_date");
    });
  });

  describe("upsert", () => {
    const span = {
      startDate: "2026-06-14",
      endDate: "2026-06-18",
      body: "Away",
    };

    beforeEach(() => {
      mocks.manager.query.mockResolvedValue([
        {
          note_date: "2026-06-14",
          end_date: "2026-06-18",
          body: "Away",
          updated_at: "2026-06-14T10:00:00.000Z",
        },
      ]);
    });

    it("writes in ONE statement: resolve, update or insert, in one snapshot", async () => {
      await service.upsert("user-1", "2026-06-16", span);

      // One statement is the whole concurrency argument: a read followed by a
      // decision would let two saves for the same day interleave between them.
      expect(mocks.manager.query).toHaveBeenCalledTimes(1);
      const { sql, params } = lastQuery();
      expect(sql).toContain("WITH target AS");
      expect(sql).toContain("UPDATE calendar_day_notes");
      expect(sql).toContain("INSERT INTO calendar_day_notes");
      expect(sql).toContain("WHERE NOT EXISTS (SELECT 1 FROM target)");
      expect(params).toEqual([
        "user-1",
        "2026-06-16",
        "2026-06-14",
        "2026-06-18",
        "Away",
      ]);
    });

    it("resolves the row by the day it was opened on, not by the span's first day", async () => {
      // This is what lets a five-day note be edited from its third day, and
      // what lets the same request move the span's start.
      await service.upsert("user-1", "2026-06-16", span);
      expect(lastQuery().sql).toContain(
        "$2::DATE BETWEEN note_date AND end_date",
      );
    });

    it("returns the stored row, not an echo of the request", async () => {
      const note = await service.upsert("user-1", "2026-06-16", span);

      // `updatedAt` is the database's; a client that adopts the response has to
      // be adopting what was actually saved.
      expect(note).toEqual({
        startDate: "2026-06-14",
        endDate: "2026-06-18",
        body: "Away",
        updatedAt: "2026-06-14T10:00:00.000Z",
      });
      expect(lastQuery().sql).toContain("RETURNING");
    });

    it("refreshes updated_at on the update arm", async () => {
      await service.upsert("user-1", "2026-06-16", span);
      expect(lastQuery().sql).toContain("updated_at = CURRENT_TIMESTAMP");
    });

    it("reports an overlapping span as a conflict, not as a server error", async () => {
      // 23P01 is the exclusion constraint refusing the row -- the mechanism, not
      // a check this service performs. The request was well-formed and the
      // state it collided with is one the reader can see and move.
      mocks.manager.query.mockRejectedValue(
        Object.assign(new Error("conflicting key value"), {
          driverError: { code: "23P01" },
        }),
      );

      await expect(
        service.upsert("user-1", "2026-06-16", span),
      ).rejects.toThrow(ConflictException);
    });

    it("lets any other database error through unchanged", async () => {
      const other = Object.assign(new Error("boom"), {
        driverError: { code: "23514" },
      });
      mocks.manager.query.mockRejectedValue(other);

      await expect(service.upsert("user-1", "2026-06-16", span)).rejects.toBe(
        other,
      );
    });
  });

  describe("remove", () => {
    it("deletes the caller's note COVERING that day, whichever of its days it is", async () => {
      await service.remove("user-1", "2026-06-16");

      const { sql, params } = lastQuery();
      expect(sql).toContain("DELETE FROM calendar_day_notes");
      expect(sql).toContain("WHERE user_id = $1");
      expect(sql).toContain("$2::DATE BETWEEN note_date AND end_date");
      expect(params).toEqual(["user-1", "2026-06-16"]);
    });

    it("is idempotent: a day with no note is not an error", async () => {
      mocks.manager.query.mockResolvedValue([[], 0]);
      await expect(
        service.remove("user-1", "2026-06-14"),
      ).resolves.toBeUndefined();
    });
  });
});
