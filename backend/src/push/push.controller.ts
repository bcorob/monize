import { OwnerOnly } from "../delegation/decorators/delegate-access.decorator";
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Request,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { Throttle } from "@nestjs/throttler";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { DemoRestricted } from "../common/decorators/demo-restricted.decorator";
import { PushConfigService, PublicPushConfig } from "./push-config.service";
import {
  PushDeviceDto,
  PushSubscriptionService,
  PushTestResult,
} from "./push-subscription.service";
import { CreatePushSubscriptionDto } from "./dto/create-push-subscription.dto";
import { Request as ExpressRequest } from "express";
import { clientIpOf } from "../common/client-ip.util";

/**
 * A user's own push devices.
 *
 * Every route derives its tenant from `req.user.id`. There is no route here
 * that names another user, and no administrator route that reaches these: an
 * administrator configures the instance's push identity and never sends to, or
 * lists, somebody else's devices (discussion #1291).
 */
@ApiTags("Push")
@Controller("push")
@UseGuards(AuthGuard("jwt"))
@OwnerOnly()
@ApiBearerAuth()
export class PushController {
  constructor(
    private readonly pushConfig: PushConfigService,
    private readonly subscriptions: PushSubscriptionService,
  ) {}

  @Get("config")
  @ApiOperation({
    summary: "Whether push is available here, and the instance's public key",
  })
  getConfig(): Promise<PublicPushConfig> {
    return this.pushConfig.getPublicConfig();
  }

  @Get("subscriptions")
  @ApiOperation({ summary: "List the current user's push devices" })
  list(@Request() req): Promise<PushDeviceDto[]> {
    return this.subscriptions.listForUser(req.user.id);
  }

  /**
   * Demo-restricted because every demo visitor shares one account: a
   * subscription registered by one visitor would receive the test notification
   * another visitor triggered.
   */
  // Registering a device writes a row and reads it back; the tighter bound
  // exists because the endpoint is reachable before any device exists, so the
  // per-account device cap does not bound how often it can be called.
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @Post("subscriptions")
  @HttpCode(HttpStatus.CREATED)
  @DemoRestricted()
  @ApiOperation({ summary: "Register this browser for push notifications" })
  subscribe(
    @Request() req: ExpressRequest & { user: { id: string } },
    @Body() dto: CreatePushSubscriptionDto,
    @Headers("user-agent") userAgent?: string,
  ): Promise<PushDeviceDto> {
    // The address is read here rather than in the service because only the
    // controller has the request: `clientIpOf` is the deployment's one reading
    // of it (`trust proxy` is set in main.ts), shared with the 2FA
    // trusted-device path so one machine cannot be stored under two spellings.
    return this.subscriptions.subscribe(
      req.user.id,
      dto,
      userAgent ?? null,
      clientIpOf(req),
    );
  }

  // Restricted for the same shared-account reason as `subscribe`: the demo
  // account is one account every visitor is signed in to, so a removal here is
  // a visitor deleting a row somebody else is looking at. Nothing can be
  // registered in demo mode either, so closing it costs nothing -- and "every
  // write on this module is closed in demo mode" is a rule with no exception to
  // remember. `push-route-throttle.spec.ts` scans for it.
  @DemoRestricted()
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @Delete("subscriptions/:id")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Remove one of the current user's push devices" })
  remove(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.subscriptions.remove(req.user.id, id);
  }

  // Sign-out from the header holds this browser's row instead of deleting it,
  // so the same account signing in again resumes delivery with no prompt
  // (INV-PUSH-011). Demo-restricted and throttled like every write here.
  @DemoRestricted()
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @Post("subscriptions/:id/hold")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: "Hold one of the current user's push devices across a sign-out",
  })
  hold(@Request() req, @Param("id", ParseUUIDPipe) id: string): Promise<void> {
    return this.subscriptions.hold(req.user.id, id);
  }

  /** Demo-restricted for the shared-account reason given on `subscribe`. */
  // The one endpoint here that reaches an outbound provider, and it fans out:
  // up to MAX_LIVE_DEVICES_PER_USER endpoints per call. Under the global
  // 100/minute alone one account could drive 2,000 signed push requests a
  // minute out of this instance -- and the VAPID key pair is one per
  // DEPLOYMENT, so a push service that throttles or penalises the origin
  // degrades push for every user, not for the account that did it. Five a
  // minute is the same bound the other expensive outbound operations here
  // carry.
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @Post("test")
  @DemoRestricted()
  @ApiOperation({
    summary: "Send the current user a test notification on their own devices",
  })
  test(@Request() req): Promise<PushTestResult> {
    return this.subscriptions.sendTest(req.user.id);
  }
}
