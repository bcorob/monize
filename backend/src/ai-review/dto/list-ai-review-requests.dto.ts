import { ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, Max, Min } from "class-validator";
import { MAX_AI_REVIEW_LIST_LIMIT } from "../ai-review-requests.service";

export const AI_REVIEW_INBOX_STATUS_FILTERS = [
  "pending",
  "claimed",
  "proposed",
  "applied",
  "rejected",
  "expired",
] as const;

/** Query of `GET /ai-review-requests`. */
export class ListAiReviewRequestsDto {
  @ApiPropertyOptional({
    enum: AI_REVIEW_INBOX_STATUS_FILTERS,
    description:
      "Only this status. Default: everything still waiting, plus expired",
  })
  @IsOptional()
  @IsIn(AI_REVIEW_INBOX_STATUS_FILTERS)
  status?: (typeof AI_REVIEW_INBOX_STATUS_FILTERS)[number];

  @ApiPropertyOptional({ minimum: 1, maximum: MAX_AI_REVIEW_LIST_LIMIT })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_AI_REVIEW_LIST_LIMIT)
  limit?: number;
}
