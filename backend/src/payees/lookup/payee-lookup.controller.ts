import {
  Body,
  Controller,
  Get,
  Patch,
  Post,
  Request,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { ModuleRef } from "@nestjs/core";
import { AiService } from "../../ai/ai.service";
import { DemoRestricted } from "../../common/decorators/demo-restricted.decorator";
import {
  TestPayeeLookupKeyDto,
  UpdatePayeeLookupSettingsDto,
} from "./dto/update-payee-lookup-settings.dto";
import {
  PayeeLookupSettingsService,
  PayeeLookupSettingsView,
  PayeeLookupStatus,
} from "./google-places/payee-lookup-settings.service";

/**
 * Configuration for the payee contact lookup: which source answers it, and the
 * Google Places key and cap when the user supplies their own.
 *
 * Owner-only. There is no `@AllowDelegate` here on purpose -- a delegate may
 * create and edit payees (and so may run a lookup), but a stored API key and
 * the spending limit on it belong to the account holder, not to somebody
 * acting on their behalf.
 */
@ApiTags("payee-lookup")
@Controller("payee-lookup")
@UseGuards(AuthGuard("jwt"))
export class PayeeLookupController {
  constructor(
    private readonly settings: PayeeLookupSettingsService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * Resolved lazily for the same reason the AI lookup adapter does it:
   * `AiModule` imports `PayeesModule`, so a static edge back would put every
   * module importing payees on a require cycle (`module-graph.spec.ts` names
   * eight).
   */
  private get aiService(): AiService {
    return this.moduleRef.get(AiService, { strict: false });
  }

  @Get("status")
  @ApiOperation({
    summary: "Whether a contact lookup can run, and which source would answer",
  })
  async getStatus(@Request() req): Promise<PayeeLookupStatus> {
    const aiStatus = await this.aiService.getStatus(req.user.id);
    return this.settings.getStatus(req.user.id, aiStatus.configured);
  }

  @Get("settings")
  @ApiOperation({ summary: "Google Places configuration for this user" })
  getSettings(@Request() req): Promise<PayeeLookupSettingsView> {
    return this.settings.getSettings(req.user.id);
  }

  @Patch("settings")
  @DemoRestricted()
  @ApiOperation({ summary: "Update the Google Places configuration" })
  updateSettings(
    @Request() req,
    @Body() dto: UpdatePayeeLookupSettingsDto,
  ): Promise<PayeeLookupSettingsView> {
    return this.settings.updateSettings(req.user.id, dto);
  }

  /**
   * Throttled like the AI provider test it mirrors: each call is a real,
   * billed request to Google.
   */
  @Post("settings/test")
  @DemoRestricted()
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({ summary: "Check a Google Places API key against Google" })
  testKey(
    @Request() req,
    @Body() dto: TestPayeeLookupKeyDto,
  ): Promise<{ available: boolean; error?: string }> {
    return this.settings.testKey(req.user.id, dto.apiKey);
  }
}
