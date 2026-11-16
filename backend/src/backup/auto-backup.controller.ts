import {
  Controller,
  Get,
  Patch,
  Post,
  Body,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiResponse,
} from "@nestjs/swagger";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { AutoBackupService } from "./auto-backup.service";
import {
  UpdateAutoBackupSettingsDto,
  ValidateFolderDto,
} from "./dto/update-auto-backup-settings.dto";
import { DemoRestricted } from "../common/decorators/demo-restricted.decorator";

/**
 * The deployment's automatic backup policy -- administrators only.
 *
 * What these endpoints read and write is one policy for the whole instance, not
 * the caller's own preference: it decides where files are written on the
 * server's filesystem and how much disk they take, and every active account is
 * reconciled onto it by `AutoBackupService.reconcileManagedUsers`. It has its
 * own singleton row (`auto_backup_policy`), so the handlers pass the acting
 * administrator's id only as the identity of the caller -- to probe a namespace
 * and to name an example folder, never to decide whose policy this is. The
 * guards are on the class rather than on each handler so an endpoint added here
 * is admin-only by default.
 *
 * Manual export/restore, which touches only the caller's own data, stays open
 * to everyone on `BackupController`.
 */
@ApiTags("Backup")
@Controller("backup")
@UseGuards(AuthGuard("jwt"), RolesGuard)
@Roles("admin")
@ApiBearerAuth()
export class AutoBackupController {
  constructor(private readonly autoBackupService: AutoBackupService) {}

  @Get("auto-backup-settings")
  @ApiOperation({
    summary: "Get the deployment's automatic backup policy (admin only)",
  })
  @ApiResponse({ status: 200, description: "Auto-backup settings returned" })
  async getAutoBackupSettings(@Request() req) {
    return this.autoBackupService.getSettings(req.user.id);
  }

  @Patch("auto-backup-settings")
  @DemoRestricted()
  @ApiOperation({
    summary:
      "Update the deployment's automatic backup policy, and apply it to every account (admin only)",
  })
  @ApiResponse({ status: 200, description: "Policy updated and applied" })
  async updateAutoBackupSettings(
    @Request() req,
    @Body() dto: UpdateAutoBackupSettingsDto,
  ) {
    return this.autoBackupService.updateSettings(req.user.id, dto);
  }

  @Post("validate-folder")
  @DemoRestricted()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Validate a folder path is writable (admin only)" })
  @ApiResponse({ status: 200, description: "Validation result" })
  async validateFolder(@Body() dto: ValidateFolderDto) {
    return this.autoBackupService.validateFolder(dto.folderPath);
  }

  @Post("browse-folders")
  @DemoRestricted()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "List subdirectories in a folder (admin only)" })
  @ApiResponse({ status: 200, description: "Directory listing" })
  async browseFolders(@Body() dto: ValidateFolderDto) {
    return this.autoBackupService.browseFolders(dto.folderPath);
  }

  /**
   * Whether this deployment can write an automatic backup anywhere.
   *
   * Enabling a schedule already fails when it cannot, but only after the admin
   * has chosen a frequency, a time and a retention policy and pressed save --
   * and the answer does not depend on any of that. A surface that reads this
   * can say so first. Separate from the settings response because it is a
   * property of the deployment rather than of the user's row, and because it
   * touches the filesystem, so a settings read should not pay for it.
   */
  @Get("auto-backup-capability")
  @ApiOperation({
    summary: "Whether this deployment has writable automatic-backup storage",
  })
  @ApiResponse({ status: 200, description: "Capability reported" })
  async getAutoBackupCapability(@Request() req) {
    return this.autoBackupService.describeCapability(req.user.id);
  }

  @Post("run-auto-backup")
  @DemoRestricted()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Back up every account on this deployment now (admin only)",
  })
  @ApiResponse({ status: 200, description: "Run finished; counts returned" })
  async runAutoBackup(@Request() req) {
    return this.autoBackupService.runManualBackup(req.user.id);
  }
}
