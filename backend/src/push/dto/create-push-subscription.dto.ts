import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";
import {
  IsPushEndpoint,
  MAX_PUSH_ENDPOINT_LENGTH,
} from "../validators/push-endpoint.validator";
import {
  PUSH_TRANSPORTS,
  PushTransport,
} from "../entities/push-subscription.entity";

/**
 * What the browser's `PushSubscription.toJSON()` yields, flattened.
 *
 * There is deliberately no `userId` field. The owner is `req.user.id` and
 * nothing else; `forbidNonWhitelisted` means a client that sends one is
 * rejected rather than silently ignored, which is the behaviour the acceptance
 * criteria in discussion #1291 ask for.
 */
export class CreatePushSubscriptionDto {
  @ApiProperty({ maxLength: MAX_PUSH_ENDPOINT_LENGTH })
  @IsString()
  @IsPushEndpoint()
  endpoint: string;

  /** Base64url ECDH public key from the browser; 87-88 characters in practice. */
  @ApiProperty({ maxLength: 255 })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  p256dh: string;

  /** Base64url auth secret from the browser; 22-24 characters in practice. */
  @ApiProperty({ maxLength: 255 })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  auth: string;

  /**
   * The VAPID public key the browser actually subscribed with.
   *
   * Not decoration, and not the same thing as the server's current key: a
   * client holds the key it read when the page loaded, so a rotation in between
   * produces a subscription minted under the old pair. Stamping the row with
   * the server's own value would then record a key the subscription does not
   * have, `WebPushSender`'s KEY_ROTATED guard could never fire, and the device
   * would silently 403 until the retry bound retired it with the wrong reason.
   */
  @ApiProperty({ maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  applicationServerKey: string;

  /** What the user calls this device. Rendered in their own device list. */
  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @SanitizeHtml()
  deviceName?: string;

  /**
   * The wire this subscription is delivered on. Absent means `'webpush'` (a
   * browser vendor's push service, today's only caller). A UnifiedPush client
   * registering a distributor endpoint sends `'unifiedpush'`. Both are the same
   * encrypted Web Push protocol, so only the channel gating differs (spec
   * section 15). Bounded to the known set -- an unknown transport is a bug, not
   * a row to store, and the DB CHECK would reject it anyway.
   */
  @ApiPropertyOptional({ enum: PUSH_TRANSPORTS })
  @IsOptional()
  @IsIn(PUSH_TRANSPORTS)
  transport?: PushTransport;
}
