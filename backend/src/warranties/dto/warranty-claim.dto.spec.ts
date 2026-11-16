import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";

import { CreateWarrantyClaimDto } from "./create-warranty-claim.dto";
import { UpdateWarrantyClaimDto } from "./update-warranty-claim.dto";

const OPTIONS = { whitelist: true, forbidNonWhitelisted: true };

/** The properties a payload was refused on, sorted. */
function refusedOn(cls: new () => object, body: object): string[] {
  return validateSync(plainToInstance(cls, body), OPTIONS)
    .map((error) => error.property)
    .sort();
}

const base = { claimDate: "2026-10-01" };

describe("CreateWarrantyClaimDto", () => {
  it("accepts a claim with only its date, which starts open", () => {
    expect(refusedOn(CreateWarrantyClaimDto, base)).toEqual([]);
  });

  it("requires a real claim date", () => {
    expect(refusedOn(CreateWarrantyClaimDto, {})).toEqual(["claimDate"]);
    expect(
      refusedOn(CreateWarrantyClaimDto, { claimDate: "2026-02-30" }),
    ).toEqual(["claimDate"]);
  });

  it("refuses a status outside the four", () => {
    expect(
      refusedOn(CreateWarrantyClaimDto, { ...base, status: "pending" }),
    ).toEqual(["status"]);
  });

  it.each(["resolved", "denied"])(
    "accepts a resolution date on a %s claim, on or after the claim date",
    (status) => {
      for (const resolvedOn of ["2026-10-01", "2026-10-09"]) {
        expect(
          refusedOn(CreateWarrantyClaimDto, { ...base, status, resolvedOn }),
        ).toEqual([]);
      }
    },
  );

  it.each([[{}], [{ status: "open" }], [{ status: "approved" }]])(
    "refuses a resolution date without an outcome: %j",
    (status) => {
      expect(
        refusedOn(CreateWarrantyClaimDto, {
          ...base,
          ...status,
          resolvedOn: "2026-10-09",
        }),
      ).toEqual(["resolvedOnStatus"]);
    },
  );

  it("refuses a resolution date before the claim date", () => {
    expect(
      refusedOn(CreateWarrantyClaimDto, {
        ...base,
        status: "resolved",
        resolvedOn: "2026-09-30",
      }),
    ).toEqual(["resolvedOnAfterClaim"]);
  });

  it("reads a blank or null resolution date, description or resolution as none", () => {
    expect(
      refusedOn(CreateWarrantyClaimDto, {
        ...base,
        resolvedOn: "",
        description: "",
        resolution: null,
      }),
    ).toEqual([]);
  });

  it("caps the free text at 2000 characters", () => {
    expect(
      refusedOn(CreateWarrantyClaimDto, {
        ...base,
        description: "x".repeat(2001),
        resolution: "x".repeat(2001),
      }),
    ).toEqual(["description", "resolution"]);
  });

  it("refuses a user or warranty id in the body", () => {
    expect(
      refusedOn(CreateWarrantyClaimDto, {
        ...base,
        userId: "11111111-1111-4111-8111-111111111111",
        warrantyId: "22222222-2222-4222-8222-222222222222",
      }),
    ).toEqual(["userId", "warrantyId"]);
  });
});

describe("UpdateWarrantyClaimDto", () => {
  it("accepts any single field, leaving the cross-field rules to the stored row", () => {
    expect(refusedOn(UpdateWarrantyClaimDto, {})).toEqual([]);
    expect(
      refusedOn(UpdateWarrantyClaimDto, { resolvedOn: "2026-10-09" }),
    ).toEqual([]);
    expect(refusedOn(UpdateWarrantyClaimDto, { status: "open" })).toEqual([]);
  });

  it("refuses a resolution date beside a status without an outcome", () => {
    expect(
      refusedOn(UpdateWarrantyClaimDto, {
        status: "approved",
        resolvedOn: "2026-10-09",
      }),
    ).toEqual(["resolvedOnStatus"]);
  });

  it("refuses a resolution date before a claim date in the same payload", () => {
    expect(
      refusedOn(UpdateWarrantyClaimDto, {
        claimDate: "2026-10-10",
        resolvedOn: "2026-10-09",
      }),
    ).toEqual(["resolvedOnAfterClaim"]);
  });

  it("accepts reopening with the resolution date cleared", () => {
    expect(
      refusedOn(UpdateWarrantyClaimDto, { status: "open", resolvedOn: null }),
    ).toEqual([]);
  });
});
