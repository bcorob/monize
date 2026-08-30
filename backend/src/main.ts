import { NestFactory } from "@nestjs/core";
import { Logger, RequestMethod, ValidationPipe } from "@nestjs/common";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import helmet from "helmet";
import * as express from "express";
import cookieParser from "cookie-parser";
import * as pg from "pg";
import { AppModule } from "./app.module";
import {
  PEAK_MULTIPLE,
  detectProcessMemoryLimitBytes,
  resolveRestoreExpandedLimitBytes,
  resolveRestoreUploadLimitBytes,
  warnIfRestoreUploadLimitIsCramped,
  warnIfRestoreUploadLimitIsUnsafe,
} from "./backup/backup-limits";
import { createRestoreUploadAdmission } from "./backup/restore-upload-admission";
import {
  computeRestoreProcessingSlots,
  restoreProcessingGate,
} from "./backup/restore-processing-gate";
import { resolveRestoreQueueConfig } from "./backup/restore-queue-config";
import { createRestoreTicketAuthorizer } from "./backup/restore-upload-ticket";
import { OAuthProviderService } from "./oauth/oauth-provider.service";
import { oauthDebugLogger } from "./oauth/oauth-debug-logger.middleware";
import { isOidcProviderPath } from "./oauth/oidc-provider-paths";
import { installOidcProviderLogBridge } from "./oauth/oidc-provider-log-bridge";
import { DataSource } from "typeorm";
import { parseRlsMode } from "./common/db/rls-config";
import { assertRuntimeRoleSafe } from "./common/db/runtime-role-check";
import { assertRequiredDbFunctions } from "./common/db/required-db-functions";
import { ConfigService } from "@nestjs/config";
import { logEncryptionKeyStatus } from "./common/encryption/encryption-key";

// node-oidc-provider writes its notices straight to console.info/console.warn,
// which would otherwise be the only unformatted lines in the log. Installed
// before anything can import or instantiate the provider.
installOidcProviderLogBridge();

const logger = new Logger("Bootstrap");

// Configure pg to return DATE types as strings instead of Date objects
// This prevents timezone-related date shifting issues
// OID 1082 = DATE type in PostgreSQL
pg.types.setTypeParser(1082, (val: string) => val);

// Configure pg to interpret TIMESTAMP WITHOUT TIME ZONE as UTC.
// PostgreSQL stores these as naive timestamps (no timezone info). The default
// pg parser creates a Date using the server's local timezone, which produces
// wrong UTC values when the server TZ is not UTC (e.g. America/Toronto).
// OID 1114 = TIMESTAMP WITHOUT TIME ZONE
pg.types.setTypeParser(1114, (val: string) => new Date(val + "Z"));

// Force pg to serialize Date parameters as UTC.
// The default pg serializer uses local-time getters (getFullYear, getHours, etc.)
// which produces wrong values for TIMESTAMP WITHOUT TIME ZONE columns when the
// server's local timezone is not UTC. This pairs with the read-side fix above.
function pad(n: number, digits = 2): string {
  return String(n).padStart(digits, "0");
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pgUtils = require("pg/lib/utils");
const origPrepareValue = pgUtils.prepareValue;
pgUtils.prepareValue = function (val: unknown, seen?: unknown[]): unknown {
  if (val instanceof Date) {
    return `${val.getUTCFullYear()}-${pad(val.getUTCMonth() + 1)}-${pad(val.getUTCDate())}T${pad(val.getUTCHours())}:${pad(val.getUTCMinutes())}:${pad(val.getUTCSeconds())}.${pad(val.getUTCMilliseconds(), 3)}+00`;
  }
  return origPrepareValue(val, seen);
};

// Suppress Node.js 20 ERR_INTERNAL_ASSERTION in HTTP detachSocket.
// This fires asynchronously when NestJS @Res() handlers throw exceptions,
// causing a race between the exception filter's response and internal socket
// cleanup. The response is already sent to the client; only the socket
// bookkeeping assertion fails. Safe to suppress in dev; does not fire in prod.
if (process.env.NODE_ENV !== "production") {
  process.on("uncaughtException", (err: any) => {
    if (
      err?.code === "ERR_INTERNAL_ASSERTION" &&
      err?.stack?.includes("detachSocket")
    ) {
      return;
    }
    logger.error(
      "Uncaught exception",
      err instanceof Error ? err.stack : String(err),
    );
    process.exit(1);
  });
}

/**
 * Verify the runtime DB role is fit to serve enforced traffic, and exit if not.
 *
 * Exiting rather than rethrowing: Nest turns a bootstrap rejection into an
 * unhandled promise warning and a non-zero exit whose cause is buried, and an
 * operator restarting a crash-looping container needs to read the reason in the
 * first ten lines of the log.
 */
async function assertRuntimeRoleOrExit(dataSource: DataSource): Promise<void> {
  const logger = new Logger("RlsRuntimeRole");
  const mode = parseRlsMode(process.env.RLS_MODE);
  try {
    const facts = await assertRuntimeRoleSafe(dataSource, {
      mode,
      appUser: process.env.DATABASE_APP_USER,
    });
    if (facts) {
      logger.log(
        `RLS_MODE=enforce verified: connected as "${facts.currentUser}" ` +
          "(no SUPERUSER, no BYPASSRLS, owns neither the database nor any " +
          "policied table).",
      );
    }
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

/**
 * Verify the database has every SQL function this build calls, and exit if not.
 *
 * Same reasoning as the role check above, and the same shape: the answer comes
 * from the connection requests will actually be served on, and a wrong answer
 * refuses the boot rather than surfacing later as a 500 from whichever query
 * reached the gap first. See `common/db/required-db-functions.ts` for why the
 * gap is reachable at all.
 */
async function assertRequiredDbFunctionsOrExit(
  dataSource: DataSource,
): Promise<void> {
  const logger = new Logger("DbSchemaCheck");
  try {
    await assertRequiredDbFunctions(dataSource);
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

/**
 * Say what this deployment's encryption key situation is, at every boot.
 *
 * Deliberately a warning and not a refusal, unlike the two database checks
 * below. `ENCRYPTION_KEY` is not required yet: refusing to boot would turn an
 * upgrade into an outage for every deployment that never set the variable under
 * its old name, `AI_ENCRYPTION_KEY`, which was optional and documented as being
 * for cloud AI providers. But an unkeyed server is precisely the state issue
 * #1269 was reported from -- backups written in plaintext with nothing saying so
 * -- so the absence is announced loudly, on every start, and named as a coming
 * hard requirement. The individual write paths still refuse; only the boot does
 * not.
 */
function reportEncryptionKeyStatus(configService: ConfigService): void {
  logEncryptionKeyStatus(
    (name) => configService.get<string>(name, ""),
    new Logger("EncryptionKeyCheck"),
  );
}

async function bootstrap() {
  logger.log("Starting application");

  const app = await NestFactory.create(AppModule);

  // Before anything that could store a secret: a server with no key writes
  // plaintext where it promises ciphertext, and used to say nothing.
  reportEncryptionKeyStatus(app.get(ConfigService));

  // RLS_MODE=enforce promises a database-level tenant boundary. Selecting the
  // application role and supplying its password does not deliver one: a
  // superuser, a role holding BYPASSRLS, and the owner of a policied table are
  // each exempt from every policy on it, so an operator who points
  // DATABASE_APP_USER at the database owner (or at a pre-provisioned role with
  // BYPASSRLS) used to get a clean boot, a log line saying enforce, and no
  // enforcement (P2-006). Ask the connection we will actually serve requests on
  // what it is, and refuse to start on a wrong answer -- before app.listen(),
  // because the alternative is serving cross-tenant reads while believing the
  // database is filtering them.
  await assertRuntimeRoleOrExit(app.get(DataSource));

  // And that the schema this build's SQL is written against is actually there.
  // db-migrate is a separate process that runs only at container start, so an
  // image whose code calls a function a migration has not created yet is a real
  // state -- and the request that discovers it is the one that gets a generic
  // "Database error". Refuse here instead.
  await assertRequiredDbFunctionsOrExit(app.get(DataSource));

  // Trust first proxy (Docker/nginx) so req.ip reflects the real client IP
  app.getHttpAdapter().getInstance().set("trust proxy", 1);

  // Backup restore accepts gzip-compressed binary (compressed on the client
  // to avoid multi-minute uploads of large JSON files). Encrypted backups
  // are uploaded as the Monize envelope under application/octet-stream, so
  // both content-types must be parsed into a raw Buffer here -- otherwise the
  // controller sees an unparsed body and rejects it.
  //
  // The limit is configurable (BACKUP_RESTORE_LIMIT) because backups now embed
  // transaction attachment bytes and can grow well past the old 100mb ceiling.
  //
  // Unset, it is derived from this container's memory limit rather than fixed.
  // It used to default to "500mb" while the chart's backend limit is 400Mi, and
  // `express.raw` buffers the whole body onto the heap *before* the controller,
  // the guards, the authentication lookup, the decryption and every service-level
  // ceiling -- so the process could die on a request none of those layers ever
  // saw. No care further down the path can reach an allocation that happens
  // first.
  const memoryLimitBytes = detectProcessMemoryLimitBytes();
  const backupRestoreLimit = resolveRestoreUploadLimitBytes(
    process.env.BACKUP_RESTORE_LIMIT,
    memoryLimitBytes,
  );
  const bootstrapLogger = new Logger("Bootstrap");
  bootstrapLogger.log(
    `Restore upload limit: ${Math.round(backupRestoreLimit / (1024 * 1024))}MiB`,
  );
  // An operator override the container cannot absorb is a killed process rather
  // than a refused request, so say it at startup instead of leaving them to infer
  // it from a restart. Checked against the same share the default is derived from,
  // in the same units the operator sets, so the derived default never warns about
  // itself and the figure suggested is one they can paste back.
  warnIfRestoreUploadLimitIsUnsafe(
    backupRestoreLimit,
    process.env.BACKUP_RESTORE_LIMIT,
    (message) => bootstrapLogger.warn(message),
    memoryLimitBytes,
  );
  // On a small container the safe upload limit can drop below what ordinary
  // backups need. It stays safe rather than flooring into a number the pod cannot
  // survive, but the operator should hear that restores are constrained here.
  warnIfRestoreUploadLimitIsCramped(
    backupRestoreLimit,
    process.env.BACKUP_RESTORE_LIMIT,
    (message) => bootstrapLogger.warn(message),
  );
  // Concurrent restore *processing* is capped separately from upload admission: a
  // small gzip expands to the expanded ceiling, so the wire budget cannot bound
  // decompressed memory. The cap budgets against the *resolved* expanded limit the
  // parser enforces, minus the process baseline, so an operator override is
  // accounted for and the ordinary process is not double-counted (F3R7-002).
  const restoreExpandedLimit = resolveRestoreExpandedLimitBytes(
    process.env.BACKUP_RESTORE_EXPANDED_LIMIT,
    memoryLimitBytes,
    (message) => bootstrapLogger.warn(message),
  );
  const honestSlots = computeRestoreProcessingSlots(
    memoryLimitBytes,
    restoreExpandedLimit,
  );
  // The queue behind those slots is bounded and deadlined (DR-F3RB-002): an
  // unbounded array of waiters is a way to hold sockets and upload reservations,
  // and a waiter whose client disconnected used to run its destructive restore
  // anyway when a slot freed.
  const restoreQueue = resolveRestoreQueueConfig(process.env, (message) =>
    bootstrapLogger.warn(message),
  );
  restoreProcessingGate.configure(honestSlots, restoreQueue);
  bootstrapLogger.log(
    `Concurrent restore processing slots: ${honestSlots} ` +
      `(queue limit ${restoreQueue.queueLimit}, ` +
      `wait ${Math.round(restoreQueue.waitTimeoutMs / 1000)}s)`,
  );
  if (honestSlots < 1) {
    // Zero means zero (F3RB-005): the gate refuses a restore with 503 rather
    // than admitting one that its own model says cannot fit. Flooring to one
    // turned a fixable misconfiguration into an OOM kill mid-restore, which is
    // the worst moment to lose the process. This is a configuration to fix.
    bootstrapLogger.error(
      `A single restore's modeled peak memory does not fit this container ` +
        `(limit ${Math.round((memoryLimitBytes ?? 0) / (1024 * 1024))}MiB, ` +
        `expanded limit ${Math.round(restoreExpandedLimit / (1024 * 1024))}MiB). ` +
        `Restores will be REFUSED with 503 until this is fixed: raise the ` +
        `container memory limit or lower BACKUP_RESTORE_EXPANDED_LIMIT.`,
    );
  }
  // Aggregate admission ahead of the parser: the per-request ceiling bounds one
  // request, and two concurrent uploads just under it exceed a container sized
  // for one. The JWT guard and the throttler are Nest guards, so they cannot
  // reach this allocation.
  const restoreAdmission = createRestoreUploadAdmission(
    backupRestoreLimit,
    // The budget is one request's worth of peak -- which is the container share
    // the wire limit was derived from -- so a large restore is effectively
    // serialised. A restore is a rare, deliberate, destructive operation:
    // refusing the second one costs a retry, and admitting it costs everyone the
    // replica serves.
    backupRestoreLimit * PEAK_MULTIPLE,
    (message) => bootstrapLogger.warn(`Restore upload refused: ${message}`),
    undefined,
    // Authorization ahead of the reservation (DR-F3RB-003): a request with no
    // ticket is refused 403 having claimed no memory at all. The ticket comes
    // from POST /api/v1/backup/restore/ticket, which is behind the JWT guard.
    // 403 rather than 401 on purpose -- see restore-upload-ticket.ts.
    createRestoreTicketAuthorizer(process.env.JWT_SECRET),
  );
  // Default body size limit for regular endpoints (QIF imports, etc.).
  // Skip body parsing for /oauth/* so node-oidc-provider parses requests
  // itself — otherwise it logs "already parsed request body detected" on
  // every DCR/token POST. The interaction routes under /api/v1/oauth-consent/*
  // need parsed bodies for @Body(), so they go through normal parsing.
  const skipForProvider =
    (parser: express.RequestHandler): express.RequestHandler =>
    (req, res, next) => {
      if (req.path === "/oauth" || req.path.startsWith("/oauth/")) {
        return next();
      }
      return parser(req, res, next);
    };
  // The AI assistant accepts attachments (images/PDFs) base64-encoded in the
  // JSON body, so its query endpoints need a larger limit than the 10mb
  // default. Mounted BEFORE the global parser so Express's first-match-wins
  // parsing handles these paths at 30mb; everything else stays at 10mb.
  app.use(
    ["/api/v1/ai/query", "/api/v1/ai/query/stream"],
    express.json({ limit: "30mb" }),
  );
  app.use(skipForProvider(express.json({ limit: "10mb" })));
  app.use(
    skipForProvider(express.urlencoded({ limit: "10mb", extended: true })),
  );

  // Cookie parser for OIDC state/nonce and auth tokens
  app.use(cookieParser());

  // OAuth/MCP debug-logger middleware mounted ahead of the global CORS
  // middleware so a request from an MCP client (Claude Desktop, mcp-remote)
  // is logged even when the strict app-wide CORS layer would have rejected
  // its Origin. CORS itself is path-aware further down (see app.enableCors
  // delegate) — these paths get permissive CORS because they authenticate
  // by Bearer token, not cookies.
  app.use("/api/v1/mcp", oauthDebugLogger("mcp"));
  app.use("/.well-known/oauth-protected-resource", oauthDebugLogger("prm"));
  app.use(
    "/.well-known/oauth-authorization-server",
    oauthDebugLogger("as-meta"),
  );
  app.use("/.well-known/openid-configuration", oauthDebugLogger("oidc-meta"));
  app.use("/oauth", oauthDebugLogger("provider"));
  app.use("/api/v1/oauth-consent", oauthDebugLogger("consent"));

  // Security middleware
  const disableHttpsHeaders = process.env.DISABLE_HTTPS_HEADERS === "true";
  app.use(
    helmet({
      frameguard: { action: "deny" },
      hsts: disableHttpsHeaders
        ? false
        : { maxAge: 63072000, includeSubDomains: true, preload: true },
      crossOriginOpenerPolicy: disableHttpsHeaders
        ? false
        : { policy: "same-origin" },
      crossOriginResourcePolicy: { policy: "same-origin" },
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
    }),
  );

  // Enable CORS
  const allowedOrigins = [
    process.env.PUBLIC_APP_URL,
    process.env.CORS_ORIGIN,
    ...(process.env.NODE_ENV !== "production"
      ? [
          "http://localhost:3001",
          "http://localhost:3000",
          "http://127.0.0.1:3001",
          "http://127.0.0.1:3000",
        ]
      : []),
  ].filter(Boolean);

  // Path-aware CORS: the MCP and OAuth surfaces accept any origin
  // because they authenticate via Bearer tokens (PAT / OAuth access
  // token) and never receive cookies — a third-party origin can't ride
  // ambient credentials. The rest of the app keeps the strict allow-list
  // because it relies on cookies + CSRF for browser sessions.
  app.enableCors((req, callback) => {
    const path = req.path ?? req.url ?? "";
    const isOpenSurface =
      path === "/api/v1/mcp" ||
      path.startsWith("/api/v1/mcp/") ||
      path === "/oauth" ||
      path.startsWith("/oauth/") ||
      path.startsWith("/api/v1/oauth-consent/") ||
      path === "/.well-known/oauth-protected-resource" ||
      path === "/.well-known/oauth-authorization-server" ||
      path.startsWith("/.well-known/oauth-authorization-server/") ||
      path === "/.well-known/openid-configuration";

    if (isOpenSurface) {
      callback(null, {
        origin: "*",
        credentials: false,
        methods: ["GET", "POST", "DELETE", "OPTIONS"],
        allowedHeaders: [
          "Authorization",
          "Content-Type",
          "Accept",
          "Mcp-Session-Id",
          "Mcp-Protocol-Version",
        ],
        exposedHeaders: ["Mcp-Session-Id", "WWW-Authenticate"],
        maxAge: 600,
      });
      return;
    }

    callback(null, {
      origin: (origin, cb) => {
        // Requests with no Origin header (server-to-server, health checks,
        // curl, same-origin navigations): always allow. Non-browser clients
        // can trivially set any Origin, so blocking null Origin adds no real
        // security. Sandboxed-iframe abuse is prevented by Helmet's
        // frameguard: { action: "deny" } instead.
        if (!origin) return cb(null, true);
        if (allowedOrigins.includes(origin)) cb(null, true);
        else cb(new Error("Not allowed by CORS"));
      },
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "Accept",
        "X-CSRF-Token",
        "X-Restore-Password",
        "X-Restore-OIDC-Token",
        // Sent by the client on an encrypted restore whose backup password
        // differs from the login one. Missing here, that restore died at the
        // preflight -- the same argument as the ticket header below, and a gap
        // that predates it.
        "X-Backup-Password",
        // Without this a cross-origin restore upload never leaves the browser:
        // the preflight refuses the header, so the upload is "blocked by CORS"
        // rather than refused with the 403 that says what to do.
        "X-Restore-Upload-Ticket",
        "Mcp-Session-Id",
      ],
      exposedHeaders: ["Mcp-Session-Id"],
    });
  });

  // The restore mount goes AFTER CORS, and that ordering is the point: the
  // admission middleware below answers requests itself (403 with no ticket, 413
  // oversized, 503 out of budget or out of headroom, 408 on a body that never
  // arrived). A response written from inside the middleware chain with no
  // Access-Control-Allow-Origin reaches a cross-origin browser as an opaque CORS
  // failure instead of the actionable status it is. What it must stay ahead of is
  // express.raw below -- that is the allocation it exists to refuse. The generic
  // JSON and urlencoded parsers are mounted earlier and pass these requests
  // straight through: they match on content type, and a restore body is
  // application/gzip or application/octet-stream.
  app.use("/api/v1/backup/restore", restoreAdmission.middleware);
  app.use(
    "/api/v1/backup/restore",
    express.raw({
      limit: backupRestoreLimit,
      type: ["application/gzip", "application/octet-stream"],
    }),
  );

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // API prefix. The protected-resource metadata route (RFC 9728) is the
  // only NestJS-controller path that must live at the application root
  // because the spec fixes its URL. The interaction controller lives
  // under the normal /api/v1 prefix so it goes through the regular
  // /api/* forwarding path on the frontend proxy.
  app.setGlobalPrefix("api/v1", {
    exclude: [
      {
        path: ".well-known/oauth-protected-resource",
        method: RequestMethod.GET,
      },
    ],
  });

  // Mount node-oidc-provider. Its issuer is the bare origin, so the discovery
  // documents are published at the root well-known URLs
  // (`/.well-known/openid-configuration` and
  // `/.well-known/oauth-authorization-server`), while its endpoints are pinned
  // under `/oauth/*` via the provider's `routes` map. Because discovery lives
  // at the root and endpoints under `/oauth`, the provider can't be mounted on
  // a single path prefix; it is mounted at the application root behind a
  // routing gate (`isOidcProviderPath`) that delegates only the provider's own
  // paths and lets every other request fall through to the Nest router.
  // Helmet's restrictive CSP doesn't matter here because the provider sets its
  // own headers and renders no HTML (the consent page is rendered by the
  // interaction controller).
  //
  // ensureInitialized() is awaited because Nest's onModuleInit hook may not
  // have run yet at this point (it fires inside app.listen() / app.init()).
  const oauthProviderService = app.get(OAuthProviderService);
  const oauthProvider = await oauthProviderService.ensureInitialized();
  const oidcHandler = oauthProvider.callback();
  // The debug-logger and permissive-CORS middlewares for /oauth/* etc. are
  // mounted earlier (before the global cookie/helmet/CORS chain) so that
  // requests from MCP clients with an off-allowlist Origin still appear in the
  // log and bypass the strict app-wide CORS layer.
  app.use(
    (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      if (isOidcProviderPath(req.path)) {
        oidcHandler(req, res);
        return;
      }
      next();
    },
  );

  // Swagger documentation (disabled in production)
  if (process.env.NODE_ENV !== "production") {
    const config = new DocumentBuilder()
      .setTitle("Monize API")
      .setDescription("API for managing your personal finances via Monize")
      .setVersion("1.0")
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup("api/docs", app, document);
  }

  // Increase HTTP server timeouts for large backup uploads (100mb+).
  // Default requestTimeout is 5 min which may not be enough when uploading
  // through multiple proxy layers on slower connections.
  const server = app.getHttpServer();
  server.requestTimeout = 600000; // 10 minutes
  server.headersTimeout = 605000; // must be > requestTimeout

  const port = process.env.PORT || 3001;
  await app.listen(port);

  logger.log(`Application is running on: http://localhost:${port}`);
  if (process.env.NODE_ENV !== "production") {
    logger.log(`API Documentation: http://localhost:${port}/api/docs`);
  }
}

bootstrap();
