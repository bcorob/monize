import type { ComponentType, SVGProps } from 'react';
import {
  ArrowDownTrayIcon,
  ArrowTrendingUpIcon,
  ArrowsRightLeftIcon,
  BanknotesIcon,
  BuildingLibraryIcon,
  BuildingOffice2Icon,
  CalendarDaysIcon,
  ChartBarIcon,
  ChartPieIcon,
  ChatBubbleLeftRightIcon,
  Cog6ToothIcon,
  CurrencyDollarIcon,
  HashtagIcon,
  LightBulbIcon,
  ShieldCheckIcon,
  Squares2X2Icon,
  TagIcon,
  UsersIcon,
} from '@heroicons/react/24/outline';

export type NavIcon = ComponentType<SVGProps<SVGSVGElement>>;

export interface NavLinkDef {
  href: string;
  /** Translation key in the `navigation` namespace. */
  labelKey: string;
  badge?: string;
}

/**
 * The app's navigation, declared once: the link arrays the header and the
 * mobile drawer render, and the icon each route carries wherever nav items
 * show icons (the drawer, the header dropdowns). Keeping the map beside the
 * arrays is what lets a test hold "every nav route has an icon" -- an entry
 * added to one without the other fails `nav-links.test.ts` instead of
 * shipping a bare row.
 */
export const NAV_LINKS: NavLinkDef[] = [
  { href: '/transactions', labelKey: 'transactions' },
  { href: '/bills', labelKey: 'bills' },
  { href: '/investments', labelKey: 'investments' },
  { href: '/accounts', labelKey: 'accounts' },
  { href: '/budgets', labelKey: 'budgets' },
  { href: '/reports', labelKey: 'reports' },
];

export const TOOLS_LINKS: NavLinkDef[] = [
  { href: '/categories', labelKey: 'categories' },
  { href: '/payees', labelKey: 'payees' },
  { href: '/institutions', labelKey: 'institutions' },
  { href: '/tags', labelKey: 'tags' },
  { href: '/securities', labelKey: 'securities' },
  { href: '/currencies', labelKey: 'currencies' },
  { href: '/import', labelKey: 'import' },
];

export const AI_LINKS: NavLinkDef[] = [
  { href: '/insights', labelKey: 'insights' },
  { href: '/ai', labelKey: 'aiAssistant' },
];

/** Icon per route, including the fixed drawer entries outside the arrays. */
export const NAV_ICONS: Record<string, NavIcon> = {
  '/dashboard': Squares2X2Icon,
  '/transactions': ArrowsRightLeftIcon,
  '/bills': CalendarDaysIcon,
  '/investments': ArrowTrendingUpIcon,
  '/accounts': BuildingLibraryIcon,
  '/budgets': ChartPieIcon,
  '/reports': ChartBarIcon,
  '/insights': LightBulbIcon,
  '/ai': ChatBubbleLeftRightIcon,
  '/categories': TagIcon,
  '/payees': UsersIcon,
  '/institutions': BuildingOffice2Icon,
  '/tags': HashtagIcon,
  '/securities': BanknotesIcon,
  '/currencies': CurrencyDollarIcon,
  '/import': ArrowDownTrayIcon,
  '/admin/users': ShieldCheckIcon,
  '/settings': Cog6ToothIcon,
};
