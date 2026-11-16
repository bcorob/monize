import {
  RECEIPT_SEARCH_PARAM_COUNT,
  RECEIPT_SELECTION_PARAM_COUNT,
  receiptSearchClause,
  receiptSearchParams,
  receiptSelectionClause,
} from "./receipt-filter";

describe("receiptSelectionClause", () => {
  it("binds every field, nulls and empty lists when the filter is empty", () => {
    const { sql, params } = receiptSelectionClause({}, 3);
    expect(params).toEqual([
      null,
      null,
      null,
      [],
      [],
      [],
      null,
      null,
      null,
      "all",
      null,
      null,
    ]);
    expect(params).toHaveLength(RECEIPT_SELECTION_PARAM_COUNT);
    expect(sql).toContain("r.status = $3::varchar");
    expect(sql).toContain("r.from_domain = $4::varchar");
    expect(sql).toContain("r.from_domain LIKE $5::varchar ESCAPE '\\'");
    expect(sql).toContain("NOT (r.status = ANY($6::varchar[]))");
    expect(sql).toContain("r.from_domain = ANY($7::varchar[])");
    expect(sql).toContain("unnest($8::varchar[])");
    expect(sql).toContain("$9::date");
    expect(sql).toContain("$10::date");
    expect(sql).toContain("r.subject ILIKE $11::varchar");
    expect(sql).toContain("$12::varchar IN ('all', 'subject')");
    expect(sql).toContain("$13::date");
    expect(sql).toContain("$14::date");
  });

  it("has as many search values as the selection counts for them", () => {
    expect(RECEIPT_SELECTION_PARAM_COUNT).toBe(8 + RECEIPT_SEARCH_PARAM_COUNT);
    const { params } = receiptSelectionClause(
      { search: "x", searchIn: "body", dateFrom: "2026-02-01" },
      1,
    );
    expect(params.slice(8)).toEqual(["%x%", "body", "2026-02-01", null]);
  });

  it("numbers its parameters from the index it is given", () => {
    const { sql } = receiptSelectionClause({}, 20);
    expect(sql).toContain("$20::varchar");
    expect(sql).toContain("$27::date");
    expect(sql).not.toContain("$3::");
  });

  it("reads status, domain and the dates as bind values, never in the text", () => {
    const { sql, params } = receiptSelectionClause(
      {
        status: "review",
        domain: " Shop.Example.com ",
        receivedFrom: "2026-01-01",
        receivedTo: "2026-01-31",
      },
      2,
    );
    expect(params).toEqual([
      "review",
      "shop.example.com",
      "%.shop.example.com",
      [],
      [],
      [],
      "2026-01-01",
      "2026-01-31",
      null,
      "all",
      null,
      null,
    ]);
    expect(sql).not.toContain("shop.example.com");
    expect(sql).not.toContain("2026-01");
  });

  it("takes the days inclusively in UTC", () => {
    const { sql } = receiptSelectionClause({}, 1);
    expect(sql).toContain(
      "r.received_at >= ($7::date)::timestamp AT TIME ZONE 'UTC'",
    );
    expect(sql).toContain(
      "r.received_at < (($8::date) + 1)::timestamp AT TIME ZONE 'UTC'",
    );
  });

  it("excludes states and domains with their sub-domains, LIKE characters taken literally", () => {
    const { params } = receiptSelectionClause(
      {
        excludeStatuses: ["ignored", "review"],
        excludeDomains: [
          "A_b.example.com",
          " gmail.com ",
          "gmail.com",
          "100%.io",
        ],
      },
      1,
    );
    expect(params[3]).toEqual(["ignored", "review"]);
    expect(params[4]).toEqual(["a_b.example.com", "gmail.com", "100%.io"]);
    expect(params[5]).toEqual([
      "%.a\\_b.example.com",
      "%.gmail.com",
      "%.100\\%.io",
    ]);
  });
});

describe("receiptSearchParams and receiptSearchClause", () => {
  it("binds a trimmed, escaped, case-preserved LIKE pattern", () => {
    expect(receiptSearchParams({ search: "  100%_a\\b " })).toEqual([
      "%100\\%\\_a\\\\b%",
      "all",
      null,
      null,
    ]);
  });

  it.each([undefined, "", "   ", "\t\n"])(
    "treats the search %j as none",
    (search) => {
      expect(receiptSearchParams({ search })[0]).toBeNull();
    },
  );

  it("treats blank dates as none and defaults the field to all", () => {
    expect(
      receiptSearchParams({ searchIn: undefined, dateFrom: "", dateTo: "" }),
    ).toEqual([null, "all", null, null]);
  });

  it.each(["all", "subject", "sender", "body"] as const)(
    "binds the field %s",
    (searchIn) => {
      expect(receiptSearchParams({ search: "a", searchIn })[1]).toBe(searchIn);
    },
  );

  it("searches the subject, the sender columns and the body, escaping with a backslash", () => {
    const sql = receiptSearchClause(5);
    expect(sql).toContain("$5::varchar IS NULL");
    expect(sql).toContain("$6::varchar IN ('all', 'subject')");
    expect(sql).toContain("r.subject ILIKE $5::varchar ESCAPE '\\'");
    expect(sql).toContain("$6::varchar IN ('all', 'sender')");
    expect(sql).toContain("r.from_address ILIKE $5::varchar ESCAPE '\\'");
    expect(sql).toContain("r.from_domain ILIKE $5::varchar ESCAPE '\\'");
    expect(sql).toContain("r.forwarded_by ILIKE $5::varchar ESCAPE '\\'");
    expect(sql).toContain("$6::varchar IN ('all', 'body')");
    expect(sql).toContain("r.body_text ILIKE $5::varchar ESCAPE '\\'");
  });

  it("takes the days inclusively in UTC on the effective date", () => {
    const sql = receiptSearchClause(1);
    expect(sql).toContain(
      "COALESCE(r.original_sent_at, r.received_at) >= ($3::date)::timestamp AT TIME ZONE 'UTC'",
    );
    expect(sql).toContain(
      "COALESCE(r.original_sent_at, r.received_at) < (($4::date) + 1)::timestamp AT TIME ZONE 'UTC'",
    );
  });
});
