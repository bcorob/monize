import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { User } from "../../users/entities/user.entity";
import { Warranty } from "./warranty.entity";

export type WarrantyClaimStatus = "open" | "approved" | "denied" | "resolved";

export const WARRANTY_CLAIM_STATUSES: readonly WarrantyClaimStatus[] = [
  "open",
  "approved",
  "denied",
  "resolved",
];

/** A DATE column read as `YYYY-MM-DD` text, never as an instant. */
const dateTransformer = {
  from: (value: string | Date | null): string | null => {
    if (!value) return null;
    if (typeof value === "string") return value;
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  },
  to: (value: string | Date | null): string | Date | null => value,
};

/**
 * One claim made against a warranty (docs/specs/warranty-tracker.md
 * section 6.2). A claim never changes the warranty's status; deleting the
 * warranty deletes its claims (ON DELETE CASCADE).
 */
@Entity("warranty_claims")
export class WarrantyClaim {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user?: User;

  @Column({ type: "uuid", name: "warranty_id" })
  warrantyId: string;

  @ManyToOne(() => Warranty, { onDelete: "CASCADE" })
  @JoinColumn({ name: "warranty_id" })
  warranty?: Warranty;

  @Column({ type: "date", name: "claim_date", transformer: dateTransformer })
  claimDate: string;

  @Column({ type: "varchar", length: 20, default: "open" })
  status: WarrantyClaimStatus;

  @Column({ type: "varchar", length: 2000, nullable: true })
  description: string | null;

  @Column({ type: "varchar", length: 2000, nullable: true })
  resolution: string | null;

  @Column({
    type: "date",
    name: "resolved_on",
    nullable: true,
    transformer: dateTransformer,
  })
  resolvedOn: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
