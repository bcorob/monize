/**
 * Lightweight frontend logger utility.
 *
 * Log level is controlled by NEXT_PUBLIC_LOG_LEVEL (default: 'info').
 * Levels: error > warn > info > debug
 *
 * Server-side (the Next.js standalone server / Node), each line is prefixed
 * with an ISO timestamp, level, and context so the output lines up with the
 * backend NestJS logs and can be correlated in aggregated/Docker logs, e.g.:
 *   2026-06-19T11:20:00.123Z [Investments] ERROR: Failed to load data: ...
 * Error objects are flattened onto a single line so a log shipper keeps one
 * record per error instead of splitting the stack across many lines.
 *
 * Browser-side, lines keep the simpler `[context]` tag and pass arguments
 * through untouched so the devtools console can expand Error objects.
 *
 * Usage:
 *   const logger = createLogger('Investments');
 *   logger.error('Failed to load data:', error);  // level >= error
 *   logger.warn('Unexpected state');               // level >= warn
 *   logger.info('Component mounted');              // level >= info (default)
 *   logger.debug('Payload received', data);        // level >= debug
 */

export interface Logger {
  readonly error: (...args: unknown[]) => void;
  readonly warn: (...args: unknown[]) => void;
  readonly info: (...args: unknown[]) => void;
  readonly debug: (...args: unknown[]) => void;
}

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
type LogLevel = keyof typeof LOG_LEVELS;

const LEVEL_LABELS: Record<LogLevel, string> = {
  error: 'ERROR',
  warn: 'WARN',
  info: 'INFO',
  debug: 'DEBUG',
};

function getConfiguredLevel(): number {
  const raw = (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_LOG_LEVEL) || 'info';
  return LOG_LEVELS[raw as LogLevel] ?? LOG_LEVELS.info;
}

const configuredLevel = getConfiguredLevel();

const noop = () => {};

// Evaluated per call so the running environment (and tests that stub `window`)
// are reflected; the check is cheap.
function isServer(): boolean {
  return typeof window === 'undefined';
}

/**
 * Flatten an Error into a single line: message plus stack with newlines and
 * their leading indentation collapsed to a literal ` \n ` separator. This keeps
 * the whole error in one log record while staying grep-friendly.
 *
 * The `cause` chain follows, because the stack alone often names only the
 * wrapper: undici's `fetch` throws `TypeError: fetch failed` and carries the
 * actual reason (a refused header, a reset connection) in `cause`. The chain
 * is cut at `MAX_CAUSE_DEPTH` so a cyclic one cannot loop.
 */
const MAX_CAUSE_DEPTH = 5;

function describeCause(cause: unknown): string {
  if (typeof cause === 'string') return cause;
  try {
    return JSON.stringify(cause) ?? String(cause);
  } catch {
    return String(cause);
  }
}

function flattenError(error: Error, depth = 0): string {
  const stack = (error.stack ?? `${error.name}: ${error.message}`).replace(/\n\s*/g, ' \\n ');
  const { cause } = error;
  if (cause === undefined) return stack;
  if (depth >= MAX_CAUSE_DEPTH) return `${stack} \\n [cause chain truncated]`;
  const described = cause instanceof Error ? flattenError(cause, depth + 1) : describeCause(cause);
  return `${stack} \\n caused by: ${described}`;
}

function serializeServerArg(arg: unknown): unknown {
  return arg instanceof Error ? flattenError(arg) : arg;
}

export function createLogger(context: string): Logger {
  const tag = `[${context}]`;

  const make = (level: LogLevel, write: (...args: unknown[]) => void) => {
    if (configuredLevel < LOG_LEVELS[level]) return noop;

    return (...args: unknown[]) => {
      if (isServer()) {
        const prefix = `${new Date().toISOString()} ${tag} ${LEVEL_LABELS[level]}:`;
        write(prefix, ...args.map(serializeServerArg));
        return;
      }
      write(tag, ...args);
    };
  };

  return {
    error: make('error', (...args) => console.error(...args)),
    warn: make('warn', (...args) => console.warn(...args)),
    info: make('info', (...args) => console.info(...args)),
    debug: make('debug', (...args) => console.debug(...args)),
  };
}
