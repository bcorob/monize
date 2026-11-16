import { SeriesFetchError } from "../../../bond-adapter";
import {
  fetchCurrentSeries,
  OFFER_URL,
  parseCurrentOffer,
} from "./current-offer";
import { SITE } from "./fixture-helpers";
import { readFileSync } from "fs";
import { join } from "path";

const offerPage = () =>
  readFileSync(join(__dirname, "fixtures", "home-offer.html"), "utf8");

describe("parseCurrentOffer (saved home page)", () => {
  it("lists the eight series on sale and ignores the account links", () => {
    expect(parseCurrentOffer(offerPage())).toEqual([
      "COI1030",
      "DOR1028",
      "EDO1036",
      "OTS0127",
      "ROD1038",
      "ROR1027",
      "ROS1032",
      "TOS1029",
    ]);
  });

  it("skips a link whose product slug disagrees with its code", () => {
    const html =
      '<a href="/oferta-obligacji/obligacje-roczne-ror/edo1036/">x</a>' +
      '<a href="/oferta-obligacji/obligacje-roczne-ror/ror1027/">y</a>';
    expect(parseCurrentOffer(html)).toEqual(["ROR1027"]);
  });

  it("skips a code that is not a series code and a premium series", () => {
    const html =
      '<a href="/oferta-obligacji/obligacje-premiowe/pos0323/">x</a>' +
      '<a href="/oferta-obligacji/obligacje-roczne-ror/ror1327/">y</a>' +
      '<a href="/oferta-obligacji/obligacje-roczne-ror/ror1027/">z</a>';
    expect(parseCurrentOffer(html)).toEqual(["ROR1027"]);
  });

  it("answers each code once", () => {
    const link = '<a href="/oferta-obligacji/obligacje-roczne-ror/ror1027/">';
    expect(parseCurrentOffer(link + link)).toEqual(["ROR1027"]);
  });

  it("refuses a page that lists no series", () => {
    expect.assertions(2);
    try {
      parseCurrentOffer("<html><body>nothing</body></html>");
    } catch (error) {
      expect(error).toBeInstanceOf(SeriesFetchError);
      expect((error as SeriesFetchError).code).toBe("SOURCE_FORMAT_CHANGED");
    }
  });
});

describe("fetchCurrentSeries", () => {
  it("reads the home page of the issuer", async () => {
    expect(OFFER_URL).toBe(`${SITE}/`);
    const get = jest.fn(async () => ({
      status: 200,
      body: new TextEncoder().encode(offerPage()),
      url: OFFER_URL,
    }));
    await expect(fetchCurrentSeries(get)).resolves.toContain("EDO1036");
    expect(get).toHaveBeenCalledWith(OFFER_URL);
  });

  it("refuses a redirecting answer as the source being unavailable", async () => {
    const get = jest.fn(async () => ({
      status: 302,
      body: new Uint8Array(),
      url: OFFER_URL,
    }));
    await expect(fetchCurrentSeries(get)).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
    });
  });
});
