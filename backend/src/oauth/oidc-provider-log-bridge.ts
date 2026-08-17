import { Logger } from "@nestjs/common";

/**
 * `node-oidc-provider` prints its own notices through `console.info` /
 * `console.warn` (see its lib/helpers/attention.js), so they land in the
 * backend log as bare, unprefixed lines while every other line carries the Nest
 * `[Nest] pid - date LEVEL [Context] message` shape. The library exposes no
 * logger hook, so the only place to normalize them is the console itself.
 *
 * This bridge re-routes exactly the lines the library emits -- anything else
 * written to `console.info` / `console.warn` is passed through untouched.
 *
 * A notice still means a config option was left at its default; fix the config
 * rather than silencing the line. The bridge only changes how it is printed.
 */

/** Matches an attention.js line, with or without its TTY colour wrapper. */
const OIDC_ATTENTION = /^oidc-provider (NOTICE|WARNING):\s*([\s\S]*)$/;

/** attention.js wraps the line in bold yellow/red when stdout/stderr is a TTY. */
// eslint-disable-next-line no-control-regex
const ANSI_SEQUENCE = /\x1b\[[0-9;]*m/g;

export interface OidcProviderLogLine {
  level: "log" | "warn";
  message: string;
}

/**
 * Recognize an `oidc-provider` attention line and split it into the Nest log
 * level it belongs at and the message without the library's own prefix (the
 * `[OidcProvider]` context supplies that). Returns null for anything else, so
 * the caller can pass it straight through to the real console.
 */
export function parseOidcProviderLine(
  value: unknown,
): OidcProviderLogLine | null {
  if (typeof value !== "string") return null;
  const match = OIDC_ATTENTION.exec(value.replace(ANSI_SEQUENCE, "").trim());
  if (!match) return null;
  return {
    level: match[1] === "WARNING" ? "warn" : "log",
    message: match[2].trim(),
  };
}

/** Minimal logger surface used by the bridge (matches NestJS `Logger`). */
export interface OidcBridgeLogger {
  log(message: string): void;
  warn(message: string): void;
}

type ConsoleMethod = (...args: unknown[]) => void;

let uninstall: (() => void) | null = null;

/**
 * Patch `console.info` / `console.warn` so `oidc-provider` lines go through the
 * Nest logger. Idempotent: calling it twice does not stack wrappers. Returns
 * the function that restores the original console methods (used by tests; the
 * server installs the bridge for the life of the process).
 */
export function installOidcProviderLogBridge(
  logger: OidcBridgeLogger = new Logger("OidcProvider"),
): () => void {
  if (uninstall) return uninstall;

  /* eslint-disable no-console */
  const originalInfo = console.info.bind(console) as ConsoleMethod;
  const originalWarn = console.warn.bind(console) as ConsoleMethod;

  const bridge =
    (passthrough: ConsoleMethod): ConsoleMethod =>
    (...args: unknown[]) => {
      const line = args.length === 1 ? parseOidcProviderLine(args[0]) : null;
      if (!line) {
        passthrough(...args);
        return;
      }
      logger[line.level](line.message);
    };

  console.info = bridge(originalInfo);
  console.warn = bridge(originalWarn);

  uninstall = () => {
    console.info = originalInfo;
    console.warn = originalWarn;
    uninstall = null;
  };
  /* eslint-enable no-console */

  return uninstall;
}
