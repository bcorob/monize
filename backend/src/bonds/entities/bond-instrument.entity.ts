import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Unique,
  ManyToOne,
  JoinColumn,
} from "typeorm";
import { Currency } from "../../currencies/entities/currency.entity";
import { BondProgram } from "./bond-program.entity";

/**
 * One sovereign bond series, for any issuer country (the Polish retail bonds
 * are the first instruments, not the shape of the table).
 *
 * Global reference data: no `userId` and no RLS policy -- one instrument serves
 * every account, as an exchange rate does. Insert only. See
 * `docs/specs/polish-retail-bonds.md` and the exemption note at the foot of
 * `database/schema.sql`.
 */
@Entity("bond_instruments")
@Unique(["issuerCountryCode", "issuerCode", "seriesCode"])
export class BondInstrument {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "char", length: 2, name: "issuer_country_code" })
  issuerCountryCode: string;

  @Column({ type: "varchar", length: 40, name: "issuer_code" })
  issuerCode: string;

  @Column({ type: "varchar", length: 40, name: "program_code" })
  programCode: string;

  @Column({ type: "uuid", name: "bond_program_id" })
  bondProgramId: string;

  // Declared so the integration schema, built from the entities, carries the
  // same `REFERENCES bond_programs(id) ON DELETE RESTRICT` as schema.sql. Never
  // loaded; the column above is what the code reads.
  @ManyToOne(() => BondProgram, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "bond_program_id" })
  program?: BondProgram;

  @Column({ type: "varchar", length: 40, name: "series_code" })
  seriesCode: string;

  @Column({ type: "varchar", length: 3, name: "currency_code" })
  currencyCode: string;

  // Declared so the integration schema, which is built from the entities, carries
  // the same `REFERENCES currencies(code)` as schema.sql (as exchange-rate.entity.ts
  // does). Never loaded; the column above is what the code reads.
  @ManyToOne(() => Currency)
  @JoinColumn({ name: "currency_code", referencedColumnName: "code" })
  currency?: Currency;

  @Column({ type: "varchar", length: 30 })
  marketability: string;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}
