/**
 * Whether a nav entry is the section the current page belongs to.
 *
 * A detail page is *in* its list's section: `/accounts/<id>` is Accounts,
 * `/payees/<id>` is Tools > Payees, `/reports/investment/<id>` is Reports. The
 * header compared the pathname to the href exactly, so opening an account from
 * the Accounts page unlit the tab the user had just come through, and nothing
 * in the bar said where they were.
 *
 * The match is the href itself or a path *below* it, with the boundary at a
 * slash so `/accounts` never claims `/accounts-archive`. `/settings` and
 * `/dashboard` pass through the same rule; they simply have nothing under them
 * today.
 */
export function isNavSectionActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
