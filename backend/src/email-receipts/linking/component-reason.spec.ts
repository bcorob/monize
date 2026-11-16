import { componentReason, componentReasonOf } from "./component-reason";

describe("componentReasonOf", () => {
  it("is awaiting_settlement while no part used the component", () => {
    expect(componentReasonOf(0, 0, 1630000)).toBe("awaiting_settlement");
  });

  it("is settled when the parts took its whole net or more, instalment below it", () => {
    expect(componentReasonOf(1, 1630000, 1630000)).toBe("settled");
    expect(componentReasonOf(2, 1630001, 1630000)).toBe("settled");
    expect(componentReasonOf(1, 1629999, 1630000)).toBe("instalment");
  });
});

describe("componentReason", () => {
  const run = (rows: unknown[], net = 1630000) => {
    const query = jest.fn(async () => rows);
    return componentReason({ query } as never, "u1", "c1", net).then(
      (reason) => ({ reason, query }),
    );
  };

  it("reads the link rows that name the component, for the user", async () => {
    const { reason, query } = await run([{ used: "1", taken: "163.0000" }]);
    expect(reason).toBe("settled");
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("component_receipt_id = $2"),
      ["u1", "c1"],
    );
  });

  it("is instalment when part of the net is taken and awaiting_settlement with no rows", async () => {
    expect((await run([{ used: 3, taken: "100.0000" }])).reason).toBe(
      "instalment",
    );
    expect((await run([{ used: "0", taken: "0" }])).reason).toBe(
      "awaiting_settlement",
    );
    expect((await run([])).reason).toBe("awaiting_settlement");
  });
});
