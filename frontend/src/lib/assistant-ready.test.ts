import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assistantCanAnswerNow } from './assistant-ready';

const api = vi.hoisted(() => ({ getStatus: vi.fn(), getRelayStatus: vi.fn() }));
vi.mock('@/lib/ai', () => ({ aiApi: api }));

const status = (over: Record<string, unknown> = {}) => ({
  configured: true,
  encryptionAvailable: true,
  activeProviders: 1,
  hasSystemDefault: false,
  systemDefaultProvider: null,
  systemDefaultModel: null,
  relayActive: false,
  ...over,
});

describe('assistantCanAnswerNow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getStatus.mockResolvedValue(status());
    api.getRelayStatus.mockResolvedValue({ state: 'listening', queued: 0 });
  });

  it('is true for a configured provider that is not the relay, without asking the relay', async () => {
    await expect(assistantCanAnswerNow()).resolves.toBe(true);
    expect(api.getRelayStatus).not.toHaveBeenCalled();
  });

  it('is false with no provider configured, without asking the relay', async () => {
    api.getStatus.mockResolvedValue(status({ configured: false }));
    await expect(assistantCanAnswerNow()).resolves.toBe(false);
    expect(api.getRelayStatus).not.toHaveBeenCalled();
  });

  it.each([['listening'], ['busy']])('is true when the relay is the provider and its agent is %s', async (state) => {
    api.getStatus.mockResolvedValue(status({ relayActive: true }));
    api.getRelayStatus.mockResolvedValue({ state, queued: 0 });
    await expect(assistantCanAnswerNow()).resolves.toBe(true);
  });

  it('is false when the relay is the provider but its agent is not connected', async () => {
    api.getStatus.mockResolvedValue(status({ relayActive: true }));
    api.getRelayStatus.mockResolvedValue({ state: 'offline', queued: 0 });
    await expect(assistantCanAnswerNow()).resolves.toBe(false);
  });

  it('is false for an agent that was disconnected after a spell of inactivity', async () => {
    api.getStatus.mockResolvedValue(status({ relayActive: true }));
    api.getRelayStatus.mockResolvedValue({ state: 'offline', queued: 0, idleDisconnected: true });
    await expect(assistantCanAnswerNow()).resolves.toBe(false);
  });

  it('is false when the status cannot be read: not being able to ask is not a yes', async () => {
    api.getStatus.mockRejectedValue(new Error('offline'));
    await expect(assistantCanAnswerNow()).resolves.toBe(false);
  });

  it('is false when the relay status cannot be read', async () => {
    api.getStatus.mockResolvedValue(status({ relayActive: true }));
    api.getRelayStatus.mockRejectedValue(new Error('offline'));
    await expect(assistantCanAnswerNow()).resolves.toBe(false);
  });
});
