import { DEMO_RESTRICTED_KEY } from "../common/guards/demo-mode.guard";
import { AiReviewApprovalController } from "./ai-review-approval.controller";

describe("AiReviewApprovalController", () => {
  // approveBatch reaches AiActionsService.confirm, like POST /ai/actions/confirm.
  it("marks approveBatch as demo-restricted", () => {
    expect(
      Reflect.getMetadata(
        DEMO_RESTRICTED_KEY,
        AiReviewApprovalController.prototype.approveBatch,
      ),
    ).toBe(true);
  });
});
