import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { CalendarDayNote } from "./entities/calendar-day-note.entity";
import { CalendarDayNotesController } from "./calendar-day-notes.controller";
import { CalendarDayNotesService } from "./calendar-day-notes.service";

/**
 * The calendar's own module: one table nothing financial reads, and no edge to
 * any other module. It imports nothing and exports nothing, which is why it
 * needs no `forwardRef`.
 */
@Module({
  imports: [TypeOrmModule.forFeature([CalendarDayNote])],
  providers: [CalendarDayNotesService],
  controllers: [CalendarDayNotesController],
  exports: [CalendarDayNotesService],
})
export class CalendarModule {}
