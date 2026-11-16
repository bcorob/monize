import { Controller, Get, UseGuards } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Roles } from "../auth/decorators/roles.decorator";
import { RolesGuard } from "../auth/guards/roles.guard";
import {
  DeploymentStatus,
  SystemAlertMonitorService,
} from "./system-alert-monitor.service";

/**
 * Deployment configuration an administrator has to fix, for the admin banner.
 *
 * Admin-only because nobody else can act on it, and because it describes the
 * server's own security posture. It answers with reason codes; the secret, or
 * anything computed from it, never leaves the server.
 */
@ApiTags("Admin")
@ApiBearerAuth()
@Controller("admin/deployment-status")
@UseGuards(AuthGuard("jwt"), RolesGuard)
@Roles("admin")
export class DeploymentStatusController {
  constructor(private readonly monitor: SystemAlertMonitorService) {}

  @Get()
  @ApiOperation({
    summary:
      "Deployment configuration an administrator should fix, e.g. a weak JWT_SECRET (admin only)",
  })
  getStatus(): DeploymentStatus {
    const status = this.monitor.getDeploymentStatus();
    // The banner this feeds and the System alert must appear together. The
    // alert is otherwise raised only by the 15-minute sweep, so an admin who
    // signs in right after a restart would see the banner with no alert behind
    // it. Raising here is idempotent (the alert's weekly dedupe key) and is not
    // awaited: the fan-out may email every administrator, and an unreachable
    // SMTP relay must not hold the banner's request. `checkJwtSecret` never
    // throws.
    if (status.jwtSecretWeakness !== null) {
      void this.monitor.checkJwtSecret();
    }
    return status;
  }
}
