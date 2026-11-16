import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Post,
  Request,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Request as ExpressRequest } from "express";
import { DemoRestricted } from "../common/decorators/demo-restricted.decorator";
import { ConnectSimplefinDto } from "./dto/connect-simplefin.dto";
import { SimplefinSetupService } from "./simplefin-setup.service";
import {
  SimplefinDiscoveryService,
  type SimplefinDiscoveryView,
} from "./simplefin-discovery.service";

type AuthedRequest = ExpressRequest & { user: { id: string } };

@ApiTags("Bank sync")
@Controller("bank-sync/simplefin")
@UseGuards(AuthGuard("jwt"))
@ApiBearerAuth()
export class SimplefinController {
  constructor(
    private readonly setup: SimplefinSetupService,
    private readonly discovery: SimplefinDiscoveryService,
  ) {}

  @Post("connect")
  @DemoRestricted()
  @Throttle({ default: { ttl: 60000, limit: 3 } })
  @ApiOperation({
    summary:
      "Claim a SimpleFIN token, save encrypted credentials, and discover accounts",
  })
  async connect(
    @Request() req: AuthedRequest,
    @Body() dto: ConnectSimplefinDto,
  ): Promise<{
    credentialSet: true;
    discovery: SimplefinDiscoveryView;
  }> {
    await this.setup.connect(
      req.user.id,
      dto.setupToken,
      dto.replaceExisting ?? false,
    );
    // Credential persistence is already committed. A discovery failure must not
    // imply the one-time token needs claiming again.
    let discovery: SimplefinDiscoveryView;
    try {
      discovery = await this.discovery.discover(req.user.id);
    } catch {
      discovery = {
        ok: false,
        reviewRequired: true,
        errors: ["unavailable"],
        connections: [],
      };
    }
    return { credentialSet: true, discovery };
  }

  @Post("discover")
  @DemoRestricted()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({
    summary: "Retry SimpleFIN discovery without claiming another setup token",
  })
  discover(@Request() req: AuthedRequest): Promise<SimplefinDiscoveryView> {
    return this.discovery.discover(req.user.id);
  }

  @Delete("credentials")
  @DemoRestricted()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      "Remove local SimpleFIN credentials and disable institution syncing",
  })
  remove(@Request() req: AuthedRequest): Promise<void> {
    return this.setup.disconnect(req.user.id);
  }
}
