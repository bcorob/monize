import { Reflector } from "@nestjs/core";
import { Test, TestingModule } from "@nestjs/testing";
import {
  ALLOW_DELEGATE_KEY,
  DELEGATE_FULL_SCOPE_KEY,
  DELEGATE_SECTION_KEY,
} from "../../delegation/decorators/delegate-access.decorator";
import { AiInsightsController } from "./ai-insights.controller";
import { AiInsightsService } from "./ai-insights.service";

describe("AiInsightsController", () => {
  let controller: AiInsightsController;
  let mockInsightsService: Partial<Record<keyof AiInsightsService, jest.Mock>>;

  const userId = "user-1";
  const req = { user: { id: userId } };

  beforeEach(async () => {
    mockInsightsService = {
      getInsights: jest.fn().mockResolvedValue({
        insights: [],
        total: 0,
        lastGeneratedAt: null,
        isGenerating: false,
      }),
      generateInsights: jest.fn().mockResolvedValue({
        insights: [],
        total: 0,
        lastGeneratedAt: null,
        isGenerating: false,
      }),
      dismissInsight: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AiInsightsController],
      providers: [
        { provide: AiInsightsService, useValue: mockInsightsService },
      ],
    }).compile();

    controller = module.get<AiInsightsController>(AiInsightsController);
  });

  it("admits an acting delegate only with the ai section and a whole-ledger grant", () => {
    const reflector = new Reflector();
    const targets = [
      AiInsightsController.prototype.getInsights,
      AiInsightsController,
    ];
    expect(reflector.getAllAndOverride(ALLOW_DELEGATE_KEY, targets)).toBe(true);
    expect(reflector.getAllAndOverride(DELEGATE_SECTION_KEY, targets)).toBe(
      "ai",
    );
    // Insights are generated from every account; nothing narrows them to the
    // delegate's grants, so the route needs all of them.
    expect(reflector.getAllAndOverride(DELEGATE_FULL_SCOPE_KEY, targets)).toBe(
      true,
    );
  });

  describe("getInsights()", () => {
    it("returns insights for the authenticated user", async () => {
      const result = await controller.getInsights(req, {});

      expect(mockInsightsService.getInsights).toHaveBeenCalledWith(
        userId,
        undefined,
        undefined,
        false,
      );
      expect(result).toEqual({
        insights: [],
        total: 0,
        lastGeneratedAt: null,
        isGenerating: false,
      });
    });

    it("passes filter parameters", async () => {
      await controller.getInsights(req, {
        type: "anomaly",
        severity: "warning",
        includeDismissed: true,
      });

      expect(mockInsightsService.getInsights).toHaveBeenCalledWith(
        userId,
        "anomaly",
        "warning",
        true,
      );
    });

    it("handles includeDismissed=false", async () => {
      await controller.getInsights(req, { includeDismissed: false });

      expect(mockInsightsService.getInsights).toHaveBeenCalledWith(
        userId,
        undefined,
        undefined,
        false,
      );
    });
  });

  describe("triggerGeneration()", () => {
    it("triggers background generation and returns status immediately", () => {
      mockInsightsService.generateInsights!.mockResolvedValue({
        insights: [],
        total: 0,
        lastGeneratedAt: null,
      });

      const result = controller.triggerGeneration(req);

      expect(mockInsightsService.generateInsights).toHaveBeenCalledWith(userId);
      expect(result).toEqual({ status: "generating" });
    });

    it("logs error.message when generation throws Error", async () => {
      mockInsightsService.generateInsights!.mockRejectedValue(
        new Error("boom"),
      );
      const result = controller.triggerGeneration(req);
      expect(result).toEqual({ status: "generating" });
      // Allow microtask to flush
      await new Promise((r) => setImmediate(r));
    });

    it("logs Unknown error when generation throws non-Error", async () => {
      mockInsightsService.generateInsights!.mockRejectedValue("string-err");
      const result = controller.triggerGeneration(req);
      expect(result).toEqual({ status: "generating" });
      await new Promise((r) => setImmediate(r));
    });
  });

  describe("dismissInsight()", () => {
    it("dismisses an insight for the authenticated user", async () => {
      await controller.dismissInsight(req, "insight-1");

      expect(mockInsightsService.dismissInsight).toHaveBeenCalledWith(
        userId,
        "insight-1",
      );
    });
  });
});
