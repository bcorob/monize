import { readFileSync } from "fs";
import { join } from "path";
import { BondFetch } from "../../../bond-adapter";

/** Test support: the saved pages and letters, and a fetch that serves them. */
const fixture = (name: string) =>
  readFileSync(join(__dirname, "fixtures", name), "utf8");

export const pageFixture = (code: string) =>
  fixture(`${code.toLowerCase()}-page.html`);
export const letterFixture = (code: string) =>
  fixture(`${code.toLowerCase()}-letter.txt`);

export const PDF_PREFIX = "%PDF-1.7\n";
const bytes = (text: string) => new TextEncoder().encode(text);

/** What `extractPdfText` is mocked to do: the fake PDF is the magic plus the letter text. */
export const fakePdfText = (body: Uint8Array) =>
  new TextDecoder().decode(body).slice(PDF_PREFIX.length);

export function letterHref(page: string): string {
  const m = /href="(\/media_files\/[^"]+\.pdf)"/.exec(page);
  if (!m) throw new Error("fixture page has no letter link");
  return m[1];
}

export const SITE = "https://www.obligacjeskarbowe.pl";

export interface Served {
  readonly status: number;
  readonly body: Uint8Array;
  readonly url?: string;
}

/** A fetch serving one series: its page at the series URL, its letter at the page's link. */
export function seriesRoutes(
  code: string,
  slug: string,
  overrides: { page?: string; letter?: string } = {},
): Record<string, Served> {
  const page = overrides.page ?? pageFixture(code);
  const letter = overrides.letter ?? letterFixture(code);
  return {
    [`${SITE}/oferta-obligacji/${slug}/${code.toLowerCase()}/`]: {
      status: 200,
      body: bytes(page),
    },
    [`${SITE}${letterHref(pageFixture(code))}`]: {
      status: 200,
      body: bytes(PDF_PREFIX + letter),
    },
  };
}

export function fakeFetch(
  table: Record<string, Served>,
): jest.MockedFunction<BondFetch> {
  return jest.fn(async (url: string) => {
    const hit = table[url];
    if (!hit) throw new Error(`unexpected url ${url}`);
    return hit;
  });
}

export const SLUGS: Record<string, string> = {
  OTS: "obligacje-3-miesieczne-ots",
  ROR: "obligacje-roczne-ror",
  DOR: "obligacje-2-letnie-dor",
  TOS: "obligacje-3-letnie-tos",
  COI: "obligacje-4-letnie-coi",
  ROS: "obligacje-6-letnie-ros",
  EDO: "obligacje-10-letnie-edo",
  ROD: "obligacje-12-letnie-rod",
};
