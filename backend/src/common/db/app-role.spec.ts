import { Logger } from "@nestjs/common";
import {
  APP_ROLE_ATTRIBUTES,
  APP_ROLE_GRANTS_SQL,
  RUNTIME_READ_ONLY_TABLES,
  APP_ROLE_NAME_GUC,
  APP_ROLE_PASSWORD_GUC,
  APP_ROLE_SETTINGS_SQL,
  APP_ROLE_UPSERT_SQL,
  applyAppRoleGrants,
  provisionAppRole,
  SqlClient,
} from "./app-role";
import { DEFAULT_APP_USER } from "./rls-config";
import { FORBIDDEN_RUNTIME_ATTRIBUTES } from "./runtime-role-check";

function makeClient() {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const client: SqlClient = {
    query: jest.fn((text: string, params?: unknown[]) => {
      calls.push({ text, params });
      return Promise.resolve({ rows: [] });
    }),
  };
  return { client, calls };
}

function makeLogger() {
  return { log: jest.fn(), warn: jest.fn() };
}

describe("provisionAppRole", () => {
  it("sets the role name and password via parameterized set_config, then upserts, sets defaults and grants", async () => {
    const { client, calls } = makeClient();
    const logger = makeLogger();

    await provisionAppRole(client, {
      appUser: "monize_app",
      appPassword: "s3cret",
      logger,
    });

    // Role name carried via a parameterized session GUC (no interpolation).
    expect(calls[0]).toEqual({
      text: "SELECT set_config($1, $2, false)",
      params: [APP_ROLE_NAME_GUC, "monize_app"],
    });
    // Password carried via a parameterized session GUC (never in SQL text).
    expect(calls[1]).toEqual({
      text: "SELECT set_config($1, $2, false)",
      params: [APP_ROLE_PASSWORD_GUC, "s3cret"],
    });
    expect(calls[2].text).toBe(APP_ROLE_UPSERT_SQL);
    expect(calls[3].text).toBe(APP_ROLE_SETTINGS_SQL);
    expect(calls[4].text).toBe(APP_ROLE_GRANTS_SQL);
    expect(calls).toHaveLength(5);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("defaults the role name to monize_app when appUser is unset", async () => {
    const { client, calls } = makeClient();
    await provisionAppRole(client, {
      appUser: undefined,
      appPassword: "pw",
      logger: makeLogger(),
    });
    expect(calls[0].params).toEqual([APP_ROLE_NAME_GUC, DEFAULT_APP_USER]);
  });

  it("skips role creation but still applies defaults and grants when the password is unset", async () => {
    const { client, calls } = makeClient();
    const logger = makeLogger();

    await provisionAppRole(client, {
      appUser: "monize_app",
      appPassword: undefined,
      logger,
    });

    // Only the role-name GUC, defaults and grants run; no password GUC, no
    // upsert. A role provisioned declaratively still gets its defaults.
    expect(calls.map((c) => c.text)).toEqual([
      "SELECT set_config($1, $2, false)",
      APP_ROLE_SETTINGS_SQL,
      APP_ROLE_GRANTS_SQL,
    ]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/DATABASE_APP_PASSWORD/);
    expect(logger.log).not.toHaveBeenCalled();
  });

  it("defaults to the Nest Logger when none is provided, so the line is formatted like the rest of startup", async () => {
    const { client } = makeClient();
    const logSpy = jest
      .spyOn(Logger.prototype, "log")
      .mockImplementation(() => {});
    const warnSpy = jest
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => {});
    try {
      await provisionAppRole(client, {
        appUser: "monize_app",
        appPassword: "pw",
      });
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("never emits the password as a literal in any SQL statement text", async () => {
    const { client, calls } = makeClient();
    await provisionAppRole(client, {
      appUser: "monize_app",
      appPassword: "super-secret-value",
      logger: makeLogger(),
    });
    for (const call of calls) {
      expect(call.text).not.toContain("super-secret-value");
    }
  });
});

describe("app-role SQL", () => {
  it("has a runtime check for every forbidden attribute it provisions (RR5-001)", () => {
    // The parity guard. `APP_ROLE_ATTRIBUTES` strips a set of NO<x> attributes,
    // and the startup verifier must reject each of them -- provisioning can be
    // skipped (declarative CNPG), fail soft (no CREATEROLE), or drift, so the
    // verifier is the real control. REPLICATION was provisioned off and never
    // checked, so a REPLICATION role passed startup and could hold WAL.
    //
    // Derived from the two sources rather than hand-listed, so a new NO<x> in
    // provisioning without a runtime fact fails here.
    const provisionedOff = (
      APP_ROLE_ATTRIBUTES.match(/\bNO[A-Z]+\b/g) ?? []
    ).map((token) => token.slice(2));

    // NOINHERIT is defence in depth for inherited ownership, not a forbidden
    // attribute in its own right (a role may legitimately hold INHERIT), so it is
    // handled by the ownership arms rather than the forbidden-attribute list.
    const shouldBeChecked = provisionedOff.filter((a) => a !== "INHERIT");
    const checked = FORBIDDEN_RUNTIME_ATTRIBUTES.map((a) => a.label);

    for (const attr of shouldBeChecked) {
      expect(checked).toContain(attr);
    }
    // ...and nothing checked that provisioning does not also strip, so the two
    // stay a matched pair.
    for (const label of checked) {
      expect(provisionedOff).toContain(label);
    }
  });

  it("names every stripped attribute in the insufficient-privilege warning (RR7-002)", () => {
    // The fallback path for declarative CNPG provisioning: when the owner lacks
    // CREATEROLE, the ALTER fails soft and this warning is the only instruction
    // the operator gets. It hand-listed four of the six NO<x> attributes and
    // dropped NOREPLICATION and NOINHERIT, so an operator following it into
    // managed.roles rebuilt a role that later failed enforce-mode startup.
    //
    // Derived from APP_ROLE_ATTRIBUTES, so the warning cannot drift behind it.
    const warning = APP_ROLE_UPSERT_SQL.slice(
      APP_ROLE_UPSERT_SQL.indexOf("RAISE WARNING"),
    );
    const stripped = APP_ROLE_ATTRIBUTES.match(/\bNO[A-Z]+\b/g) ?? [];
    expect(stripped.length).toBeGreaterThan(0);
    for (const token of stripped) {
      expect(warning).toContain(token);
    }
  });

  it("provisions the role NOINHERIT, so it does not inherit an owner by default", () => {
    // Defence in depth for RR3-001: an inherited owner bypasses RLS with no SET
    // ROLE at all. Not the fix -- a per-membership `WITH INHERIT TRUE` overrides
    // the role default, and declarative provisioning skips this SQL entirely --
    // which is why the startup check tests reachability rather than trusting it.
    expect(APP_ROLE_ATTRIBUTES).toContain("NOINHERIT");
    expect(APP_ROLE_UPSERT_SQL).toContain("NOINHERIT");
  });

  it("uses %I / %L formatting and no FOR ROLE clause", () => {
    expect(APP_ROLE_UPSERT_SQL).toContain(
      `format('CREATE ROLE %I ${APP_ROLE_ATTRIBUTES} PASSWORD %L'`,
    );
    expect(APP_ROLE_UPSERT_SQL).toContain("insufficient_privilege");
    expect(APP_ROLE_GRANTS_SQL).toContain(
      "ALTER DEFAULT PRIVILEGES IN SCHEMA public",
    );
    expect(APP_ROLE_GRANTS_SQL).not.toMatch(/FOR ROLE/i);
  });

  it("creates the role without any RLS-exempting attribute", () => {
    // Already PostgreSQL's defaults; named so that a future edit adding
    // SUPERUSER or BYPASSRLS has to delete an explicit NO.
    for (const attribute of [
      "NOSUPERUSER",
      "NOBYPASSRLS",
      "NOCREATEDB",
      "NOCREATEROLE",
      "NOREPLICATION",
    ]) {
      expect(APP_ROLE_UPSERT_SQL).toContain(attribute);
    }
  });

  it("revokes the runtime role's access to migration bookkeeping", () => {
    // The blanket "ALL TABLES IN SCHEMA public" grant includes
    // schema_migrations, so runtime credentials could insert a filename (the next
    // deployment then skips required DDL) or delete one (a migration body
    // re-runs). No application code touches the table.
    //
    // Write privileges only: #1063 landed the revoke keeping SELECT, and this
    // test used to assert REVOKE ALL because that is what the audit-03 branch
    // wrote. The difference is read access to a ledger of filenames, which is not
    // the thing being protected -- forging or deleting a row is -- so the merged
    // narrower revoke stands and the assertion follows it.
    expect(APP_ROLE_GRANTS_SQL).toMatch(
      /REVOKE INSERT, UPDATE, DELETE ON public\.%I FROM %I/,
    );
    // Guarded on the table's existence: the grants run on every startup,
    // including before the table has been created.
    expect(APP_ROLE_GRANTS_SQL).toContain("relname = infra_table");
  });

  it("orders the revoke after the blanket grant", () => {
    // A revoke that ran first would be undone by the grant that followed it.
    const grantAt = APP_ROLE_GRANTS_SQL.indexOf(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES",
    );
    const revokeAt = APP_ROLE_GRANTS_SQL.indexOf(
      "REVOKE INSERT, UPDATE, DELETE ON public.%I",
    );
    expect(grantAt).toBeGreaterThan(-1);
    expect(revokeAt).toBeGreaterThan(grantAt);
  });
});

/**
 * Session defaults on the runtime role. `jit = off` because RLS subplans push
 * register queries over the JIT cost thresholds, and on a server built with
 * LLVM the compile took ~15 s per call for a query that runs in ~25 ms.
 */
describe("runtime role session defaults", () => {
  it("turns JIT off on the role, quoted with %I", () => {
    expect(APP_ROLE_SETTINGS_SQL).toContain(
      "format('ALTER ROLE %I SET jit = off', role_name)",
    );
  });

  it("only alters a role that exists", () => {
    // Runs on every startup, including before a declaratively provisioned
    // role has been created; ALTER on a missing role would raise.
    expect(APP_ROLE_SETTINGS_SQL).toMatch(
      /IF EXISTS \(SELECT FROM pg_roles WHERE rolname = role_name\)/,
    );
  });

  it("degrades a privilege shortfall to a warning in its own block", () => {
    // CNPG managed.roles leaves the owner without CREATEROLE. Inside the
    // grants block, the failed ALTER would roll the grants back with it.
    expect(APP_ROLE_SETTINGS_SQL).toContain(
      "EXCEPTION WHEN insufficient_privilege THEN",
    );
    expect(APP_ROLE_SETTINGS_SQL).toContain("RAISE WARNING");
    expect(APP_ROLE_GRANTS_SQL).not.toContain("jit");
  });

  it("is not part of the grants-only pass db-migrate runs", async () => {
    const { client, calls } = makeClient();

    await applyAppRoleGrants(client, { appUser: "monize_app" });

    expect(calls.map((c) => c.text)).not.toContain(APP_ROLE_SETTINGS_SQL);
  });
});

/**
 * DR-02. The blanket "all tables in schema public" grant is deliberate -- a new
 * user-owned table must be reachable the moment a migration creates it -- but it
 * also handed the runtime role write access to the migration ledger, which no
 * request touches and no policy protects.
 */
describe("runtime grant surface", () => {
  it("revokes writes on every read-only infrastructure table", () => {
    for (const table of RUNTIME_READ_ONLY_TABLES) {
      expect(APP_ROLE_GRANTS_SQL).toContain(`'${table}'`);
    }
    expect(APP_ROLE_GRANTS_SQL).toContain(
      "REVOKE INSERT, UPDATE, DELETE ON public.%I",
    );
  });

  it("keeps SELECT, so nothing that reads the ledger breaks", () => {
    expect(APP_ROLE_GRANTS_SQL).not.toContain("REVOKE ALL");
    expect(APP_ROLE_GRANTS_SQL).not.toMatch(/REVOKE[^;]*SELECT/);
  });

  it("guards the revoke on the table existing", () => {
    // The grants block runs on every startup, including before schema.sql has
    // created anything. A REVOKE on a missing table aborts the whole DO block
    // and would take the grants with it.
    expect(APP_ROLE_GRANTS_SQL).toMatch(/IF EXISTS \(\s*SELECT FROM pg_class/);
  });

  it("revokes after granting, not before", () => {
    // "GRANT ON ALL TABLES" would re-add what an earlier revoke took away.
    expect(APP_ROLE_GRANTS_SQL.indexOf("GRANT SELECT, INSERT")).toBeLessThan(
      APP_ROLE_GRANTS_SQL.indexOf("REVOKE"),
    );
  });
});

/**
 * The grants-only entry point db-migrate calls after its DDL. Untested when it
 * shipped (PR #1076 review): the one path meant to make grants converge had no
 * assertion that it converges anything.
 */
describe("applyAppRoleGrants", () => {
  it("sets the role-name GUC parameterized, then applies the grants", async () => {
    const { client, calls } = makeClient();

    await applyAppRoleGrants(client, { appUser: "monize_app" });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      text: "SELECT set_config($1, $2, false)",
      params: [APP_ROLE_NAME_GUC, "monize_app"],
    });
    expect(calls[1].text).toBe(APP_ROLE_GRANTS_SQL);
  });

  it("defaults the role name to monize_app when appUser is unset", async () => {
    const { client, calls } = makeClient();

    await applyAppRoleGrants(client, { appUser: undefined });

    expect(calls[0].params).toEqual([APP_ROLE_NAME_GUC, DEFAULT_APP_USER]);
  });

  it("never touches the role or its password", async () => {
    // Grants-only on purpose: db-migrate has no password to offer, and a
    // convergence pass that re-ran the upsert would rotate credentials as a
    // side effect of replaying migrations.
    const { client, calls } = makeClient();

    await applyAppRoleGrants(client, { appUser: "monize_app" });

    for (const call of calls) {
      expect(call.text).not.toBe(APP_ROLE_UPSERT_SQL);
      expect(call.params ?? []).not.toContain(APP_ROLE_PASSWORD_GUC);
    }
  });
});
