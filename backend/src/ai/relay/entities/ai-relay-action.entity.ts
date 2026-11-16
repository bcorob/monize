import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from "typeorm";

import { User } from "../../../users/entities/user.entity";

import { PendingAiAction } from "../../actions/ai-action.types";

/**
 * A write-confirmation card composed after the browser's stream gave up.
 *
 * The card stays approvable when the browser comes back, which is the whole
 * point: an action the agent decided on must not be silently lost -- or, worse,
 * auto-declined -- because a socket closed first.
 */
@Entity("ai_relay_actions")
export class AiRelayAction {
  /**
   * Owner first, matching `PRIMARY KEY (user_id, id)`: the pickup endpoint
   * drains by user, an action id is unique only within its owner, and the
   * column order of a composite key is the order of the index it builds.
   */
  @PrimaryColumn({ type: "uuid", name: "user_id" })
  userId: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user?: User;

  /**
   * The descriptor's own id.
   *
   * `text`, not `uuid`: the id is minted by the agent side, and this table does
   * not get to choose its grammar.
   */
  @PrimaryColumn({ type: "text" })
  id: string;

  @Column({ type: "jsonb" })
  card: PendingAiAction;

  @Column({
    type: "timestamptz",
    name: "created_at",
    default: () => "CURRENT_TIMESTAMP",
  })
  createdAt: Date;

  @Index("idx_ai_relay_actions_expiry")
  @Column({ type: "timestamptz", name: "expires_at" })
  expiresAt: Date;
}
