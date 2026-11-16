import { readFileSync } from "fs";
import { join } from "path";
import { BadRequestException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";

import { CalendarDayNotesController } from "./calendar-day-notes.controller";
import { CalendarDayNotesService } from "./calendar-day-notes.service";
import { ParseCalendarDatePipe } from "../common/pipes/parse-calendar-date.pipe";

describe("CalendarDayNotesController", () => {
  let controller: CalendarDayNotesController;
  let dayNotes: Record<string, jest.Mock>;

  const req = { user: { id: "user-1", realUserId: "user-1" } };

  beforeEach(async () => {
    dayNotes = {
      list: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue({
        startDate: "2026-06-14",
        endDate: "2026-06-14",
        body: "hi",
        updatedAt: "2026-06-14T10:00:00.000Z",
      }),
      remove: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CalendarDayNotesController],
      providers: [{ provide: CalendarDayNotesService, useValue: dayNotes }],
    }).compile();

    controller = module.get(CalendarDayNotesController);
  });

  it("takes the user id from the JWT on every route, never from the request", async () => {
    await controller.list(req, {
      startDate: "2026-06-01",
      endDate: "2026-06-30",
    });
    await controller.upsert(req, "2026-06-14", { body: "hi" });
    await controller.remove(req, "2026-06-14");

    expect(dayNotes.list).toHaveBeenCalledWith(
      "user-1",
      "2026-06-01",
      "2026-06-30",
    );
    expect(dayNotes.upsert).toHaveBeenCalledWith("user-1", "2026-06-14", {
      startDate: "2026-06-14",
      endDate: "2026-06-14",
      body: "hi",
    });
    expect(dayNotes.remove).toHaveBeenCalledWith("user-1", "2026-06-14");
  });

  it("returns the stored note from the write", async () => {
    const note = await controller.upsert(req, "2026-06-14", { body: "hi" });
    expect(note).toEqual({
      startDate: "2026-06-14",
      endDate: "2026-06-14",
      body: "hi",
      updatedAt: "2026-06-14T10:00:00.000Z",
    });
  });

  it("passes the span through, with the day in the URL as the anchor", async () => {
    // The anchor is the day the panel was showing; the span is what the editor
    // asked for. A note opened from its third day and extended a day at the
    // front is one request, not a delete and a create.
    await controller.upsert(req, "2026-06-16", {
      body: "Away",
      startDate: "2026-06-14",
      endDate: "2026-06-18",
    });

    expect(dayNotes.upsert).toHaveBeenCalledWith("user-1", "2026-06-16", {
      startDate: "2026-06-14",
      endDate: "2026-06-18",
      body: "Away",
    });
  });

  it("refuses a span that does not cover the day it was written from", async () => {
    // The panel is showing that day; a span that skips it would store a note
    // the reader is told they just wrote and cannot see.
    await expect(
      controller.upsert(req, "2026-06-16", {
        body: "Away",
        startDate: "2026-06-20",
        endDate: "2026-06-22",
      }),
    ).rejects.toThrow(BadRequestException);
    expect(dayNotes.upsert).not.toHaveBeenCalled();
  });

  describe("the :date parameter", () => {
    const pipe = new ParseCalendarDatePipe();

    it("accepts a real calendar date", () => {
      expect(pipe.transform("2026-06-14")).toBe("2026-06-14");
      expect(pipe.transform("2024-02-29")).toBe("2024-02-29");
    });

    it("rejects a day that does not exist, rather than letting Postgres 500", () => {
      // `2100-02-29` and `9999-99-99` both match \\d{4}-\\d{2}-\\d{2}, so a
      // shape check alone would send them to the database as date literals.
      expect(() => pipe.transform("2100-02-29")).toThrow(BadRequestException);
      expect(() => pipe.transform("9999-99-99")).toThrow(BadRequestException);
      expect(() => pipe.transform("2026-06-31")).toThrow(BadRequestException);
    });

    it("rejects anything that is not a date at all", () => {
      expect(() => pipe.transform("today")).toThrow(BadRequestException);
      expect(() => pipe.transform("")).toThrow(BadRequestException);
      expect(() => pipe.transform(undefined as unknown as string)).toThrow(
        BadRequestException,
      );
    });
  });

  it("is not reachable by an acting delegate", () => {
    // A note is the owner's own writing about their own day (design decision
    // 12). The client hides the section in an acting session, but an endpoint a
    // delegate could reach would make that hiding the only thing keeping it
    // private -- so the decorator must be absent, not merely unused.
    const source = readFileSync(
      join(__dirname, "calendar-day-notes.controller.ts"),
      "utf8",
    );
    expect(source).toContain('@UseGuards(AuthGuard("jwt"))');
    // The decorator applied, not the word: the comment above the class explains
    // why it is absent and would otherwise match.
    const applied = source
      .split("\n")
      .filter((line) => line.trim().startsWith("@AllowDelegate"));
    expect(applied).toEqual([]);
  });
});
