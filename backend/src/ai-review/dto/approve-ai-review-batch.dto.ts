import { ApiProperty } from "@nestjs/swagger";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsUUID } from "class-validator";
import { AI_REVIEW_APPROVE_BATCH_MAX } from "../ai-review-approval.service";

/** Body of `POST /ai-review-requests/approve-batch`. */
export class ApproveAiReviewBatchDto {
  @ApiProperty({
    type: [String],
    minItems: 1,
    maxItems: AI_REVIEW_APPROVE_BATCH_MAX,
    description:
      "The requests to approve, in this order. Each is checked and committed on its own, exactly as approving its card would.",
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(AI_REVIEW_APPROVE_BATCH_MAX)
  @IsUUID("all", { each: true })
  ids: string[];
}
