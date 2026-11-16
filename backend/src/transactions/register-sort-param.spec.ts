import { BadRequestException } from "@nestjs/common";
import { parseTransactionSort } from "./register-sort-param";
import { TRANSACTION_SORT_FIELDS } from "./register-order";

/**
 * The boundary between an untrusted query string and the ORDER BY the register
 * runs. The property under test is not "it maps strings to strings" -- it is
 * that nothing but a member of the allowlist ever reaches the query, whatever
 * shape the caller sent.
 */
describe("parseTransactionSort", () => {
  it("defaults to the register's own order when neither is given", () => {
    expect(parseTransactionSort(undefined, undefined)).toEqual({
      sortBy: "date",
      sortDirection: "DESC",
    });
    // An empty string is what a browser sends for `?sortBy=`; it is absence,
    // not a field named "".
    expect(parseTransactionSort("", "")).toEqual({
      sortBy: "date",
      sortDirection: "DESC",
    });
  });

  it.each(TRANSACTION_SORT_FIELDS)("accepts the sort field %s", (field) => {
    expect(parseTransactionSort(field, "asc")).toEqual({
      sortBy: field,
      sortDirection: "ASC",
    });
  });

  it("accepts either case and surrounding space, in the list's own spelling", () => {
    expect(parseTransactionSort(" Amount ", " DESC ")).toEqual({
      sortBy: "amount",
      sortDirection: "DESC",
    });
    // `refNumber` is the field a lowercasing parser drops on the floor: the
    // canonical spelling is not all lower case, so the value it returns has to
    // come from the list rather than from the caller.
    expect(parseTransactionSort("REFNUMBER", "asc").sortBy).toBe("refNumber");
    expect(parseTransactionSort("refNumber", "asc").sortBy).toBe("refNumber");
  });

  it("rejects a field the register does not offer, naming the ones it does", () => {
    // `tags` is the tempting one: it is a column on the screen, and ordering
    // by it would duplicate rows on the paginated-join path.
    expect(() => parseTransactionSort("tags", undefined)).toThrow(
      BadRequestException,
    );
    try {
      parseTransactionSort("tags", undefined);
    } catch (error) {
      expect((error as BadRequestException).message).toContain("date");
      expect((error as BadRequestException).message).toContain("amount");
    }
  });

  it("rejects a direction that is not asc or desc", () => {
    expect(() => parseTransactionSort("date", "sideways")).toThrow(
      BadRequestException,
    );
  });

  it("rejects a repeated query key rather than coercing it", () => {
    // Express hands a repeated key over as an array. `["date","amount"]`
    // has no toLowerCase, and an array whose single element is a valid field
    // would pass a naive `includes` check and reach the ORDER BY.
    expect(() => parseTransactionSort(["date", "amount"], undefined)).toThrow(
      BadRequestException,
    );
    expect(() => parseTransactionSort(["date"], undefined)).toThrow(
      BadRequestException,
    );
    expect(() => parseTransactionSort("date", ["asc"])).toThrow(
      BadRequestException,
    );
    expect(() =>
      parseTransactionSort({ toLowerCase: () => "date" }, undefined),
    ).toThrow(BadRequestException);
  });
});
