import { Body, Controller, Get, Patch, Post, UseGuards } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { Throttle } from "@nestjs/throttler";
import { DemoRestricted } from "../common/decorators/demo-restricted.decorator";
import { AdminPushConfig, PushConfigService } from "./push-config.service";
import { UpdatePushChannelsDto } from "./dto/update-push-channels.dto";

/** The rotation's report: the new identity, and how many devices it retired. */
export interface RotateVapidResult {
  config: AdminPushConfig;
  disabledSubscriptions: number;
}

/**
 * Instance-level notification settings: which delivery channels this Monize
 * deployment offers, and the Web Push identity behind one of them.
 *
 * Deliberately nothing per user. An administrator decides whether the
 * deployment can push at all; every account decides its own devices and
 * preferences in its own settings, and no route here reads or sends another
 * user's notifications.
 */
@ApiTags("Admin")
@Controller("admin/notifications")
@UseGuards(AuthGuard("jwt"), RolesGuard)
@Roles("admin")
@ApiBearerAuth()
export class AdminNotificationsController {
  constructor(private readonly pushConfig: PushConfigService) {}

  /**
   * Deliberately NOT `@DemoRestricted()`, unlike the two writes below.
   *
   * At class level the restriction 403s this read as well, and the nav links to
   * this page unconditionally: a demo administrator following it got a page that
   * renders nothing but "we could not check", for a request that has no body,
   * changes nothing and returns a key fingerprint and two counts. Restricting a
   * read buys nothing and costs the whole page.
   */
  @Get("channels")
  @ApiOperation({ summary: "Instance push identity and channel availability" })
  getChannels(): Promise<AdminPushConfig> {
    return this.pushConfig.getAdminConfig();
  }

  @DemoRestricted()
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @Patch("channels")
  @ApiOperation({
    summary: "Turn the Web Push channel on or off instance-wide",
  })
  updateChannels(@Body() dto: UpdatePushChannelsDto): Promise<AdminPushConfig> {
    return this.pushConfig.setWebPushEnabled(dto.webPushEnabled);
  }

  /**
   * Mint a new VAPID key pair.
   *
   * Every registered device stops being reachable and has to subscribe again --
   * the push service validates the signature against the key the subscription
   * was minted with -- so the count of retired devices is part of the answer,
   * not a log line.
   */
  // Destructive and instance-wide: a rotation retires every registered device
  // on the deployment, and it derives a new key pair through scrypt. Confirmed
  // in the UI with the live device count, and bounded here as well, because a
  // confirmation dialogue is not a rate limit.
  @DemoRestricted()
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @Post("vapid/rotate")
  @ApiOperation({ summary: "Rotate this instance's Web Push key pair" })
  async rotate(): Promise<RotateVapidResult> {
    const { config, disabled } = await this.pushConfig.rotateKeyPair();
    return { config, disabledSubscriptions: disabled };
  }
}
