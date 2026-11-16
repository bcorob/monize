import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, waitFor } from '@testing-library/react';
import { renderHook } from '@/test/render';
import { usePayeeContactLookup } from './usePayeeContactLookup';
import { payeesApi } from '@/lib/payees';
import type { Payee, PayeeContactSuggestion } from '@/types/payee';

vi.mock('@/lib/payees', () => ({
  payeesApi: { lookupContactForPayee: vi.fn(), update: vi.fn() },
}));

const lookupContactForPayee = vi.mocked(payeesApi.lookupContactForPayee);
const update = vi.mocked(payeesApi.update);

const payee = (id: string, name: string) =>
  ({ id, name, website: null, address: null, email: null, phone: null }) as Payee;

const suggestion = (website: string): PayeeContactSuggestion => ({
  label: null,
  website,
  address: null,
  email: null,
  phone: null,
  source: 'ai-web-search',
  confidence: 'high',
  notes: null,
  refined: [],
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('usePayeeContactLookup', () => {
  it('shows the candidates against the payee they were fetched for', async () => {
    lookupContactForPayee.mockResolvedValue({
      reason: 'ok',
      suggestions: [suggestion('https://acme.example')],
    } as never);

    const { result } = renderHook(() => usePayeeContactLookup());
    await act(async () => {
      await result.current.lookUp(payee('p1', 'Acme'));
    });

    expect(result.current.target?.id).toBe('p1');
    expect(result.current.candidates).toHaveLength(1);
    // The lookup itself writes nothing.
    expect(update).not.toHaveBeenCalled();
  });

  it('drops an answer whose request was overtaken by a newer payee', async () => {
    // Two quick creates: the first answer must not be shown against the second
    // payee, whose name it says nothing about.
    let settleFirst: (value: unknown) => void = () => {};
    lookupContactForPayee.mockImplementationOnce(
      () => new Promise((resolve) => { settleFirst = resolve; }) as never,
    );
    lookupContactForPayee.mockResolvedValueOnce({
      reason: 'ok',
      suggestions: [suggestion('https://second.example')],
    } as never);

    const { result } = renderHook(() => usePayeeContactLookup());
    act(() => {
      void result.current.lookUp(payee('p1', 'First'));
    });
    await act(async () => {
      await result.current.lookUp(payee('p2', 'Second'));
    });
    await act(async () => {
      settleFirst({ reason: 'ok', suggestions: [suggestion('https://first.example')] });
    });

    expect(result.current.target?.id).toBe('p2');
    expect(result.current.candidates[0].website).toBe('https://second.example');
  });

  it('saves the confirmed fields against the payee that was looked up', async () => {
    lookupContactForPayee.mockResolvedValue({
      reason: 'ok',
      suggestions: [suggestion('https://acme.example')],
    } as never);
    update.mockResolvedValue({ ...payee('p1', 'Acme'), website: 'https://acme.example' } as never);
    const onApplied = vi.fn();

    const { result } = renderHook(() => usePayeeContactLookup({ onApplied }));
    await act(async () => {
      await result.current.lookUp(payee('p1', 'Acme'));
    });
    await act(async () => {
      await result.current.apply({ website: 'https://acme.example' });
    });

    expect(update).toHaveBeenCalledWith('p1', { website: 'https://acme.example' });
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
    expect(result.current.target).toBeNull();
  });

  it('writes nothing when there is nothing open to confirm', async () => {
    const { result } = renderHook(() => usePayeeContactLookup());
    await act(async () => {
      await result.current.apply({ website: 'https://acme.example' });
    });
    expect(update).not.toHaveBeenCalled();
  });
});
