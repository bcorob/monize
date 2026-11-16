import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Request,
  Res,
} from "@nestjs/common";
import { Response } from "express";
import { AllowDelegate } from "../delegation/decorators/delegate-access.decorator";
import { SkipPasswordCheck } from "../auth/decorators/skip-password-check.decorator";
import { PushChartArtifactService } from "./push-chart-artifact.service";

// The opaque one-use token is the credential. The browser's notification image
// loader need not have a session; no route accepts an arbitrary file path or URL.
@Controller("push/chart")
@AllowDelegate()
@SkipPasswordCheck()
export class PushChartController {
  constructor(private readonly artifacts: PushChartArtifactService) {}
  @Get(":token.png")
  async get(
    @Param("token") token: string,
    @Request() req: { method: string },
    @Res() res: Response,
  ): Promise<void> {
    res.setHeader("Cache-Control", "no-store, private");
    res.setHeader("X-Content-Type-Options", "nosniff");
    // Express routes HEAD through GET: probes must not consume the one-use image.
    if (req.method === "HEAD") {
      res.status(405).end();
      return;
    }
    const png = await this.artifacts.consume(token);
    if (!png) throw new NotFoundException();
    res.type("image/png");
    // Nothing is returned on purpose: a @Res() handler's return value still
    // travels through the global ClassSerializerInterceptor, and the live
    // Express Response is not a serializable payload. See
    // `res-handler-return.guard.spec.ts`.
    res.send(png);
  }
}
