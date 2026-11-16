import type Cookies from 'js-cookie';

/**
 * Attributes for the preference cookies the client writes itself (locale,
 * resolved theme, colour palette). They are deliberately not HttpOnly: the
 * client both writes and reads them. They are marked Secure whenever the page
 * itself was served over HTTPS, so they never travel over plain HTTP; on a
 * plain-HTTP deployment the attribute is omitted, since the browser would
 * otherwise refuse to store the cookie at all.
 */
export function preferenceCookieAttributes(): Cookies.CookieAttributes {
  const secure =
    typeof window !== 'undefined' && window.location.protocol === 'https:';
  return {
    sameSite: 'lax',
    expires: 365,
    ...(secure ? { secure: true } : {}),
  };
}
