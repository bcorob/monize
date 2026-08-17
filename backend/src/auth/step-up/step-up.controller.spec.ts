import { Test, TestingModule } from "@nestjs/testing";
import { StepUpAuthController } from "./step-up.controller";
import { StepUpAuthService } from "./step-up.service";

describe("StepUpAuthController", () => {
  let controller: StepUpAuthController;
  let service: Record<string, jest.Mock>;
  const req = { user: { id: "user-1" } };

  beforeEach(async () => {
    service = {
      verifyAndIssue: jest.fn().mockResolvedValue({
        stepUpToken: "tok",
        expiresAt: "2026-05-21T00:05:00.000Z",
        expiresInSeconds: 300,
      }),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [StepUpAuthController],
      providers: [
        // The controller only forwards to StepUpAuthService; the real
        // OidcReauthService (and its claim ledger) is exercised in the
        // service's own spec, which is where verification lives.
        { provide: StepUpAuthService, useValue: service },
      ],
    }).compile();
    controller = module.get(StepUpAuthController);
  });

  it("forwards purpose, password and totpCode to the service", async () => {
    const result = await controller.verify(req, {
      purpose: "emergency-access",
      password: "hunter2",
      totpCode: "123456",
    });
    expect(service.verifyAndIssue).toHaveBeenCalledWith(
      "user-1",
      "emergency-access",
      { password: "hunter2", totpCode: "123456" },
    );
    expect(result.stepUpToken).toBe("tok");
  });
});
