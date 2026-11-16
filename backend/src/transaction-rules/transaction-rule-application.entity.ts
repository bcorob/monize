import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  JoinColumn,
} from "typeorm";
import { User } from "../users/entities/user.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionRule } from "./transaction-rule.entity";

export type RuleApplicationSource = "create" | "import" | "manual";

/**
 * The trace: one row per rule per transaction it changed (design section 4).
 * Written by the applier (B4) and the manual run (B8); nothing in the CRUD
 * module writes it. Cascades from the rule and the transaction.
 */
@Entity("transaction_rule_applications")
export class TransactionRuleApplication {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user?: User;

  @Column({ type: "uuid", name: "rule_id" })
  ruleId: string;

  @ManyToOne(() => TransactionRule, { onDelete: "CASCADE" })
  @JoinColumn({ name: "rule_id" })
  rule?: TransactionRule;

  @Column({ type: "uuid", name: "transaction_id" })
  transactionId: string;

  @ManyToOne(() => Transaction, { onDelete: "CASCADE" })
  @JoinColumn({ name: "transaction_id" })
  transaction?: Transaction;

  @Column({ type: "varchar", length: 20, default: "manual" })
  source: RuleApplicationSource;

  /** Before/after per field. */
  @Column({ type: "jsonb", default: () => "'{}'::jsonb" })
  changes: Record<string, unknown>;

  @Column({
    type: "timestamptz",
    name: "applied_at",
    default: () => "CURRENT_TIMESTAMP",
  })
  appliedAt: Date;
}
