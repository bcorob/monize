import type { ComponentType, SVGProps } from 'react';
import {
  ArchiveBoxIcon,
  ArrowDownIcon,
  ArrowPathIcon,
  ArrowUpIcon,
  ArrowUturnLeftIcon,
  ArrowsPointingInIcon,
  CalendarIcon,
  CheckCircleIcon,
  CheckIcon,
  ChevronDoubleRightIcon,
  ClipboardDocumentListIcon,
  DocumentDuplicateIcon,
  EyeIcon,
  EyeSlashIcon,
  FunnelIcon,
  NoSymbolIcon,
  PencilSquareIcon,
  StarIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';
import type { ActionIconKey } from './rowAction';

/**
 * The row-action icon set: one outline heroicon per verb, so every list shows
 * the same icon for the same action. Heroicons render inline SVG, so this
 * needs no external icon runtime under the CSP.
 */
const ACTION_ICONS: Record<ActionIconKey, ComponentType<SVGProps<SVGSVGElement>>> = {
  edit: PencilSquareIcon,
  view: EyeIcon,
  delete: TrashIcon,
  duplicate: DocumentDuplicateIcon,
  merge: ArrowsPointingInIcon,
  reconcile: CheckCircleIcon,
  post: CheckIcon,
  skip: ChevronDoubleRightIcon,
  close: ArchiveBoxIcon,
  reopen: ArrowPathIcon,
  reactivate: ArrowUturnLeftIcon,
  schedule: CalendarIcon,
  deactivate: NoSymbolIcon,
  activate: CheckCircleIcon,
  favorite: StarIcon,
  transactions: ClipboardDocumentListIcon,
  filter: FunnelIcon,
  moveUp: ArrowUpIcon,
  moveDown: ArrowDownIcon,
  hide: EyeSlashIcon,
};

export interface ActionIconProps {
  name: ActionIconKey;
  className?: string;
}

export function ActionIcon({ name, className = 'w-4 h-4' }: ActionIconProps) {
  const Icon = ACTION_ICONS[name];
  return <Icon className={className} aria-hidden="true" />;
}
