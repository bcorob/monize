import {
  BOND_INSTRUMENT_NAMESPACE,
  BOND_PROGRAM_NAMESPACE,
  bondInstrumentId,
  bondProgramId,
  uuidV5,
} from "./bond-instrument-id";

describe("bond instrument id", () => {
  it("implements UUIDv5 (RFC 4122 DNS namespace vector)", () => {
    expect(
      uuidV5("www.example.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8"),
    ).toBe("2ed6657d-e927-568b-95e1-2665a8aea6a2");
  });

  it("is a pure function of the key, under the fixed namespace", () => {
    const id = bondInstrumentId("PL", "PL_MF", "TOS1029");
    expect(id).toBe(uuidV5("PL|PL_MF|TOS1029", BOND_INSTRUMENT_NAMESPACE));
    expect(id).toBe(bondInstrumentId("PL", "PL_MF", "TOS1029"));
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("differs when any part of the key differs", () => {
    const ids = new Set([
      bondInstrumentId("PL", "PL_MF", "TOS1029"),
      bondInstrumentId("PL", "PL_MF", "TOS1030"),
      bondInstrumentId("DE", "PL_MF", "TOS1029"),
      bondInstrumentId("PL", "OTHER", "TOS1029"),
    ]);
    expect(ids.size).toBe(4);
  });

  it("pins the namespace", () => {
    expect(BOND_INSTRUMENT_NAMESPACE).toBe(
      "b2c1f3a4-6d5e-4f70-9a8b-1c2d3e4f5a6b",
    );
  });

  describe("bond program id", () => {
    it("is a pure function of the program key, under its own namespace", () => {
      const id = bondProgramId("PL", "PL_MF", "EDO");
      expect(id).toBe(uuidV5("PL|PL_MF|EDO", BOND_PROGRAM_NAMESPACE));
      expect(id).toBe(bondProgramId("PL", "PL_MF", "EDO"));
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    });

    it("differs when any part of the key differs, and from an instrument id of the same text", () => {
      const ids = new Set([
        bondProgramId("PL", "PL_MF", "EDO"),
        bondProgramId("PL", "PL_MF", "COI"),
        bondProgramId("DE", "PL_MF", "EDO"),
        bondProgramId("PL", "OTHER", "EDO"),
      ]);
      expect(ids.size).toBe(4);
      expect(bondProgramId("PL", "PL_MF", "EDO")).not.toBe(
        bondInstrumentId("PL", "PL_MF", "EDO"),
      );
    });

    it("pins the namespace", () => {
      expect(BOND_PROGRAM_NAMESPACE).toBe(
        "7e4d9a10-3c2b-4b6f-8d15-a0c9e2f6b384",
      );
    });
  });
});
