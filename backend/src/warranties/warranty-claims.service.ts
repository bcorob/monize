import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";

import { lockWarrantyRow } from "../common/db/locks";
import { withScopedDb } from "../common/db/scoped-db";
import { tr } from "../i18n/translate";
import {
  CreateWarrantyClaimDto,
  resolvedOnFitsClaimDate,
  resolvedOnFitsStatus,
} from "./dto/create-warranty-claim.dto";
import { nullableText } from "./dto/create-warranty.dto";
import { UpdateWarrantyClaimDto } from "./dto/update-warranty-claim.dto";
import {
  WarrantyClaim,
  WarrantyClaimStatus,
} from "./entities/warranty-claim.entity";
import { Warranty } from "./entities/warranty.entity";

/** One claim as the API returns it: the row, camelCase, dates as text. */
export interface WarrantyClaimView {
  id: string;
  warrantyId: string;
  claimDate: string;
  status: WarrantyClaimStatus;
  description: string | null;
  resolution: string | null;
  resolvedOn: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The stored fields the two cross-field rules are decided on. */
interface ClaimShape {
  claimDate: string;
  status: WarrantyClaimStatus;
  resolvedOn: string | null;
}

/** A nullable date field: blank becomes null. */
function nullableDate(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === "" ? null : value;
}

function toView(row: WarrantyClaim): WarrantyClaimView {
  return {
    id: row.id,
    warrantyId: row.warrantyId,
    claimDate: row.claimDate,
    status: row.status,
    description: row.description,
    resolution: row.resolution,
    resolvedOn: row.resolvedOn,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Claims made against a warranty (docs/specs/warranty-tracker.md
 * decision 8, section 6.2). A claim never changes its warranty's status.
 *
 * Every route names its warranty, and every method loads that warranty by
 * `(id, userId)` inside the same transaction as the read or the write, before
 * it (WTY-005): a warranty that is not the caller's is a 404 and nothing is
 * written. The writes take the warranty's row lock (`lockWarrantyRow`), so a
 * concurrent delete of the warranty cannot land between the check and the
 * insert and turn a 404 into a foreign-key 500.
 */
@Injectable()
export class WarrantyClaimsService {
  constructor(private readonly dataSource: DataSource) {}

  /** Newest claim first: `claim_date DESC, created_at DESC`. */
  async findAll(
    userId: string,
    warrantyId: string,
  ): Promise<WarrantyClaimView[]> {
    return withScopedDb(this.dataSource, async (m) => {
      const warranty = await m.getRepository(Warranty).findOne({
        where: { id: warrantyId, userId },
        select: { id: true },
      });
      if (!warranty) throw this.warrantyNotFound(warrantyId);
      const rows = await m.getRepository(WarrantyClaim).find({
        where: { warrantyId, userId },
        order: { claimDate: "DESC", createdAt: "DESC" },
      });
      return rows.map(toView);
    });
  }

  async create(
    userId: string,
    warrantyId: string,
    dto: CreateWarrantyClaimDto,
  ): Promise<WarrantyClaimView> {
    return withScopedDb(this.dataSource, async (m) => {
      await this.lockOwnedWarranty(m, userId, warrantyId);
      const shape: ClaimShape = {
        claimDate: dto.claimDate,
        status: dto.status ?? "open",
        resolvedOn: nullableDate(dto.resolvedOn),
      };
      this.assertShape(shape);

      const repo = m.getRepository(WarrantyClaim);
      const saved = await repo.save(
        repo.create({
          userId,
          warrantyId,
          ...shape,
          description: nullableText(dto.description),
          resolution: nullableText(dto.resolution),
        }),
      );
      return toView(saved);
    });
  }

  /**
   * A value difference against the stored claim: the form resends every
   * field, so a claim with nothing changed is not written. The two rules are
   * decided on the stored row merged with the payload, which is what would be
   * stored; a status moved back to `open` with a stored `resolvedOn` is
   * refused rather than silently clearing the date.
   */
  async update(
    userId: string,
    warrantyId: string,
    claimId: string,
    dto: UpdateWarrantyClaimDto,
  ): Promise<WarrantyClaimView> {
    return withScopedDb(this.dataSource, async (m) => {
      await this.lockOwnedWarranty(m, userId, warrantyId);
      const repo = m.getRepository(WarrantyClaim);
      const row = await repo.findOne({
        where: { id: claimId, warrantyId, userId },
      });
      if (!row) throw this.claimNotFound(claimId);

      const shape: ClaimShape = {
        claimDate: dto.claimDate ?? row.claimDate,
        status: dto.status ?? row.status,
        resolvedOn:
          dto.resolvedOn !== undefined
            ? nullableDate(dto.resolvedOn)
            : row.resolvedOn,
      };
      this.assertShape(shape);

      const next: Partial<WarrantyClaim> = {};
      for (const key of Object.keys(shape) as Array<keyof ClaimShape>) {
        if (shape[key] !== row[key]) Object.assign(next, { [key]: shape[key] });
      }
      for (const key of ["description", "resolution"] as const) {
        if (dto[key] === undefined) continue;
        const cleaned = nullableText(dto[key]);
        if (cleaned !== row[key]) next[key] = cleaned;
      }

      if (Object.keys(next).length === 0) return toView(row);
      return toView(await repo.save({ ...row, ...next }));
    });
  }

  async remove(
    userId: string,
    warrantyId: string,
    claimId: string,
  ): Promise<void> {
    await withScopedDb(this.dataSource, async (m) => {
      await this.lockOwnedWarranty(m, userId, warrantyId);
      const result = await m
        .getRepository(WarrantyClaim)
        .delete({ id: claimId, warrantyId, userId });
      if (!result.affected) throw this.claimNotFound(claimId);
    });
  }

  /** The DTO's two rules, held again on the shape that is about to be stored. */
  private assertShape(shape: ClaimShape): void {
    if (!resolvedOnFitsStatus(shape.resolvedOn, shape.status)) {
      throw new BadRequestException(
        tr(
          "errors.warranties.claimResolvedOnNeedsOutcome",
          "A claim's resolution date needs a status of resolved or denied",
        ),
      );
    }
    if (!resolvedOnFitsClaimDate(shape.resolvedOn, shape.claimDate)) {
      throw new BadRequestException(
        tr(
          "errors.warranties.claimResolvedBeforeClaimDate",
          "A claim cannot be resolved before its claim date",
        ),
      );
    }
  }

  private async lockOwnedWarranty(
    m: EntityManager,
    userId: string,
    warrantyId: string,
  ): Promise<void> {
    const locked = await lockWarrantyRow(m, warrantyId, userId);
    if (!locked) throw this.warrantyNotFound(warrantyId);
  }

  private warrantyNotFound(id: string): NotFoundException {
    return new NotFoundException(
      tr("errors.warranties.notFound", `Warranty with ID ${id} not found`, {
        id,
      }),
    );
  }

  private claimNotFound(id: string): NotFoundException {
    return new NotFoundException(
      tr("errors.warranties.claimNotFound", `Claim with ID ${id} not found`, {
        id,
      }),
    );
  }
}
