import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useTranslations } from 'next-intl';
import { act, render, screen } from '@/test/render';
import { MessageScopeGuard } from './MessageScopeGuard';

const refresh = vi.fn();
let pathname = '/login';

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ refresh }),
}));

const fetchMock = vi.fn();

function catalogResponse(body: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
}

/** Reads a key only the fetched catalog has, so the test sees which one is live. */
function Probe() {
  const t = useTranslations('fetchedOnly');
  return <p>{t('greeting')}</p>;
}

describe('MessageScopeGuard', () => {
  beforeEach(() => {
    refresh.mockClear();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    pathname = '/login';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders a public page under the public catalog without fetching', () => {
    render(
      <MessageScopeGuard scope="public">
        <p>app</p>
      </MessageScopeGuard>,
    );
    expect(screen.getByText('app')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('holds the app back, fetches every catalog and provides it when a sign-in leaves the public pages', async () => {
    fetchMock.mockReturnValue(
      catalogResponse({ fetchedOnly: { greeting: 'from the full catalog' } }),
    );
    const { rerender } = render(
      <MessageScopeGuard scope="public">
        <p>app</p>
      </MessageScopeGuard>,
    );

    // The probe's namespace exists only in the fetched catalog, so it renders
    // only once the guard is providing that catalog.
    pathname = '/dashboard';
    await act(async () => {
      rerender(
        <MessageScopeGuard scope="public">
          <Probe />
        </MessageScopeGuard>,
      );
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/intl-messages?locale=en',
      expect.objectContaining({ credentials: 'same-origin' }),
    );
    expect(screen.getByText('from the full catalog')).toBeInTheDocument();
  });

  it('never refreshes the router, whose cancelled refresh reloads the page', async () => {
    fetchMock.mockReturnValue(catalogResponse({}));
    const { rerender } = render(
      <MessageScopeGuard scope="public">
        <p>app</p>
      </MessageScopeGuard>,
    );
    pathname = '/dashboard';
    await act(async () => {
      rerender(
        <MessageScopeGuard scope="public">
          <p>app</p>
        </MessageScopeGuard>,
      );
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('renders the app on the catalog it has when the fetch fails, and does not retry', async () => {
    fetchMock.mockRejectedValue(new TypeError('NetworkError'));
    const { rerender } = render(
      <MessageScopeGuard scope="public">
        <p>app</p>
      </MessageScopeGuard>,
    );
    pathname = '/dashboard';
    await act(async () => {
      rerender(
        <MessageScopeGuard scope="public">
          <p>app</p>
        </MessageScopeGuard>,
      );
    });
    expect(screen.getByText('app')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('lets a public-to-public navigation through without a fetch', () => {
    const { rerender } = render(
      <MessageScopeGuard scope="public">
        <p>app</p>
      </MessageScopeGuard>,
    );
    pathname = '/register';
    rerender(
      <MessageScopeGuard scope="public">
        <p>app</p>
      </MessageScopeGuard>,
    );
    expect(screen.getByText('app')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders the page it landed on even when that path is not public', () => {
    // The not-found page for a dotted path the proxy never saw.
    pathname = '/missing.txt';
    render(
      <MessageScopeGuard scope="public">
        <p>not found</p>
      </MessageScopeGuard>,
    );
    expect(screen.getByText('not found')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never fetches under the full catalog', () => {
    pathname = '/dashboard';
    const { rerender } = render(
      <MessageScopeGuard scope="full">
        <p>app</p>
      </MessageScopeGuard>,
    );
    pathname = '/login';
    rerender(
      <MessageScopeGuard scope="full">
        <p>app</p>
      </MessageScopeGuard>,
    );
    expect(screen.getByText('app')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
