'use client';

import { useTranslations } from 'next-intl';
import {
  DocumentIcon,
  ExclamationTriangleIcon,
  PhotoIcon,
  TableCellsIcon,
} from '@heroicons/react/24/outline';
import { Badge } from '@/components/ui/Badge';
import { TABLE_BODY_CLASS } from '@/components/ui/Table';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import {
  SHARE_MAX_FILES,
  SHARE_MAX_FILE_BYTES,
  SHARE_MAX_TOTAL_BYTES,
  type ShareRejectionReason,
} from '@/lib/share-target';
import type { SharedBundleItem } from '@/lib/share-inbox';

/**
 * Every file the OS handed over, accepted or not.
 *
 * A refused file stays on the list with the reason it was refused: a share that
 * silently drops what it cannot use leaves the user wondering which of the
 * files they picked actually arrived.
 */
export function SharedFileList({ items }: { items: SharedBundleItem[] }) {
  const t = useTranslations('share');
  const { formatBytes } = useNumberFormat();

  // The reasons name the limit that refused the file, so the numbers come from
  // the limits themselves rather than being written into the copy.
  const reasonValues: Record<ShareRejectionReason, Record<string, string | number>> = {
    unsupported: {},
    tooLarge: { max: formatBytes(SHARE_MAX_FILE_BYTES) },
    tooMany: { max: SHARE_MAX_FILES },
    shareTooLarge: { max: formatBytes(SHARE_MAX_TOTAL_BYTES) },
  };

  return (
    // Not a table, but the row-divider rule is the same one and it lives in
    // exactly one place; a second copy of the string is what Table.tsx exists
    // to prevent.
    <ul className={TABLE_BODY_CLASS}>
      {items.map((item, index) => {
        const { entry } = item;
        const unusable = item.file === null;
        return (
          <li
            key={`${entry.name}-${index}`}
            className="flex items-start gap-3 py-3"
          >
            <FileGlyph item={item} />
            <div className="min-w-0 flex-1">
              <p
                className={`truncate text-sm font-medium ${
                  unusable
                    ? 'text-gray-500 dark:text-gray-400'
                    : 'text-gray-900 dark:text-gray-100'
                }`}
              >
                {entry.name}
              </p>
              <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                {formatBytes(entry.size)}
              </p>
              {item.missing && (
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {t('unavailableHint')}
                </p>
              )}
              {entry.reason && (
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {t(`reasons.${entry.reason}`, reasonValues[entry.reason])}
                </p>
              )}
            </div>
            {item.missing && (
              <Badge variant="amber" size="sm">
                {t('unavailable')}
              </Badge>
            )}
            {entry.reason && (
              <Badge variant="gray" size="sm">
                {t('rejected')}
              </Badge>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function FileGlyph({ item }: { item: SharedBundleItem }) {
  const className = 'h-6 w-6 shrink-0 text-gray-400 dark:text-gray-500';
  if (item.file === null) {
    return <ExclamationTriangleIcon aria-hidden className={className} />;
  }
  if (item.entry.kind === 'statement') {
    return <TableCellsIcon aria-hidden className={className} />;
  }
  if (item.entry.type.startsWith('image/')) {
    return <PhotoIcon aria-hidden className={className} />;
  }
  return <DocumentIcon aria-hidden className={className} />;
}
