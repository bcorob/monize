import { brandLogoColumns } from "./brand-logo.columns";

describe("brandLogoColumns", () => {
  it("stores the bytes and raises the flag for a fetched icon", () => {
    const data = Buffer.from([1, 2, 3]);
    const columns = brandLogoColumns({ data, contentType: "image/png" });

    expect(columns).toEqual({
      logoData: data,
      logoContentType: "image/png",
      hasLogo: true,
      logoFetchedAt: expect.any(Date),
    });
  });

  it("clears the bytes and the flag together when the fetch failed", () => {
    // The flag is what every list read answers "is there an icon?" with, and
    // the bytes are what the logo route serves. Leaving a stale icon behind a
    // false flag (or the reverse) makes those two disagree.
    const columns = brandLogoColumns(null);

    expect(columns.logoData).toBeNull();
    expect(columns.logoContentType).toBeNull();
    expect(columns.hasLogo).toBe(false);
  });

  it("stamps the attempt on failure as well as on success", () => {
    // logoFetchedAt records that we looked, not that we found something --
    // a null means the favicon has never been looked for at all.
    expect(brandLogoColumns(null).logoFetchedAt).toBeInstanceOf(Date);
  });

  it("returns a fresh object rather than mutating a shared one", () => {
    const first = brandLogoColumns(null);
    const second = brandLogoColumns({
      data: Buffer.from([9]),
      contentType: "image/x-icon",
    });

    expect(first.hasLogo).toBe(false);
    expect(second.hasLogo).toBe(true);
    expect(first).not.toBe(second);
  });
});
