import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Request,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";
import { Throttle } from "@nestjs/throttler";
import { DemoRestricted } from "../common/decorators/demo-restricted.decorator";
import { OwnerOnly } from "../delegation/decorators/delegate-access.decorator";
import { AiReviewApprovalService } from "./ai-review-approval.service";
import { ApproveAiReviewBatchDto } from "./dto/approve-ai-review-batch.dto";

/**
 * Bulk approval in the review inbox. Same prefix as `AiReviewRequestsController`;
 * its own controller because it commits through `AiActionsService`, which the
 * queue module cannot import (see `AiReviewApprovalService`). Owner-only; `userId`
 * is the JWT's.
 */
@ApiTags("AI Review")
@Controller("ai-review-requests")
@UseGuards(AuthGuard("jwt"))
@OwnerOnly()
@ApiBearerAuth()
export class AiReviewApprovalController {
  constructor(private readonly approval: AiReviewApprovalService) {}

  @Post("approve-batch")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @DemoRestricted()
  @ApiOperation({
    summary:
      "Approve up to 100 proposals, one after the other, through the same confirm a single approval uses",
  })
  approveBatch(
    @Request() req: { user: { id: string } },
    @Body() dto: ApproveAiReviewBatchDto,
  ) {
    return this.approval.approveBatch(req.user.id, dto.ids);
  }
}
