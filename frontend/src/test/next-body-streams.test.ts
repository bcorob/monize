import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { getCloneableBody } from 'next/dist/server/body-streams';

/**
 * Next clones the body of every non-GET request the proxy (`src/proxy.ts`)
 * matches, hands the clone to the proxy, then calls `finalize()`, which swaps
 * the buffered copy in for the original request stream. Unpatched, that swap
 * copied a plain Readable's event table and `_destroy` onto the live
 * IncomingMessage, so a client that disconnected while the response was still
 * streaming made Node's `abortIncoming` emit an `aborted` error nobody listened
 * for: `uncaughtException: Error: aborted` in the frontend log (#1442).
 *
 * `patches/next+*.patch` keeps the request's own listeners and destroy
 * behaviour. These tests drive the same calls `next-server.js` makes, in the
 * same order, against a real socket; they fail if the patch stops applying.
 */

interface Harness {
  readonly port: number;
  readonly unhandledErrors: Error[];
  readonly bodiesAfterFinalize: string[];
  readonly closed: Promise<void>;
}

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function startHarness({ readAfterFinalize }: { readAfterFinalize: boolean }): Promise<Harness> {
  const unhandledErrors: Error[] = [];
  const bodiesAfterFinalize: string[] = [];
  let markClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });

  const server = http.createServer(async (req, res) => {
    const body = getCloneableBody(req);
    const clone = body.cloneBodyStream();
    for await (const chunk of clone) void chunk; // what the proxy's own read does
    await body.finalize();

    // An `error` emitted with no listener is what becomes the uncaught
    // exception; record it instead of letting it throw inside the test runner.
    const emit = req.emit;
    req.emit = function recordUnhandled(this: http.IncomingMessage, type: string | symbol, ...args: unknown[]) {
      if (type === 'error' && this.listenerCount('error') === 0) {
        unhandledErrors.push(args[0] as Error);
        return false;
      }
      return emit.call(this, type, ...args);
    } as typeof req.emit;
    req.on('close', () => markClosed());

    if (readAfterFinalize) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      bodiesAfterFinalize.push(Buffer.concat(chunks).toString('utf8'));
      res.end('done');
      return;
    }

    // The backend is still answering: the response stays open.
    res.write('partial');
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { port, unhandledErrors, bodiesAfterFinalize, closed };
}

function sendPost(port: number, body: string): net.Socket {
  const socket = net.connect(port, '127.0.0.1');
  socket.on('error', () => undefined);
  socket.write(
    `POST /api/v1/transactions HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
      `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
  return socket;
}

describe('Next body cloning (patched next/dist/server/body-streams)', () => {
  it('emits no unhandled error when the client disconnects mid-response', async () => {
    const harness = await startHarness({ readAfterFinalize: false });
    const socket = sendPost(harness.port, '{"amount":1}');
    await new Promise<void>((resolve) => socket.once('data', () => resolve()));

    socket.destroy();
    await harness.closed;
    await new Promise((resolve) => setImmediate(resolve));

    expect(harness.unhandledErrors).toEqual([]);
  });

  it('still serves the buffered body to a reader after finalize', async () => {
    const harness = await startHarness({ readAfterFinalize: true });
    const socket = sendPost(harness.port, '{"amount":1}');
    await new Promise<void>((resolve) => socket.once('data', () => resolve()));
    socket.destroy();

    expect(harness.bodiesAfterFinalize).toEqual(['{"amount":1}']);
    expect(harness.unhandledErrors).toEqual([]);
  });
});
