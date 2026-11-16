import { plainToInstance } from "class-transformer";
import { ValidationError, isURL, validateSync } from "class-validator";

import { isCalendarDate } from "../common/validators/is-calendar-date.validator";
import { tr } from "../i18n/translate";
import {
  CreateWarrantyDto,
  WARRANTY_MAX_SERIAL_NUMBERS,
} from "./dto/create-warranty.dto";
import { WARRANTY_KINDS, WarrantyKind } from "./entities/warranty.entity";
import { termToExpiresOn } from "./warranty-expiry.util";

/**
 * Warracker's CSV column set (design decision 12), so a Warracker export and
 * our own export both import. A header matches one of these ignoring case and
 * surrounding spaces.
 */
export const WARRANTY_CSV_COLUMNS = [
  "ProductName",
  "PurchaseDate",
  "WarrantyDurationYears",
  "WarrantyDurationMonths",
  "WarrantyDurationDays",
  "ExpirationDate",
  "IsLifetime",
  "PurchasePrice",
  "SerialNumber",
  "ProductURL",
  "Vendor",
  "Tags",
  "Notes",
  "Currency",
  "ModelNumber",
  "WarrantyType",
] as const;

export type WarrantyCsvColumn = (typeof WARRANTY_CSV_COLUMNS)[number];

/** Columns a row cannot be imported without; a file lacking one is refused. */
export const WARRANTY_CSV_REQUIRED_COLUMNS: readonly WarrantyCsvColumn[] = [
  "ProductName",
  "PurchaseDate",
];

/** Read and reported as skipped: a warranty has no tags in v1. */
const READ_BUT_SKIPPED: readonly WarrantyCsvColumn[] = ["Tags"];

/** The DTO's own bounds for a term's parts (`WarrantyTermDto`). */
const TERM_BOUNDS = { years: 100, months: 1200, days: 36500 } as const;

const TEXT_LIMITS = {
  ProductName: 200,
  Vendor: 200,
  ModelNumber: 100,
  ProductURL: 500,
  Notes: 2000,
} as const;
const SERIAL_MAX_LENGTH = 100;
const PRICE_MAX = 999999999999;

const TRUTHY = new Set(["true", "1", "yes"]);
const FALSY = new Set(["false", "0", "no", ""]);

/** Which CSV column a DTO property came from, for a backstop message. */
const COLUMN_OF_PROPERTY: Record<string, WarrantyCsvColumn> = {
  name: "ProductName",
  vendorName: "Vendor",
  modelNumber: "ModelNumber",
  serialNumbers: "SerialNumber",
  warrantyKind: "WarrantyType",
  purchaseDate: "PurchaseDate",
  expiresOn: "ExpirationDate",
  term: "WarrantyDurationYears",
  isLifetime: "IsLifetime",
  purchasePrice: "PurchasePrice",
  currencyCode: "Currency",
  productUrl: "ProductURL",
  notes: "Notes",
};

/** What the mapper needs to know about the importing user. */
export interface WarrantyCsvContext {
  /** `resolveUserDefaultCurrency`: a price with a blank or unknown currency takes it. */
  defaultCurrency: string;
  /** The currency codes the user can store (the `currencies` table). */
  knownCurrencies: ReadonlySet<string>;
}

export interface WarrantyCsvRow {
  /**
   * The row's record number, the header being 1. It is the file's line
   * number unless a quoted field spans lines or a blank line precedes it
   * (the reader skips blank lines).
   */
  line: number;
  outcome: "valid" | "invalid";
  /** `ProductName` as the file gives it, so a preview can name the row. */
  name: string | null;
  /** The expiry the row resolves to (`termToExpiresOn` for a duration). */
  expiresOn: string | null;
  errors: string[];
  /** What was imported other than as written (an unknown kind or currency). */
  warnings: string[];
  /** The create payload; `null` on an invalid row. */
  warranty: CreateWarrantyDto | null;
}

export interface WarrantyCsvMapping {
  rows: WarrantyCsvRow[];
  /** Headers that are read and ignored (`Tags`) or not recognised, once each. */
  skippedColumns: string[];
  /** Required columns the header row lacks; non-empty means refuse the file. */
  missingColumns: WarrantyCsvColumn[];
}

const COLUMN_BY_KEY = new Map<string, WarrantyCsvColumn>(
  WARRANTY_CSV_COLUMNS.map((column) => [column.toLowerCase(), column]),
);

function resolveHeader(headers: readonly string[]): {
  index: Map<WarrantyCsvColumn, number>;
  skippedColumns: string[];
} {
  const index = new Map<WarrantyCsvColumn, number>();
  const skipped: string[] = [];
  for (const [i, raw] of headers.entries()) {
    const header = raw.trim();
    const column = COLUMN_BY_KEY.get(header.toLowerCase());
    if (column === undefined || index.has(column)) {
      if (header !== "" && !skipped.includes(header)) skipped.push(header);
      continue;
    }
    index.set(column, i);
    if (READ_BUT_SKIPPED.includes(column)) skipped.push(header);
  }
  return { index, skippedColumns: skipped };
}

const tooLong = (column: WarrantyCsvColumn, max: number): string =>
  tr(
    "errors.warranties.import.tooLong",
    `${column} must be at most ${max} characters`,
    { column, max },
  );

const invalidDate = (column: WarrantyCsvColumn): string =>
  tr(
    "errors.warranties.import.invalidDate",
    `${column} must be a date in YYYY-MM-DD form`,
    { column },
  );

/**
 * `SerialNumber`: a JSON array when the value starts with `[` (Warracker's
 * form for a serial holding a comma), otherwise comma-separated.
 */
export function parseSerialNumbers(
  raw: string,
): { values: string[] } | { error: string } {
  const value = raw.trim();
  if (value === "") return { values: [] };
  if (value.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = undefined;
    }
    if (
      !Array.isArray(parsed) ||
      !parsed.every(
        (item) =>
          typeof item === "string" ||
          (typeof item === "number" && Number.isFinite(item)),
      )
    ) {
      return {
        error: tr(
          "errors.warranties.import.invalidSerialJson",
          "SerialNumber starts with [ but is not a JSON array of text",
        ),
      };
    }
    return {
      values: parsed.map((item) => String(item).trim()).filter((s) => s),
    };
  }
  return {
    values: value
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== ""),
  };
}

/** `WarrantyType` onto the kind enum; `null` for a blank (the DTO default). */
export function parseWarrantyKind(raw: string): {
  kind: WarrantyKind | null;
  known: boolean;
} {
  const value = raw.trim().toLowerCase();
  if (value === "") return { kind: null, known: true };
  const bare = value.replace(/\s+warranty$/, "");
  const kind = WARRANTY_KINDS.find((k) => k === bare);
  return kind ? { kind, known: true } : { kind: "other", known: false };
}

function parseDuration(
  raw: string,
  column: WarrantyCsvColumn,
  max: number,
  errors: string[],
): number {
  if (raw === "") return 0;
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (Number.isNaN(n) || n > max) {
    errors.push(
      tr(
        "errors.warranties.import.invalidDuration",
        `${column} must be a whole number from 0 to ${max}`,
        { column, max },
      ),
    );
    return 0;
  }
  return n;
}

function parsePrice(raw: string, errors: string[]): number | null {
  if (raw === "") return null;
  if (/^-\d+(\.\d+)?$/.test(raw)) {
    errors.push(
      tr(
        "errors.warranties.import.negativePrice",
        "PurchasePrice must not be negative",
      ),
    );
    return null;
  }
  const n = /^\d+(\.\d{1,4})?$/.test(raw) ? Number(raw) : NaN;
  if (Number.isNaN(n) || n > PRICE_MAX) {
    errors.push(
      tr(
        "errors.warranties.import.invalidPrice",
        `PurchasePrice must be a number from 0 to ${PRICE_MAX} with at most 4 decimal places`,
        { max: PRICE_MAX },
      ),
    );
    return null;
  }
  return n;
}

function flattenProperties(errors: ValidationError[], prefix = ""): string[] {
  return errors.flatMap((e) =>
    e.children && e.children.length > 0
      ? flattenProperties(e.children, `${prefix}${e.property}.`)
      : [`${prefix}${e.property}`],
  );
}

/**
 * One data row to a create payload, or the reasons it cannot be one. Every
 * rule the DTO and `WarrantiesService.create` would apply is checked here with
 * a message naming the CSV column; the payload is then passed through the
 * DTO itself (`plainToInstance`, which applies `@SanitizeHtml`, and
 * `validateSync`), so a rule this function missed still refuses the row.
 */
function mapRow(
  cell: (column: WarrantyCsvColumn) => string,
  line: number,
  ctx: WarrantyCsvContext,
): WarrantyCsvRow {
  const errors: string[] = [];
  const warnings: string[] = [];
  const plain: Record<string, unknown> = {};

  const name = cell("ProductName");
  if (name === "") {
    errors.push(
      tr("errors.warranties.import.nameRequired", "ProductName is required"),
    );
  } else if (name.length > TEXT_LIMITS.ProductName) {
    errors.push(tooLong("ProductName", TEXT_LIMITS.ProductName));
  }
  plain.name = name;

  for (const [column, property] of [
    ["Vendor", "vendorName"],
    ["ModelNumber", "modelNumber"],
    ["Notes", "notes"],
  ] as const) {
    const value = cell(column);
    if (value === "") continue;
    if (value.length > TEXT_LIMITS[column]) {
      errors.push(tooLong(column, TEXT_LIMITS[column]));
    }
    plain[property] = value;
  }

  const url = cell("ProductURL");
  if (url !== "") {
    if (url.length > TEXT_LIMITS.ProductURL) {
      errors.push(tooLong("ProductURL", TEXT_LIMITS.ProductURL));
    } else if (
      !isURL(url, { require_protocol: true, protocols: ["http", "https"] })
    ) {
      errors.push(
        tr(
          "errors.warranties.import.invalidUrl",
          "ProductURL must be an http or https address",
        ),
      );
    }
    plain.productUrl = url;
  }

  const serials = parseSerialNumbers(cell("SerialNumber"));
  if ("error" in serials) {
    errors.push(serials.error);
  } else {
    if (serials.values.length > WARRANTY_MAX_SERIAL_NUMBERS) {
      errors.push(
        tr(
          "errors.warranties.import.tooManySerials",
          `SerialNumber holds ${serials.values.length} values; at most ${WARRANTY_MAX_SERIAL_NUMBERS} are allowed`,
          {
            count: serials.values.length,
            max: WARRANTY_MAX_SERIAL_NUMBERS,
          },
        ),
      );
    }
    if (serials.values.some((s) => s.length > SERIAL_MAX_LENGTH)) {
      errors.push(
        tr(
          "errors.warranties.import.serialTooLong",
          `Each serial number must be at most ${SERIAL_MAX_LENGTH} characters`,
          { max: SERIAL_MAX_LENGTH },
        ),
      );
    }
    if (serials.values.length > 0) plain.serialNumbers = serials.values;
  }

  const rawKind = cell("WarrantyType");
  const kind = parseWarrantyKind(rawKind);
  if (!kind.known) {
    warnings.push(
      tr(
        "errors.warranties.import.unknownWarrantyType",
        `WarrantyType "${rawKind}" is not manufacturer, extended, store or other; imported as other`,
        { value: rawKind },
      ),
    );
  }
  if (kind.kind !== null) plain.warrantyKind = kind.kind;

  // Purchase date and the one expiry source.
  const purchaseDate = cell("PurchaseDate");
  const purchaseDateValid = isCalendarDate(purchaseDate);
  if (purchaseDate === "") {
    errors.push(
      tr(
        "errors.warranties.import.purchaseDateRequired",
        "PurchaseDate is required",
      ),
    );
  } else if (!purchaseDateValid) {
    errors.push(invalidDate("PurchaseDate"));
  }
  plain.purchaseDate = purchaseDate;

  const expirationDate = cell("ExpirationDate");
  if (expirationDate !== "" && !isCalendarDate(expirationDate)) {
    errors.push(invalidDate("ExpirationDate"));
  }
  const term: { years: number; months: number; days: number } = {
    years: parseDuration(
      cell("WarrantyDurationYears"),
      "WarrantyDurationYears",
      TERM_BOUNDS.years,
      errors,
    ),
    months: parseDuration(
      cell("WarrantyDurationMonths"),
      "WarrantyDurationMonths",
      TERM_BOUNDS.months,
      errors,
    ),
    days: parseDuration(
      cell("WarrantyDurationDays"),
      "WarrantyDurationDays",
      TERM_BOUNDS.days,
      errors,
    ),
  };
  const hasTerm = term.years + term.months + term.days > 0;

  const rawLifetime = cell("IsLifetime").toLowerCase();
  const isLifetime = TRUTHY.has(rawLifetime);
  if (!isLifetime && !FALSY.has(rawLifetime)) {
    errors.push(
      tr(
        "errors.warranties.import.invalidLifetime",
        "IsLifetime must be true, false, yes, no, 1 or 0",
      ),
    );
  }

  // `ExpirationDate` is the stored fact (decision 1) and wins over a duration
  // beside it, which Warracker's export writes on every row; lifetime beside
  // either is a contradiction the row cannot resolve.
  const hasDate = expirationDate !== "";
  let expiresOn: string | null = null;
  if (isLifetime && (hasDate || hasTerm)) {
    errors.push(
      tr(
        "errors.warranties.import.lifetimeWithExpiry",
        "IsLifetime is true, but the row also gives ExpirationDate or a WarrantyDuration; fill only one",
      ),
    );
  } else if (isLifetime) {
    plain.isLifetime = true;
  } else if (hasDate) {
    plain.expiresOn = expirationDate;
    expiresOn = isCalendarDate(expirationDate) ? expirationDate : null;
    if (hasTerm) {
      const derived =
        expiresOn !== null && purchaseDateValid
          ? termToExpiresOn(purchaseDate, term)
          : null;
      warnings.push(
        derived === null || derived === expiresOn
          ? tr(
              "errors.warranties.import.durationIgnored",
              "ExpirationDate was used; the WarrantyDuration columns beside it were ignored",
            )
          : tr(
              "errors.warranties.import.durationDisagrees",
              `ExpirationDate ${expirationDate} was used; the WarrantyDuration columns give ${derived}, which disagrees`,
              { expiresOn: expirationDate, derived },
            ),
      );
    }
  } else if (hasTerm) {
    plain.term = term;
    if (purchaseDateValid) {
      try {
        expiresOn = termToExpiresOn(purchaseDate, term);
      } catch {
        errors.push(
          tr(
            "errors.warranties.invalidTerm",
            "A warranty term must be longer than zero",
          ),
        );
      }
    }
  } else {
    errors.push(
      tr(
        "errors.warranties.import.noExpirySource",
        "Fill ExpirationDate, a WarrantyDuration column or IsLifetime",
      ),
    );
  }
  if (expiresOn !== null && purchaseDateValid && expiresOn < purchaseDate) {
    errors.push(
      tr(
        "errors.warranties.expiresBeforePurchase",
        "A warranty cannot expire before its purchase date",
      ),
    );
  }

  // Price and its currency (decision 12, missing-data policy).
  const price = parsePrice(cell("PurchasePrice"), errors);
  const rawCurrency = cell("Currency").toUpperCase();
  if (cell("PurchasePrice") === "") {
    if (rawCurrency !== "") {
      errors.push(
        tr(
          "errors.warranties.import.currencyWithoutPrice",
          "Currency is set but PurchasePrice is blank",
        ),
      );
    }
  } else if (price !== null) {
    let currency = rawCurrency;
    if (rawCurrency === "") {
      currency = ctx.defaultCurrency;
    } else if (!ctx.knownCurrencies.has(rawCurrency)) {
      currency = ctx.defaultCurrency;
      warnings.push(
        tr(
          "errors.warranties.import.unknownCurrency",
          `Currency "${rawCurrency}" is not known; ${ctx.defaultCurrency} was used`,
          { value: rawCurrency, currency: ctx.defaultCurrency },
        ),
      );
    }
    plain.purchasePrice = price;
    plain.currencyCode = currency;
  }

  let warranty: CreateWarrantyDto | null = null;
  if (errors.length === 0) {
    const instance = plainToInstance(CreateWarrantyDto, plain);
    const violations = validateSync(instance, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    for (const property of flattenProperties(violations)) {
      const field = COLUMN_OF_PROPERTY[property.split(".")[0]] ?? property;
      errors.push(
        tr("errors.warranties.import.invalidField", `${field} is not valid`, {
          field,
        }),
      );
    }
    if (errors.length === 0) warranty = instance;
  }

  return {
    line,
    outcome: errors.length === 0 ? "valid" : "invalid",
    name: name === "" ? null : name,
    expiresOn: errors.length === 0 ? expiresOn : null,
    errors,
    warnings,
    warranty,
  };
}

/**
 * A parsed CSV table (header row first, as `parseCsvRows` returns it) to one
 * verdict per data row. Pure: the preview and the commit both call it, so
 * they cannot disagree about a row (WTY-006).
 */
export function mapWarrantyCsv(
  table: readonly string[][],
  ctx: WarrantyCsvContext,
): WarrantyCsvMapping {
  const [headers = [], ...data] = table;
  const { index, skippedColumns } = resolveHeader(headers);
  const missingColumns = WARRANTY_CSV_REQUIRED_COLUMNS.filter(
    (column) => !index.has(column),
  );
  if (missingColumns.length > 0) {
    return { rows: [], skippedColumns, missingColumns };
  }

  const rows = data.map((cells, i) => {
    const cell = (column: WarrantyCsvColumn): string => {
      const at = index.get(column);
      return at === undefined ? "" : (cells[at] ?? "").trim();
    };
    return mapRow(cell, i + 2, ctx);
  });
  return { rows, skippedColumns, missingColumns };
}
