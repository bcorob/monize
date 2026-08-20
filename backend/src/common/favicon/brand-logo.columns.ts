import { FetchedLogo } from "./favicon.service";

/**
 * The four columns a table carries to cache a brand favicon. Institutions and
 * payees both have them, with identical semantics:
 *
 *  - `logoData` / `logoContentType` are the bytes, never selected by default
 *    and never serialized -- they leave only through that entity's own
 *    `GET .../:id/logo` route.
 *  - `hasLogo` is what every read path answers "is there an icon?" with,
 *    because the bytes are not loaded on a list query.
 *  - `logoFetchedAt` stamps the last *attempt*, success or not, so a null
 *    means the favicon has never been looked for.
 */
export interface BrandLogoColumns {
  logoData: Buffer | null;
  logoContentType: string | null;
  hasLogo: boolean;
  logoFetchedAt: Date | null;
}

/**
 * The column values for a fetch result. A failed fetch (`null`) clears the
 * cached bytes rather than keeping a stale icon beside a website that no
 * longer resolves -- so the flag and the bytes can never disagree -- and still
 * stamps the attempt.
 *
 * Returns a fresh object rather than mutating an entity, so a caller building
 * a partial column update (`repo.update`) and a caller assigning onto a loaded
 * entity can both use it.
 */
export function brandLogoColumns(logo: FetchedLogo | null): BrandLogoColumns {
  return logo
    ? {
        logoData: logo.data,
        logoContentType: logo.contentType,
        hasLogo: true,
        logoFetchedAt: new Date(),
      }
    : {
        logoData: null,
        logoContentType: null,
        hasLogo: false,
        logoFetchedAt: new Date(),
      };
}
