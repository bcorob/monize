import {
  ALLEGRO_PAY_COMPONENT_DEFINITION,
  ALLEGRO_PAY_SETTLEMENT_DEFINITION,
} from "../parsing/fixtures/allegro-pay-mails";
import { checkComponentDrafts } from "./component-draft";
import { EMAIL_RECEIPT_PARSER_TOOL_MAX_DRAFTS } from "./parser-tool.guide";

const component = (over: Record<string, unknown> = {}) => ({
  definition: { ...ALLEGRO_PAY_COMPONENT_DEFINITION },
  fromDomains: ["Shop.Example.com"],
  ...over,
});

describe("checkComponentDrafts", () => {
  it("accepts component drafts for a settlement and normalizes their domains", () => {
    const checked = checkComponentDrafts(ALLEGRO_PAY_SETTLEMENT_DEFINITION, [
      component(),
      component({ fromDomains: ["a.example.com", "a.example.com"] }),
    ]);
    expect(checked.ok).toBe(true);
    if (checked.ok) {
      expect(checked.drafts.map((d) => d.fromDomains)).toEqual([
        ["shop.example.com"],
        ["a.example.com"],
      ]);
    }
  });

  it.each([
    ["a component", ALLEGRO_PAY_COMPONENT_DEFINITION],
    ["a standalone profile", { version: 2 as const }],
  ])(
    "refuses a draft beside %s with component_draft_requires_settlement",
    (_n, tested) => {
      expect(checkComponentDrafts(tested, [component()])).toEqual({
        ok: false,
        errors: [
          {
            path: "componentDrafts",
            code: "component_draft_requires_settlement",
          },
        ],
      });
    },
  );

  it("refuses a draft whose role is not component", () => {
    const checked = checkComponentDrafts(ALLEGRO_PAY_SETTLEMENT_DEFINITION, [
      component(),
      component({ definition: { ...ALLEGRO_PAY_SETTLEMENT_DEFINITION } }),
    ]);
    expect(checked).toEqual({
      ok: false,
      errors: [
        {
          path: "componentDrafts[1].definition.role",
          code: "component_draft_requires_component",
        },
      ],
    });
  });

  it("reports the validator's errors under the draft's path", () => {
    const checked = checkComponentDrafts(ALLEGRO_PAY_SETTLEMENT_DEFINITION, [
      component({ definition: { version: 2, role: "component", bogus: 1 } }),
    ]);
    expect(checked.ok).toBe(false);
    if (!checked.ok) {
      expect(
        checked.errors.every((e) =>
          e.path.startsWith("componentDrafts[0].definition"),
        ),
      ).toBe(true);
      expect(checked.errors.map((e) => e.code)).toContain("unknown_key");
    }
  });

  it.each([
    ["none", []],
    ["eleven", Array.from({ length: 11 }, (_, i) => `d${i}.example.com`)],
    ["a bad domain", ["not a domain"]],
    ["a non-list", "shop.example.com"],
  ])("refuses fromDomains of %s", (_n, fromDomains) => {
    expect(
      checkComponentDrafts(ALLEGRO_PAY_SETTLEMENT_DEFINITION, [
        component({ fromDomains }),
      ]),
    ).toEqual({
      ok: false,
      errors: [
        {
          path: "componentDrafts[0].fromDomains",
          code: "component_draft_domain_invalid",
        },
      ],
    });
  });

  it("holds the number of drafts to the bound", () => {
    const many = Array.from(
      { length: EMAIL_RECEIPT_PARSER_TOOL_MAX_DRAFTS + 1 },
      () => component(),
    );
    expect(
      checkComponentDrafts(ALLEGRO_PAY_SETTLEMENT_DEFINITION, many),
    ).toMatchObject({
      ok: false,
      errors: [{ code: "component_draft_too_many" }],
    });
    expect(
      checkComponentDrafts(ALLEGRO_PAY_SETTLEMENT_DEFINITION, []),
    ).toMatchObject({
      ok: false,
    });
  });
});
