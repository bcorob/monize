'use client';

import { useEffect } from 'react';
import { BOOT_SPLASH_ID } from '@/components/layout/BootSplash';

// Hides the server-rendered boot splash once the client app has actually
// mounted. This sits inside ThemeProvider on purpose: the provider renders
// null until it has read localStorage, so this component's mount effect only
// fires on the commit that put the real app tree on screen.
//
// It must HIDE the splash, never detach it. The splash is part of React's
// server-rendered tree, and removing a React-owned node outside React
// corrupts the reconciler's view of <body>: the next client-side navigation
// then throws insertBefore/removeChild NotFoundError ("not a child of this
// node") and every page renders the error boundary. An inline display:none
// wins over the stylesheet's display:flex and changes no tree structure.
export function BootSplashHider() {
  useEffect(() => {
    const splash = document.getElementById(BOOT_SPLASH_ID);
    if (splash) {
      splash.style.display = 'none';
    }
  }, []);

  return null;
}
