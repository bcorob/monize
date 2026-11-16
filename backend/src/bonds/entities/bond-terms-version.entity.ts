import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Check,
} from "typeorm";
import { BondInstrument } from "./bond-instrument.entity";

/**
 * The terms of a bond instrument as published, versioned per instrument.
 *
 * Immutable once written (INV-BOND-001): a trigger refuses UPDATE and DELETE,
 * so changed terms are a new version. `terms` is stored as JSONB and parsed
 * and validated by the bond domain, not here; `contentHash` is the SHA-256 hex
 * of the canonical terms.
 */
@Entity("bond_terms_versions")
@Check("version >= 1")
export class BondTermsVersion {
  @PrimaryColumn({ type: "uuid", name: "bond_instrument_id" })
  bondInstrumentId: string;

  @ManyToOne(() => BondInstrument, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "bond_instrument_id" })
  instrument?: BondInstrument;

  @PrimaryColumn({ type: "integer" })
  version: number;

  @Column({ type: "jsonb" })
  terms: unknown;

  @Column({ type: "varchar", length: 64, name: "content_hash" })
  contentHash: string;

  @Column({ type: "text", name: "source_url" })
  sourceUrl: string;

  @Column({
    type: "date",
    name: "published_at",
    nullable: true,
    transformer: {
      from: (value: string | Date): string => {
        if (!value) return value as string;
        if (typeof value === "string") return value;
        const year = value.getFullYear();
        const month = String(value.getMonth() + 1).padStart(2, "0");
        const day = String(value.getDate()).padStart(2, "0");
        return `${year}-${month}-${day}`;
      },
      to: (value: string | Date): string | Date => value,
    },
  })
  publishedAt: string | null;

  @Column({ type: "timestamptz", name: "retrieved_at" })
  retrievedAt: Date;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}
