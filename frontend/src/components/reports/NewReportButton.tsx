'use client';

import { useState, useRef, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { useClickOutside } from '@/hooks/useClickOutside';
import { ChevronDownIcon, PlusIcon } from '@heroicons/react/24/outline';

interface NewReportButtonProps {
  onNewStandard: () => void;
  onNewInvestment: () => void;
}

const menuItemClass =
  'w-full px-4 py-2 text-left text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700';

export function NewReportButton({ onNewStandard, onNewInvestment }: NewReportButtonProps) {
  const t = useTranslations('reports');
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => setIsOpen(false), []);

  useClickOutside(dropdownRef, close, {
    enabled: isOpen,
    onEscape: () => {
      close();
      triggerRef.current?.focus();
    },
  });

  const handleStandard = () => {
    close();
    onNewStandard();
  };

  const handleInvestment = () => {
    close();
    onNewInvestment();
  };

  return (
    <div ref={dropdownRef} className="relative block w-full sm:inline-block sm:w-auto">
      <Button
        ref={triggerRef}
        onClick={() => setIsOpen((open) => !open)}
        className="w-full whitespace-nowrap sm:w-auto inline-flex items-center justify-center gap-1.5"
        aria-haspopup="true"
        aria-expanded={isOpen}
      >
        <PlusIcon className="h-4 w-4" aria-hidden="true" />
        {t('newReportButton.newReport')}
        <ChevronDownIcon className="h-3 w-3" aria-hidden="true" />
      </Button>

      {isOpen && (
        <div className="absolute right-0 mt-1 w-full sm:w-56 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md shadow-lg z-50">
          <button onClick={handleStandard} className={`${menuItemClass} rounded-t-md`}>
            {t('newReportButton.standardReport')}
          </button>
          <button onClick={handleInvestment} className={`${menuItemClass} rounded-b-md`}>
            {t('newReportButton.investmentReport')}
          </button>
        </div>
      )}
    </div>
  );
}
