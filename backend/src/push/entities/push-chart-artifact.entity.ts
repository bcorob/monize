import { Check, Column, Entity, Index, PrimaryColumn } from "typeorm";
@Entity("push_chart_artifacts")
@Check("id ~ '^[a-f0-9]{64}$'")
@Check("octet_length(png) <= 65536")
export class PushChartArtifact {
  @PrimaryColumn({ type: "varchar", length: 64 }) id: string;
  @Index("idx_push_chart_artifacts_expiry")
  @Column({ name: "expires_at", type: "timestamptz" })
  expiresAt: Date;
  @Column({ type: "bytea" }) png: Buffer;
}
