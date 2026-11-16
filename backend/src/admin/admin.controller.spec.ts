import { Test, TestingModule } from "@nestjs/testing";
import { GUARDS_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { AdminController } from "./admin.controller";
import { AdminService } from "./admin.service";
import { ROLES_KEY, RolesGuard } from "../auth/guards/roles.guard";
import { DEMO_RESTRICTED_KEY } from "../common/guards/demo-mode.guard";

describe("AdminController", () => {
  let controller: AdminController;
  let mockAdminService: Partial<Record<keyof AdminService, jest.Mock>>;
  const mockReq = { user: { id: "user-1" } };

  beforeEach(async () => {
    mockAdminService = {
      findAllUsers: jest.fn(),
      createUser: jest.fn(),
      updateUserRole: jest.fn(),
      updateUserStatus: jest.fn(),
      deleteUser: jest.fn(),
      resetUserPassword: jest.fn(),
      unlinkUserSso: jest.fn(),
      resetUserTwoFactor: jest.fn(),
      getUserStorageUsage: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [
        {
          provide: AdminService,
          useValue: mockAdminService,
        },
      ],
    }).compile();

    controller = module.get<AdminController>(AdminController);
  });

  describe("findAll()", () => {
    it("delegates to adminService.findAllUsers with no arguments", () => {
      mockAdminService.findAllUsers!.mockReturnValue("users");

      const result = controller.findAll();

      expect(result).toBe("users");
      expect(mockAdminService.findAllUsers).toHaveBeenCalledWith();
    });
  });

  describe("storageUsage()", () => {
    it("delegates to adminService.getUserStorageUsage with no arguments", () => {
      mockAdminService.getUserStorageUsage!.mockReturnValue("usage");

      const result = controller.storageUsage();

      expect(result).toBe("usage");
      expect(mockAdminService.getUserStorageUsage).toHaveBeenCalledWith();
    });
  });

  describe("createUser()", () => {
    it("delegates to adminService.createUser with the dto", () => {
      const dto = {
        email: "new@example.com",
        password: "Sup3rStr0ng!Pass",
      } as any;
      mockAdminService.createUser!.mockReturnValue("created");

      const result = controller.createUser(dto);

      expect(result).toBe("created");
      expect(mockAdminService.createUser).toHaveBeenCalledWith(dto);
    });
  });

  describe("updateRole()", () => {
    it("delegates to adminService.updateUserRole with adminId, userId, and role", () => {
      const dto = { role: "admin" } as any;
      mockAdminService.updateUserRole!.mockReturnValue("updated");

      const result = controller.updateRole(mockReq, "target-user-1", dto);

      expect(result).toBe("updated");
      expect(mockAdminService.updateUserRole).toHaveBeenCalledWith(
        "user-1",
        "target-user-1",
        "admin",
      );
    });
  });

  describe("updateStatus()", () => {
    it("delegates to adminService.updateUserStatus with adminId, userId, and isActive", () => {
      const dto = { isActive: false } as any;
      mockAdminService.updateUserStatus!.mockReturnValue("updated");

      const result = controller.updateStatus(mockReq, "target-user-1", dto);

      expect(result).toBe("updated");
      expect(mockAdminService.updateUserStatus).toHaveBeenCalledWith(
        "user-1",
        "target-user-1",
        false,
      );
    });
  });

  describe("deleteUser()", () => {
    it("delegates to adminService.deleteUser with adminId and userId", () => {
      mockAdminService.deleteUser!.mockReturnValue("deleted");

      const result = controller.deleteUser(mockReq, "target-user-1");

      expect(result).toBe("deleted");
      expect(mockAdminService.deleteUser).toHaveBeenCalledWith(
        "user-1",
        "target-user-1",
      );
    });
  });

  describe("resetPassword()", () => {
    it("delegates to adminService.resetUserPassword with adminId and userId", () => {
      mockAdminService.resetUserPassword!.mockReturnValue("reset");

      const result = controller.resetPassword(mockReq, "target-user-1");

      expect(result).toBe("reset");
      expect(mockAdminService.resetUserPassword).toHaveBeenCalledWith(
        "user-1",
        "target-user-1",
      );
    });
  });

  describe("unlinkSso()", () => {
    it("delegates to adminService.unlinkUserSso with adminId and userId", () => {
      mockAdminService.unlinkUserSso!.mockReturnValue("unlinked");

      const result = controller.unlinkSso(mockReq, "target-user-1");

      expect(result).toBe("unlinked");
      expect(mockAdminService.unlinkUserSso).toHaveBeenCalledWith(
        "user-1",
        "target-user-1",
      );
    });
  });

  describe("resetTwoFactor()", () => {
    it("delegates to adminService.resetUserTwoFactor with adminId and userId", () => {
      mockAdminService.resetUserTwoFactor!.mockReturnValue({ reset: true });

      const result = controller.resetTwoFactor(mockReq, "target-user-1");

      expect(result).toEqual({ reset: true });
      expect(mockAdminService.resetUserTwoFactor).toHaveBeenCalledWith(
        "user-1",
        "target-user-1",
      );
    });

    it("is an admin-only, JWT-guarded, demo-restricted route under the admin users path", () => {
      // Class-level, so every route here -- this one included -- inherits it.
      const guards = Reflect.getMetadata(GUARDS_METADATA, AdminController);
      expect(guards).toHaveLength(2);
      expect(guards).toContain(RolesGuard);
      expect(Reflect.getMetadata(ROLES_KEY, AdminController)).toEqual([
        "admin",
      ]);
      expect(Reflect.getMetadata(DEMO_RESTRICTED_KEY, AdminController)).toBe(
        true,
      );
      expect(Reflect.getMetadata(PATH_METADATA, AdminController)).toBe(
        "admin/users",
      );
      expect(
        Reflect.getMetadata(
          PATH_METADATA,
          AdminController.prototype.resetTwoFactor,
        ),
      ).toBe(":id/reset-2fa");
    });
  });
});
