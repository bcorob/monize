import { CatalogEntry } from "../../bond-adapter";
import { BenchmarkData } from "../../domain/benchmark";
import { BondTerms, parseBondTerms } from "../../domain/bond-terms";
import { EMPTY_CALENDAR_REGISTRY } from "../../domain/calendar-registry";
import { BondEngineInput } from "../../engine/bond-engine-types";
import { registerPolishCalendars } from ".";
import coi from "./fixtures/series/coi1030.terms.json";
import dor from "./fixtures/series/dor1028.terms.json";
import edo from "./fixtures/series/edo1036.terms.json";
import ots from "./fixtures/series/ots0127.terms.json";
import rod from "./fixtures/series/rod1038.terms.json";
import ror from "./fixtures/series/ror1027.terms.json";
import ros from "./fixtures/series/ros1032.terms.json";
import tos from "./fixtures/series/tos1029.terms.json";
import edo0423 from "./fixtures/edo0423.terms.json";
import edo0524 from "./fixtures/edo0524.terms.json";
import ror0623 from "./fixtures/ror0623.terms.json";

export type ManifestName =
  | "tos1029"
  | "ror1027"
  | "coi1030"
  | "edo1036"
  | "dor1028"
  | "ros1032"
  | "rod1038"
  | "ots0127";

/**
 * Terms of historical series rebuilt from their own issue letters, for the
 * golden cases that reproduce the Ministry's published examples. They are not
 * among `ManifestName`'s series.
 */
export type FixtureName = "ror0623" | "edo0524" | "edo0423";

const FIXTURE_DOCUMENTS: Record<FixtureName, unknown> = {
  ror0623,
  edo0524,
  edo0423,
};

const DOCUMENTS: Record<ManifestName, unknown> = {
  tos1029: tos,
  ror1027: ror,
  coi1030: coi,
  edo1036: edo,
  dor1028: dor,
  ros1032: ros,
  rod1038: rod,
  ots0127: ots,
};

/**
 * The curated October 2026 series as stored terms entries (version 1, the date
 * of their issue letters): what a person's fetch would have stored. Test
 * fixtures only; the adapter ships templates, never a series.
 */
export const FIXTURE_CATALOG: readonly CatalogEntry[] = [
  "ots0127",
  "tos1029",
  "ror1027",
  "dor1028",
  "coi1030",
  "edo1036",
  "ros1032",
  "rod1038",
].map((name) => ({
  termsVersion: 1,
  publishedAt: "2026-09-21",
  terms: DOCUMENTS[name as ManifestName],
}));

export function manifest(name: ManifestName): BondTerms {
  return parseBondTerms(DOCUMENTS[name]);
}

export function manifestDocument(name: ManifestName): Record<string, any> {
  return JSON.parse(JSON.stringify(DOCUMENTS[name]));
}

export const polishCalendars = registerPolishCalendars(EMPTY_CALENDAR_REGISTRY);

/** A lot of one bond bought on `purchaseDate`, with no announced rate and no reference data. */
export function lotInput(
  name: ManifestName,
  purchaseDate: string,
  asOf: string,
  overrides: Partial<BondEngineInput> = {},
): BondEngineInput {
  return {
    terms: manifest(name),
    termsVersion: 1,
    announcedRates: new Map(),
    benchmarks: new Map<string, BenchmarkData>(),
    calendars: polishCalendars,
    lot: { purchaseDate, quantity: 1 },
    asOf,
    ...overrides,
  };
}

/** `lotInput` over the terms of a historical fixture series (never a catalog series). */
export function fixtureLotInput(
  name: FixtureName,
  purchaseDate: string,
  asOf: string,
  overrides: Partial<BondEngineInput> = {},
): BondEngineInput {
  return {
    ...lotInput("ror1027", purchaseDate, asOf, overrides),
    terms: parseBondTerms(FIXTURE_DOCUMENTS[name]),
    ...overrides,
  };
}
