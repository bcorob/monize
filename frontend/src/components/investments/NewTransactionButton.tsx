'use client';

import { useState, useRef, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { useClickOutside } from '@/hooks/useClickOutside';
import { ChevronDownIcon } from '@heroicons/react/24/outline';

interface NewTransactionButtonProps {
  onNewInvestment: () => void;
  onNewCash: () => void;
}

const menuItemClass =
  'w-full px-4 py-2 text-left text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700';

export function NewTransactionButton({ onNewInvestment, onNewCash }: NewTransactionButtonProps) {
  const t = useTranslations('investments');
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

  const handleInvestment = () => {
    close();
    onNewInvestment();
  };

  const handleCash = () => {
    close();
    onNewCash();
  };

  return (
    <div ref={dropdownRef} className="relative block w-full sm:inline-block sm:w-auto">
      <Button
        ref={triggerRef}
        onClick={() => setIsOpen((open) => !open)}
        className="w-full gap-1.5 whitespace-nowrap sm:w-auto"
        aria-haspopup="true"
        aria-expanded={isOpen}
      >
        {t('newTransactionButton.label')}
        {/* A menu caret trails its label, as ActionMenu's does. */}
        <ChevronDownIcon className="h-3 w-3" aria-hidden="true" />
      </Button>

      {isOpen && (
        <div className="absolute right-0 mt-1 w-full sm:w-56 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md shadow-lg z-50">
          <button onClick={handleInvestment} className={`${menuItemClass} rounded-t-md`}>
            {t('newTransactionButton.investmentTransaction')}
          </button>
          <button onClick={handleCash} className={`${menuItemClass} rounded-b-md`}>
            {t('newTransactionButton.cashTransaction')}
          </button>
        </div>
      )}
    </div>
  );
}
