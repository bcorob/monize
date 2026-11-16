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

/**
 * One sovereign bond program: the product a person holds (EDO), of which each
 * monthly issue is a `BondInstrument` series. Global reference data: no
 * `userId` and no RLS policy, insert only
 * (`docs/specs/bond-program-securities.md` section 2.1).
 */
@Entity("bond_programs")
@Unique(["issuerCountryCode", "issuerCode", "programCode"])
export class BondProgram {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "char", length: 2, name: "issuer_country_code" })
  issuerCountryCode: string;

  @Column({ type: "varchar", length: 40, name: "issuer_code" })
  issuerCode: string;

  @Column({ type: "varchar", length: 40, name: "program_code" })
  programCode: string;

  @Column({ type: "varchar", length: 3, name: "currency_code" })
  currencyCode: string;

  // Declared so the integration schema, built from the entities, carries the
  // same `REFERENCES currencies(code)` as schema.sql. Never loaded.
  @ManyToOne(() => Currency)
  @JoinColumn({ name: "currency_code", referencedColumnName: "code" })
  currency?: Currency;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}
