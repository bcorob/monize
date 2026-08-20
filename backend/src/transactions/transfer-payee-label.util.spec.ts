import {
  autoTransferPayeeName,
  transferPayeeDirection,
  transferPayeeLabel,
} from "./transfer-payee-label.util";

describe("transfer-payee-label.util", () => {
  describe("transferPayeeDirection", () => {
    it("reads money leaving the account as 'to'", () => {
      expect(transferPayeeDirection(-100)).toBe("to");
      expect(transferPayeeDirection("-67.9900")).toBe("to");
    });

    it("reads money arriving as 'from'", () => {
      expect(transferPayeeDirection(100)).toBe("from");
      expect(transferPayeeDirection("67.9900")).toBe("from");
    });

    it("gives zero the 'from' branch, matching the frontend transferDirection", () => {
      // An amount of exactly zero has no direction to read; both label rules
      // (this one and frontend/src/lib/transfer-label.ts) take the
      // non-negative branch so the two surfaces cannot disagree.
      expect(transferPayeeDirection(0)).toBe("from");
      expect(transferPayeeDirection("0.0000")).toBe("from");
    });
  });

  describe("transferPayeeLabel", () => {
    it("labels the source leg 'Transfer to <counterpart>'", () => {
      expect(transferPayeeLabel(-500, "Savings")).toBe("Transfer to Savings");
    });

    it("labels the destination leg 'Transfer from <counterpart>'", () => {
      expect(transferPayeeLabel(500, "Chequing")).toBe(
        "Transfer from Chequing",
      );
    });
  });

  describe("autoTransferPayeeName", () => {
    it("reproduces the exact legacy stamp for each direction", () => {
      // Migration 161 and the edit-time heal both match rows against this
      // string; if its shape ever drifted from what the old writers stamped,
      // legacy rows would silently stop being recognised.
      expect(autoTransferPayeeName("to", "Savings")).toBe(
        "Transfer to Savings",
      );
      expect(autoTransferPayeeName("from", "Chequing")).toBe(
        "Transfer from Chequing",
      );
    });
  });
});
