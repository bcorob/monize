import { Entity, PrimaryColumn, Column, ManyToOne, JoinColumn } from "typeorm";
import { BenchmarkSeries } from "./benchmark-series.entity";

/**
 * One observation of a benchmark series. STEP: `observationDate` is the
 * effective-from date; MONTHLY: the first day of the reference month. Global
 * reference data, like `exchange_rates`; a correction is an update. `value`
 * is NUMERIC(20,10) carried as the string PostgreSQL returns.
 */
@Entity("benchmark_values")
export class BenchmarkValue {
  @PrimaryColumn({ type: "varchar", length: 40, name: "benchmark_code" })
  benchmarkCode: string;

  @ManyToOne(() => BenchmarkSeries, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "benchmark_code" })
  series?: BenchmarkSeries;

  @PrimaryColumn({
    type: "date",
    name: "observation_date",
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
  observationDate: string;

  @Column({ type: "decimal", precision: 20, scale: 10 })
  value: string;

  @Column({
    type: "date",
    name: "published_on",
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
  publishedOn: string | null;

  @Column({ type: "text", name: "source_url" })
  sourceUrl: string;

  @Column({ type: "timestamptz", name: "retrieved_at" })
  retrievedAt: Date;
}
