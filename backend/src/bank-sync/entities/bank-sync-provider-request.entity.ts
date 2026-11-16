import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from "typeorm";
import { User } from "../../users/entities/user.entity";
import { BankSyncCredential } from "./bank-sync-credential.entity";

/** Instance-local request reservations; excluded from every portable backup. */
@Entity("bank_sync_provider_requests")
@Index("idx_bank_sync_provider_requests_window", [
  "credentialId",
  "requestedAt",
])
export class BankSyncProviderRequest {
  @PrimaryGeneratedColumn("uuid")
  id: string;
  @Column({ type: "uuid", name: "user_id" })
  userId: string;
  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user?: User;
  @Column({ type: "uuid", name: "credential_id" })
  credentialId: string;
  @ManyToOne(() => BankSyncCredential, { onDelete: "CASCADE" })
  @JoinColumn([
    { name: "credential_id", referencedColumnName: "id" },
    { name: "user_id", referencedColumnName: "userId" },
  ])
  credential?: BankSyncCredential;
  @Column({
    type: "timestamptz",
    name: "requested_at",
    default: () => "CURRENT_TIMESTAMP",
  })
  requestedAt: Date;
}
