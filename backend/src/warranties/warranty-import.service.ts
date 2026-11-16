import {
  BadRequestException,
  Injectable,
  PayloadTooLargeException,
} from "@nestjs/common";
import { DataSource } from "typeorm";

import { withScopedDb } from "../common/db/scoped-db";
import { resolveUserDefaultCurrency } from "../common/default-currency.util";
import { Currency } from "../currencies/entities/currency.entity";
import { tr } from "../i18n/translate";
import { parseCsvRows, validateCsvContent } from "../import/csv-parser";
import { WarrantiesService } from "./warranties.service";
import { WarrantyCsvRow, mapWarrantyCsv } from "./warranty-csv";

/** The largest import file, in bytes (design decision 12). */
export const WARRANTY_IMPORT_MAX_BYTES = 1024 * 1024;
/** The most data rows one import file may carry, the header not counted. */
export const WARRANTY_IMPORT_MAX_ROWS = 1000;

export interface WarrantyImportOptions {
  dryRun: boolean;
  /** Commit the valid rows and report the invalid ones, instead of refusing. */
  skipInvalid?: boolean;
}

export interface WarrantyImportRow extends Omit<WarrantyCsvRow, "outcome"> {
  outcome: "valid" | "invalid" | "created";
  /** The created warranty's id, on a committed row. */
  warrantyId?: string;
}

export interface WarrantyImportResult {
  rows: WarrantyImportRow[];
  created: number;
  skippedColumns: string[];
  dryRun: boolean;
}

/**
 * `POST /warranties/import`: a Warracker-format CSV into warranties.
 *
 * The preview and the commit are one computation (WTY-006): both read the
 * file through `parseCsvRows`, map and validate every row with
 * `mapWarrantyCsv`, and differ only in whether the valid rows are then
 * written. Each row is written through `WarrantiesService.createRow`, the
 * insert behind `create`, so the import refuses and derives exactly what the
 * API does (WTY-005, the term arithmetic, the price and currency rule)
 * without reading back a view per row. Every row is written on the manager
 * of the one `withScopedDb` transaction the mapping ran in: a row the
 * service or the database refuses rolls the whole file back, and a file with
 * an invalid row writes nothing unless the caller chose `skipInvalid`.
 */
@Injectable()
export class WarrantyImportService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly warrantiesService: WarrantiesService,
  ) {}

  async run(
    userId: string,
    content: string,
    options: WarrantyImportOptions,
  ): Promise<WarrantyImportResult> {
    const table = this.readTable(content);

    return withScopedDb(this.dataSource, async (m) => {
      const defaultCurrency = await resolveUserDefaultCurrency(
        this.dataSource,
        userId,
      );
      const currencies = await m
        .getRepository(Currency)
        .find({ select: { code: true } });
      const mapping = mapWarrantyCsv(table, {
        defaultCurrency,
        knownCurrencies: new Set(currencies.map((c) => c.code)),
      });

      if (mapping.missingColumns.length > 0) {
        const columns = mapping.missingColumns.join(", ");
        throw new BadRequestException(
          tr(
            "errors.warranties.import.missingColumns",
            `The file's header row has no ${columns} column`,
            { columns },
          ),
        );
      }

      const invalid = mapping.rows.filter(
        (row) => row.outcome === "invalid",
      ).length;
      if (options.dryRun) {
        return {
          rows: mapping.rows,
          created: 0,
          skippedColumns: mapping.skippedColumns,
          dryRun: true,
        };
      }
      if (invalid > 0 && options.skipInvalid !== true) {
        throw new BadRequestException(
          tr(
            "errors.warranties.import.invalidRows",
            `${invalid} rows are invalid, so nothing was imported; fix them or skip them`,
            { count: invalid },
          ),
        );
      }

      const rows: WarrantyImportRow[] = [];
      let created = 0;
      for (const row of mapping.rows) {
        if (row.warranty === null) {
          rows.push(row);
          continue;
        }
        const saved = await this.warrantiesService.createRow(
          m,
          userId,
          row.warranty,
        );
        rows.push({ ...row, outcome: "created", warrantyId: saved.id });
        created += 1;
      }
      return {
        rows,
        created,
        skippedColumns: mapping.skippedColumns,
        dryRun: false,
      };
    });
  }

  /** The file's limits and shape, refused before anything is read. */
  private readTable(content: string): string[][] {
    if (Buffer.byteLength(content, "utf8") > WARRANTY_IMPORT_MAX_BYTES) {
      throw new PayloadTooLargeException(
        tr(
          "errors.warranties.import.fileTooLarge",
          "The import file must be at most 1 MiB",
          { max: WARRANTY_IMPORT_MAX_BYTES },
        ),
      );
    }
    const text = content.replace(/^\uFEFF/, "");
    if (!validateCsvContent(text).valid) {
      throw new BadRequestException(
        tr(
          "errors.warranties.import.emptyFile",
          "The file must have a header row and at least one data row",
        ),
      );
    }
    const table = parseCsvRows(text, ",");
    const dataRows = table.length - 1;
    if (dataRows > WARRANTY_IMPORT_MAX_ROWS) {
      throw new BadRequestException(
        tr(
          "errors.warranties.import.tooManyRows",
          `The import file has ${dataRows} rows; at most ${WARRANTY_IMPORT_MAX_ROWS} are allowed`,
          { count: dataRows, max: WARRANTY_IMPORT_MAX_ROWS },
        ),
      );
    }
    if (dataRows < 1) {
      throw new BadRequestException(
        tr(
          "errors.warranties.import.emptyFile",
          "The file must have a header row and at least one data row",
        ),
      );
    }
    return table;
  }
}
