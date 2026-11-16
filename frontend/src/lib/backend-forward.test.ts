import { describe, it, expect, vi, afterEach } from 'vitest';
import { responseFromBackend } from './backend-forward';

describe('responseFromBackend', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('streams a well-behaved body through unchanged', async () => {
    const backendResponse = new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

    const response = responseFromBackend(backendResponse);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('{"ok":true}');
  });

  it('ends the stream cleanly instead of rejecting when the backend connection drops mid-body', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('partial'));
      },
      pull() {
        throw new TypeError('terminated', { cause: new Error('other side closed') });
      },
    });
    const backendResponse = new Response(body, { status: 200 });

    const response = responseFromBackend(backendResponse);
    const reader = response.body!.getReader();

    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('partial');

    // The underlying read rejects here; the wrapper must swallow it and end
    // the stream rather than let the rejection propagate to the caller
    // (which is what Next's own pipe would otherwise log as an unhandled
    // "failed to pipe response").
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
  });

  it('forwards cancellation to the backend reader', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('chunk'));
      },
      cancel,
    });
    const backendResponse = new Response(body, { status: 200 });

    const response = responseFromBackend(backendResponse);
    await response.body!.cancel('client disconnected');

    expect(cancel).toHaveBeenCalledWith('client disconnected');
  });
});
