import {
  Controller,
  Get,
  Patch,
  Post,
  Delete,
  Param,
  Body,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
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
import { DemoRestricted } from "../common/decorators/demo-restricted.decorator";
import { AdminService } from "./admin.service";
import { CreateUserDto } from "./dto/create-user.dto";
import { UpdateUserRoleDto } from "./dto/update-user-role.dto";
import { UpdateUserStatusDto } from "./dto/update-user-status.dto";

@ApiTags("Admin")
@Controller("admin/users")
@UseGuards(AuthGuard("jwt"), RolesGuard)
@Roles("admin")
@ApiBearerAuth()
@DemoRestricted()
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get()
  @ApiOperation({ summary: "List all users (admin only)" })
  findAll() {
    return this.adminService.findAllUsers();
  }

  @Get("storage")
  @ApiOperation({
    summary: "Per-user backup and attachment storage usage (admin only)",
  })
  @ApiResponse({ status: 200, description: "Storage usage per user" })
  storageUsage() {
    return this.adminService.getUserStorageUsage();
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Create a new user account (admin only)" })
  @ApiResponse({ status: 201, description: "User created" })
  createUser(@Body() dto: CreateUserDto) {
    return this.adminService.createUser(dto);
  }

  @Patch(":id/role")
  @ApiOperation({ summary: "Change user role (admin only)" })
  @ApiResponse({ status: 200, description: "Role updated" })
  updateRole(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserRoleDto,
  ) {
    return this.adminService.updateUserRole(req.user.id, id, dto.role);
  }

  @Patch(":id/status")
  @ApiOperation({ summary: "Enable/disable user (admin only)" })
  @ApiResponse({ status: 200, description: "Status updated" })
  updateStatus(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserStatusDto,
  ) {
    return this.adminService.updateUserStatus(req.user.id, id, dto.isActive);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Delete user account (admin only)" })
  @ApiResponse({ status: 200, description: "User deleted" })
  deleteUser(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.adminService.deleteUser(req.user.id, id);
  }

  @Post(":id/reset-password")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Reset user password (admin only)" })
  @ApiResponse({
    status: 200,
    description: "Password reset, returns temporary password",
  })
  resetPassword(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.adminService.resetUserPassword(req.user.id, id);
  }

  @Post(":id/unlink-sso")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Convert an SSO account to a local account with a temporary password (admin only)",
  })
  @ApiResponse({
    status: 200,
    description: "SSO unlinked, returns temporary password",
  })
  @ApiResponse({ status: 400, description: "The user is not an SSO account" })
  unlinkSso(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.adminService.unlinkUserSso(req.user.id, id);
  }

  @Post(":id/reset-2fa")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Reset a user's two-factor authentication and sign them out (admin only)",
  })
  @ApiResponse({
    status: 200,
    description: "2FA cleared, trusted devices removed, sessions revoked",
  })
  @ApiResponse({ status: 400, description: "The user has no 2FA set up" })
  resetTwoFactor(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.adminService.resetUserTwoFactor(req.user.id, id);
  }
}
