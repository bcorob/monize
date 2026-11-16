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
 * The published rate of one interest period of a bond instrument.
 *
 * Immutable once written (INV-BOND-001). `annualRate` is NUMERIC(20,10), an
 * exchange-rate-like quantity rather than money, and is carried as the string
 * PostgreSQL returns so no precision is lost before the domain parses it.
 */
@Entity("bond_period_rates")
@Check("period_number >= 1")
export class BondPeriodRate {
  @PrimaryColumn({ type: "uuid", name: "bond_instrument_id" })
  bondInstrumentId: string;

  @ManyToOne(() => BondInstrument, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "bond_instrument_id" })
  instrument?: BondInstrument;

  @PrimaryColumn({ type: "integer", name: "period_number" })
  periodNumber: number;

  @Column({
    type: "decimal",
    precision: 20,
    scale: 10,
    name: "annual_rate",
  })
  annualRate: string;

  @Column({ type: "text", name: "source_url" })
  sourceUrl: string;

  @Column({ type: "timestamptz", name: "retrieved_at" })
  retrievedAt: Date;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}
