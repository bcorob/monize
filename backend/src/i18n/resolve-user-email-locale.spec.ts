import { Repository } from "typeorm";
import { UserPreference } from "../users/entities/user-preference.entity";
import {
  resolveUserEmailFormats,
  resolveUserEmailLocale,
} from "./resolve-user-email-locale";

describe("resolveUserEmailLocale", () => {
  const makeRepo = (language: string | null | undefined) =>
    ({
      findOne: jest
        .fn()
        .mockResolvedValue(
          language === undefined ? null : { userId: "u1", language },
        ),
    }) as unknown as Repository<UserPreference> & {
      findOne: jest.Mock;
    };

  it("returns the recipient's stored concrete language", async () => {
    const repo = makeRepo("fr");
    await expect(resolveUserEmailLocale(repo, "u1")).resolves.toBe("fr");
    expect(repo.findOne).toHaveBeenCalledWith({ where: { userId: "u1" } });
  });

  it("returns a regional variant when stored", async () => {
    const repo = makeRepo("pt-BR");
    await expect(resolveUserEmailLocale(repo, "u1")).resolves.toBe("pt-BR");
  });

  it("falls back to the default locale when the user has no preferences row", async () => {
    const repo = makeRepo(undefined);
    await expect(resolveUserEmailLocale(repo, "u1")).resolves.toBe("en");
  });

  it("ignores the 'browser' follow-the-browser sentinel", async () => {
    const repo = makeRepo("browser");
    // No HTTP context in a unit test, so this resolves to the default locale.
    await expect(resolveUserEmailLocale(repo, "u1")).resolves.toBe("en");
  });

  it("ignores an unsupported stored value", async () => {
    const repo = makeRepo("klingon");
    await expect(resolveUserEmailLocale(repo, "u1")).resolves.toBe("en");
  });

  it("does not query when there is no recipient user id", async () => {
    const repo = makeRepo("fr");
    await expect(resolveUserEmailLocale(repo, null)).resolves.toBe("en");
    expect(repo.findOne).not.toHaveBeenCalled();
  });
});

describe("resolveUserEmailFormats", () => {
  const makeRepo = (row: Partial<UserPreference> | null) =>
    ({
      findOne: jest.fn().mockResolvedValue(row),
    }) as unknown as Repository<UserPreference> & { findOne: jest.Mock };

  /**
   * The number preference is INDEPENDENT of the language (INV-DISPLAY-001), so
   * the pair has to survive the trip together: resolving only the language and
   * formatting from it is what put `zl18,812.71` inside Polish copy in #1316.
   */
  it("returns the stored numberFormat beside a language it accepts", async () => {
    const repo = makeRepo({ language: "en", numberFormat: "pl-PL" });
    await expect(resolveUserEmailFormats(repo, "u1")).resolves.toEqual({
      lang: "en",
      numberFormat: "pl-PL",
    });
  });

  /**
   * `"browser"` and an unsupported language both mean "no concrete stored
   * language", and neither says anything about the NUMBER preference -- so the
   * language falls back while the numberFormat is still reported. Collapsing
   * the two would silently drop the preference of a reader whose UI language is
   * one this deployment does not ship.
   */
  it.each(["browser", "klingon"])(
    "keeps the numberFormat when the language falls back (%s)",
    async (language) => {
      const repo = makeRepo({ language, numberFormat: "de-DE" });
      await expect(resolveUserEmailFormats(repo, "u1")).resolves.toEqual({
        lang: "en",
        numberFormat: "de-DE",
      });
    },
  );

  /**
   * Returned AS STORED, sentinel included: `numberFormatterFor` is what knows
   * that `"browser"` cannot be resolved on a server and means "use the
   * language". Resolving it here would put that rule in two places.
   */
  it("passes the 'browser' numberFormat sentinel through unresolved", async () => {
    const repo = makeRepo({ language: "pl", numberFormat: "browser" });
    await expect(resolveUserEmailFormats(repo, "u1")).resolves.toEqual({
      lang: "pl",
      numberFormat: "browser",
    });
  });

  it("reports no numberFormat when the user has no preferences row", async () => {
    const repo = makeRepo(null);
    await expect(resolveUserEmailFormats(repo, "u1")).resolves.toEqual({
      lang: "en",
      numberFormat: null,
    });
  });

  it("does not query when there is no recipient user id", async () => {
    const repo = makeRepo({ language: "fr", numberFormat: "fr-FR" });
    await expect(resolveUserEmailFormats(repo, null)).resolves.toEqual({
      lang: "en",
      numberFormat: null,
    });
    expect(repo.findOne).not.toHaveBeenCalled();
  });
});
