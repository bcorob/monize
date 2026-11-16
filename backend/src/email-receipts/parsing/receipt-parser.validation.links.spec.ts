import { validateReceiptParserDefinition } from "./receipt-parser.validation";
import {
  ALLEGRO_PAY_COMPONENT_DEFINITION,
  ALLEGRO_PAY_SETTLEMENT_DEFINITION,
} from "./fixtures/allegro-pay-mails";

/** Linked receipts (spec "linked receipts" 2.3): one case per validation code. */

const errorsOf = (input: unknown) => {
  const result = validateReceiptParserDefinition(input);
  if (result.ok) throw new Error("expected a refusal");
  return result.errors;
};

const codesAt = (input: unknown, path: string): string[] =>
  errorsOf(input)
    .filter((error) => error.path === path)
    .map((error) => error.code);

const component = (): Record<string, unknown> => ({
  version: 2,
  role: "component",
  linkKey: ["Allegro Pay {link}"],
  total: ["Total: {amount}"],
});

const settlement = (): Record<string, unknown> => ({
  version: 2,
  role: "settlement",
  items: {
    patterns: ["{link} {name} {amount} {instalment}"],
  },
});

describe("validateReceiptParserDefinition: roles and links", () => {
  it("accepts a component and a settlement and keeps role, linkKey and link", () => {
    expect(
      validateReceiptParserDefinition(ALLEGRO_PAY_COMPONENT_DEFINITION),
    ).toEqual({ ok: true, definition: ALLEGRO_PAY_COMPONENT_DEFINITION });
    expect(
      validateReceiptParserDefinition(ALLEGRO_PAY_SETTLEMENT_DEFINITION),
    ).toEqual({ ok: true, definition: ALLEGRO_PAY_SETTLEMENT_DEFINITION });
  });

  it("accepts the three roles and a profile with no role", () => {
    for (const role of ["standalone", "component", "settlement"]) {
      const input: Record<string, unknown> = {
        version: 2,
        role,
        ...(role === "component" ? { linkKey: ["Key {link}"] } : {}),
      };
      expect(validateReceiptParserDefinition(input).ok).toBe(true);
    }
  });

  it("role_invalid: a role that is not one of the three, whatever its type", () => {
    expect(codesAt({ version: 2, role: "parent" }, "role")).toEqual([
      "role_invalid",
    ]);
    expect(codesAt({ version: 2, role: 5 }, "role")).toEqual(["role_invalid"]);
  });

  it("link_key_requires_component: linkKey on another role or none", () => {
    for (const role of [undefined, "standalone", "settlement"]) {
      const input = { ...component(), role };
      expect(codesAt(input, "linkKey")).toEqual([
        "link_key_requires_component",
      ]);
    }
  });

  it("link_key_missing: a component without a linkKey or with an empty one", () => {
    expect(codesAt({ version: 2, role: "component" }, "linkKey")).toEqual([
      "link_key_missing",
    ]);
    expect(
      codesAt({ version: 2, role: "component", linkKey: [] }, "linkKey"),
    ).toEqual(["link_key_missing"]);
  });

  it("reads linkKey like orderId with the {link} capture, labelled entries included", () => {
    expect(
      codesAt({ ...component(), linkKey: ["Key {orderid}"] }, "linkKey[0]"),
    ).toEqual(["capture_not_allowed", "capture_missing"]);
    expect(codesAt({ ...component(), linkKey: ["Key"] }, "linkKey[0]")).toEqual(
      ["capture_missing"],
    );
    expect(
      validateReceiptParserDefinition({
        ...component(),
        linkKey: [{ label: "Contract", value: "{link}", within: 2 }],
      }).ok,
    ).toBe(true);
  });

  it("link_capture_requires_settlement: {link} or {instalment} in an item pattern", () => {
    for (const role of [undefined, "standalone", "component"]) {
      for (const capture of ["{link}", "{instalment}"]) {
        const input = {
          version: 2,
          role,
          ...(role === "component" ? { linkKey: ["Key {link}"] } : {}),
          items: { patterns: [`{name} {amount} ${capture}`] },
        };
        expect(codesAt(input, "items.patterns[0]")).toEqual([
          "link_capture_requires_settlement",
        ]);
      }
    }
  });

  it("link_capture_requires_settlement: {link} or {instalment} in a record step", () => {
    const input = {
      version: 2,
      items: {
        record: [{ line: "{name}" }, { line: ["{amount}", "{link} {amount}"] }],
      },
    };
    expect(codesAt(input, "items.record[1].line[1]")).toEqual([
      "link_capture_requires_settlement",
    ]);
    const single = {
      version: 2,
      items: { record: [{ line: "{name} {instalment} {amount}" }] },
    };
    expect(codesAt(single, "items.record[0].line")).toEqual([
      "link_capture_requires_settlement",
    ]);
  });

  it("accepts neither link capture in a settlement item, and neither is required", () => {
    expect(
      validateReceiptParserDefinition({
        version: 2,
        role: "settlement",
        items: { patterns: ["{name} {amount}"] },
      }).ok,
    ).toBe(true);
    expect(validateReceiptParserDefinition(settlement()).ok).toBe(true);
  });

  it("never allows {link} in items.single.name", () => {
    const input = {
      version: 2,
      role: "settlement",
      items: { single: { name: "{name} {link}" } },
    };
    expect(codesAt(input, "items.single.name")).toEqual([
      "capture_not_allowed",
    ]);
  });

  it("link_requires_settlement: a link section on another role", () => {
    for (const role of [undefined, "standalone", "component"]) {
      const input = {
        version: 2,
        role,
        ...(role === "component" ? { linkKey: ["Key {link}"] } : {}),
        link: { daysBefore: 10 },
      };
      expect(codesAt(input, "link")).toEqual(["link_requires_settlement"]);
    }
  });

  it("refuses an unknown key of the link section, and a link that is not an object", () => {
    expect(
      codesAt({ ...settlement(), link: { limit: 3 } }, "link.limit"),
    ).toEqual(["unknown_key"]);
    expect(codesAt({ ...settlement(), link: [] }, "link")).toEqual([
      "invalid_type",
    ]);
  });

  it("link_domain_invalid: an entry the domain rules refuse, an empty list, over 10, not a list", () => {
    const at = (fromDomains: unknown, path: string) =>
      codesAt({ ...settlement(), link: { fromDomains } }, path);
    expect(
      at(["shop.example.com", "not a domain"], "link.fromDomains[1]"),
    ).toEqual(["link_domain_invalid"]);
    expect(at([5], "link.fromDomains[0]")).toEqual(["link_domain_invalid"]);
    expect(at([], "link.fromDomains")).toEqual(["link_domain_invalid"]);
    expect(at("shop.example.com", "link.fromDomains")).toEqual([
      "link_domain_invalid",
    ]);
    const eleven = Array.from({ length: 11 }, (_, i) => `d${i}.example.com`);
    expect(at(eleven, "link.fromDomains")).toEqual(["link_domain_invalid"]);
  });

  it("accepts 10 domains and stores each in its normalized form", () => {
    const ten = Array.from({ length: 10 }, (_, i) => `d${i}.example.com`);
    expect(
      validateReceiptParserDefinition({
        ...settlement(),
        link: { fromDomains: ten },
      }).ok,
    ).toBe(true);
    const result = validateReceiptParserDefinition({
      ...settlement(),
      link: { fromDomains: ["@Shop.Example.com."] },
    });
    expect(result.ok && result.definition.link?.fromDomains).toEqual([
      "shop.example.com",
    ]);
  });

  it("link_days_invalid: daysBefore not an integer from 0 to 365", () => {
    const at = (daysBefore: unknown) =>
      codesAt({ ...settlement(), link: { daysBefore } }, "link.daysBefore");
    for (const bad of [-1, 366, 1.5, "10", null]) {
      expect(at(bad)).toEqual(["link_days_invalid"]);
    }
    for (const good of [0, 365]) {
      expect(
        validateReceiptParserDefinition({
          ...settlement(),
          link: { daysBefore: good },
        }).ok,
      ).toBe(true);
    }
  });

  it("role_trade_conflict: a trade section with a role other than standalone", () => {
    const trade = {
      action: ["Order {action}"],
      symbol: ["Symbol {symbol}"],
      quantity: ["Qty {quantity}"],
      total: ["Total {amount}"],
      defaultAccountId: "11111111-1111-4111-8111-111111111111",
    };
    expect(codesAt({ version: 2, role: "settlement", trade }, "role")).toEqual([
      "role_trade_conflict",
    ]);
    expect(codesAt({ version: 2, role: "component", trade }, "role")).toEqual([
      "role_trade_conflict",
    ]);
    expect(
      validateReceiptParserDefinition({ version: 2, role: "standalone", trade })
        .ok,
    ).toBe(true);
    expect(validateReceiptParserDefinition({ version: 2, trade }).ok).toBe(
      true,
    );
  });

  it("does not refuse a match section on a component", () => {
    expect(
      validateReceiptParserDefinition({
        ...component(),
        match: { by: ["amount_date"] },
      }).ok,
    ).toBe(true);
  });
});
