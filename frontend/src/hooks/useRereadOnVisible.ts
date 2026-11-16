import { useEffect } from 'react';

/**
 * Run `reread` whenever the page becomes visible or regains focus.
 *
 * The notification permission, the OS notification toggle and the display mode
 * are all changed ELSEWHERE -- site settings, iOS Settings, "Add to Home
 * Screen" -- and then returned to. Read once at mount, a surface goes on
 * offering a button the browser has started refusing, or keeps telling an
 * installed app to install itself. Three surfaces (the push banner, the devices
 * panel, the diagnostics) carried this listener wiring by hand; one copy means
 * the next fix (a `pageshow` for BFCache restores, say) lands in all three.
 *
 * `reread` should be referentially stable (`useCallback`) so the listeners are
 * not re-registered on every render.
 */
export function useRereadOnVisible(reread: () => void): void {
  useEffect(() => {
    const onReturn = () => {
      if (document.visibilityState !== 'visible') return;
      reread();
    };
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('focus', onReturn);
    return () => {
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('focus', onReturn);
    };
  }, [reread]);
}
