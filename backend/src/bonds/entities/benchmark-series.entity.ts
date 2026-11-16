import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Check,
} from "typeorm";

/**
 * A reference series that floating or indexed bonds read (a central-bank rate,
 * a CPI index). `kind` is `STEP` (observations are effective-from dates) or
 * `MONTHLY` (observations are the first day of a reference month).
 * `coveredThrough` only moves forward. Global, no owner column.
 */
@Entity("benchmark_series")
@Check("kind IN ('STEP', 'MONTHLY')")
export class BenchmarkSeries {
  @PrimaryColumn({ type: "varchar", length: 40 })
  code: string;

  @Column({ type: "varchar", length: 10 })
  kind: "STEP" | "MONTHLY";

  @Column({ type: "varchar", length: 40 })
  publisher: string;

  @Column({ type: "text", name: "source_url" })
  sourceUrl: string;

  @Column({ type: "varchar", length: 20 })
  unit: string;

  @Column({
    type: "date",
    name: "covered_through",
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
  coveredThrough: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
