import { GUARDS_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { ROLES_KEY, RolesGuard } from "../auth/guards/roles.guard";
import { DeploymentStatusController } from "./deployment-status.controller";
import { SystemAlertMonitorService } from "./system-alert-monitor.service";

describe("DeploymentStatusController", () => {
  const RETIRED_PLACEHOLDER = "your-super-secret-jwt-key-change-in-production";

  let raiseAdminAlert: jest.Mock;

  const controllerWith = (jwtSecret: string | undefined) => {
    raiseAdminAlert = jest.fn().mockResolvedValue(undefined);
    return new DeploymentStatusController(
      new SystemAlertMonitorService(
        {
          get: jest.fn((name: string) =>
            name === "JWT_SECRET" ? jwtSecret : undefined,
          ),
        } as never,
        { raiseAdminAlert } as never,
        { getStatus: jest.fn(), getFailureSnapshot: jest.fn() } as never,
        // The replica census is the sweep's; the banner never reads it.
        "single",
        { countActiveProcesses: jest.fn() } as never,
      ),
    );
  };

  it("reports a weak JWT_SECRET by reason code, never by value", () => {
    const status = controllerWith(RETIRED_PLACEHOLDER).getStatus();

    expect(status).toEqual({ jwtSecretWeakness: "placeholder" });
    expect(JSON.stringify(status)).not.toContain("your-super-secret");
  });

  it("reports a predictable secret as such", () => {
    expect(controllerWith("x".repeat(40)).getStatus()).toEqual({
      jwtSecretWeakness: "predictable",
    });
  });

  // The banner reads this endpoint; the System alert used to wait for the
  // 15-minute sweep, so the two could disagree right after a restart.
  it("raises the System alert alongside a weak-secret status", () => {
    controllerWith(RETIRED_PLACEHOLDER).getStatus();

    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
    expect(raiseAdminAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "JWT_SECRET_WEAK",
        data: { system: true, reason: "placeholder" },
        dedupeKey: expect.stringMatching(/^JWT_SECRET_WEAK:/),
      }),
    );
  });

  it("raises no alert for a strong secret", () => {
    controllerWith("FkVtZprB4sKbrwNIl6YiZarB8gB9RrKoO0rt7sFg4YM=").getStatus();
    expect(raiseAdminAlert).not.toHaveBeenCalled();
  });

  it("reports nothing for a strong secret", () => {
    expect(
      controllerWith(
        "FkVtZprB4sKbrwNIl6YiZarB8gB9RrKoO0rt7sFg4YM=",
      ).getStatus(),
    ).toEqual({ jwtSecretWeakness: null });
  });

  it("is admin-only behind the JWT guard", () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      DeploymentStatusController,
    );
    expect(guards).toHaveLength(2);
    expect(guards).toContain(RolesGuard);
    expect(Reflect.getMetadata(ROLES_KEY, DeploymentStatusController)).toEqual([
      "admin",
    ]);
    expect(Reflect.getMetadata(PATH_METADATA, DeploymentStatusController)).toBe(
      "admin/deployment-status",
    );
  });
});
