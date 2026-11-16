import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLogger } from './logger';

describe('createLogger', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns an object with error, warn, info, and debug methods', () => {
    const logger = createLogger('Test');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });

  it('error calls console.error with context tag', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = createLogger('MyModule');
    logger.error('something failed');
    expect(spy).toHaveBeenCalledWith('[MyModule]', 'something failed');
  });

  it('warn calls console.warn with context tag', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logger = createLogger('Auth');
    logger.warn('token expiring');
    expect(spy).toHaveBeenCalledWith('[Auth]', 'token expiring');
  });

  it('info calls console.info with context tag and extra args', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const logger = createLogger('App');
    logger.info('initialized', { count: 1 });
    expect(spy).toHaveBeenCalledWith('[App]', 'initialized', { count: 1 });
  });

  it('each logger instance gets its own context tag', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const loggerA = createLogger('ServiceA');
    const loggerB = createLogger('ServiceB');
    loggerA.info('hello');
    loggerB.info('world');
    expect(spy).toHaveBeenCalledWith('[ServiceA]', 'hello');
    expect(spy).toHaveBeenCalledWith('[ServiceB]', 'world');
  });
});

describe('createLogger on the server', () => {
  // The logger treats a missing `window` as server-side; stub it to undefined so
  // `typeof window === 'undefined'` is true, exercising the Node/standalone path.
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('window', undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('prefixes an ISO timestamp, context tag, and level', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const logger = createLogger('App');
    logger.info('initialized');
    const prefix = spy.mock.calls[0][0] as string;
    expect(prefix).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[App\] INFO:$/);
    expect(spy.mock.calls[0][1]).toBe('initialized');
  });

  it('uses the matching level label and console method for each level', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createLogger('Svc').error('boom');
    createLogger('Svc').warn('careful');
    expect(errorSpy.mock.calls[0][0]).toContain('[Svc] ERROR:');
    expect(warnSpy.mock.calls[0][0]).toContain('[Svc] WARN:');
  });

  it('flattens an Error onto a single line', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error('something failed');
    error.stack = 'Error: something failed\n    at foo (file.ts:1:1)\n    at bar (file.ts:2:2)';
    createLogger('Module').error('Failed:', error);
    const serialized = spy.mock.calls[0][2] as string;
    expect(serialized).not.toContain('\n');
    expect(serialized).toContain('Error: something failed');
    expect(serialized).toContain('at foo (file.ts:1:1)');
    expect(serialized).toContain('at bar (file.ts:2:2)');
  });

  // undici's fetch throws `TypeError: fetch failed` and keeps the reason in
  // `cause`; a log without it left a 502 from the API proxy undiagnosable.
  it('appends the cause chain to a flattened Error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const root = Object.assign(new Error('invalid transfer-encoding header'), {
      code: 'UND_ERR_INVALID_ARG',
    });
    root.stack = 'InvalidArgumentError: invalid transfer-encoding header\n    at processHeader (request.js:1:1)';
    const error = new TypeError('fetch failed', { cause: root });
    error.stack = 'TypeError: fetch failed\n    at fetch (index.js:1:1)';
    createLogger('Proxy').error('API proxy error:', error);
    const serialized = spy.mock.calls[0][2] as string;
    expect(serialized).not.toContain('\n');
    expect(serialized).toContain('TypeError: fetch failed');
    expect(serialized).toContain(
      'caused by: InvalidArgumentError: invalid transfer-encoding header',
    );
    expect(serialized).toContain('at processHeader (request.js:1:1)');
  });

  it('describes a non-Error cause and stops on a cyclic chain', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    createLogger('Module').error(new Error('outer', { cause: { code: 'ECONNRESET' } }));
    expect(spy.mock.calls[0][1]).toContain('caused by: {"code":"ECONNRESET"}');

    const cyclic = new Error('loop');
    Object.assign(cyclic, { cause: cyclic });
    createLogger('Module').error(cyclic);
    const serialized = spy.mock.calls[1][1] as string;
    expect(serialized).toContain('[cause chain truncated]');
    expect(serialized.match(/caused by: /g)).toHaveLength(5);
  });

  it('passes non-Error arguments through untouched', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const payload = { count: 1 };
    createLogger('App').info('initialized', payload);
    expect(spy.mock.calls[0][1]).toBe('initialized');
    expect(spy.mock.calls[0][2]).toBe(payload);
  });
});

describe('createLogger with debug level', () => {
  it('debug calls console.debug when NEXT_PUBLIC_LOG_LEVEL is debug', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_LOG_LEVEL = 'debug';
    const { createLogger: createLoggerDebug } = await import('./logger');
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const logger = createLoggerDebug('DebugTest');
    logger.debug('trace message', { data: 1 });
    expect(spy).toHaveBeenCalledWith('[DebugTest]', 'trace message', { data: 1 });
    delete process.env.NEXT_PUBLIC_LOG_LEVEL;
    vi.resetModules();
  });
});
