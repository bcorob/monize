'use client';

import { MutableRefObject, useLayoutEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import {
  delegationApi,
  DelegateSummary,
  AccountGrant,
  DelegateCapabilities,
  DelegateSectionFlags,
} from '@/lib/delegation';
import { Account, AccountType } from '@/types/account';
import { formatAccountType } from '@/lib/account-utils';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { Button } from '@/components/ui/Button';
import { Tabs } from '@/components/ui/Tabs';

const logger = createLogger('DelegateAccessModal');

type GrantOp = 'canRead' | 'canCreate' | 'canEdit' | 'canDelete' | 'isJoint';
type CapOp = 'create' | 'edit' | 'delete';
type CapResource = 'payees' | 'categories' | 'tags';
type SectionKey =
  | 'bills'
  | 'investments'
  | 'budgets'
  | 'reports'
  | 'ai'
  | 'warranties';
type Tab = 'sections' | 'accounts' | 'shared';

interface DraftGrant {
  canRead: boolean;
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
  isJoint: boolean;
}

interface Draft {
  grants: Record<string, DraftGrant>;
  capabilities: Record<CapResource, Record<CapOp, boolean>>;
  sections: Record<SectionKey, boolean>;
}

// Every name below is a catalog key under `settings.delegateAccessModal`.
type OpName = 'read' | 'create' | 'edit' | 'delete' | 'joint';

const GRANT_OPS: { key: GrantOp; labelKey: `ops.${OpName}` }[] = [
  { key: 'canRead', labelKey: 'ops.read' },
  { key: 'canCreate', labelKey: 'ops.create' },
  { key: 'canEdit', labelKey: 'ops.edit' },
  { key: 'canDelete', labelKey: 'ops.delete' },
  // Joint: with Read, the account appears natively in the delegate's own
  // account list. Only offered for delegates with a full Monize account.
  { key: 'isJoint', labelKey: 'ops.joint' },
];

const CAP_RESOURCES: { key: CapResource; labelKey: `shared.resources.${CapResource}` }[] = [
  { key: 'payees', labelKey: 'shared.resources.payees' },
  { key: 'categories', labelKey: 'shared.resources.categories' },
  { key: 'tags', labelKey: 'shared.resources.tags' },
];

const CAP_OPS: { op: CapOp; labelKey: `ops.${CapOp}` }[] = [
  { op: 'create', labelKey: 'ops.create' },
  { op: 'edit', labelKey: 'ops.edit' },
  { op: 'delete', labelKey: 'ops.delete' },
];

const SECTIONS: SectionKey[] = ['bills', 'investments', 'budgets', 'reports', 'ai', 'warranties'];

const SECTION_FIELD: Record<SectionKey, keyof DelegateSectionFlags> = {
  bills: 'billsCanRead',
  investments: 'investmentsCanRead',
  budgets: 'budgetsCanRead',
  reports: 'reportsCanRead',
  ai: 'aiCanRead',
  warranties: 'warrantiesCanRead',
};

function emptyGrant(): DraftGrant {
  return {
    canRead: false,
    canCreate: false,
    canEdit: false,
    canDelete: false,
    isJoint: false,
  };
}

function buildInitialDraft(delegate: DelegateSummary): Draft {
  const grants: Record<string, DraftGrant> = {};
  for (const g of delegate.grants) {
    grants[g.accountId] = {
      canRead: !!g.canRead,
      canCreate: !!g.canCreate,
      canEdit: !!g.canEdit,
      canDelete: !!g.canDelete,
      // Must round-trip: the save is delete-and-recreate server-side, so a
      // draft that dropped this flag would silently clear every joint share.
      isJoint: !!g.isJoint,
    };
  }
  const caps = delegate.capabilities;
  return {
    grants,
    capabilities: {
      payees: { ...caps.payees },
      categories: { ...caps.categories },
      tags: { ...caps.tags },
    },
    sections: {
      bills: !!delegate.sections?.bills,
      investments: !!delegate.sections?.investments,
      budgets: !!delegate.sections?.budgets,
      reports: !!delegate.sections?.reports,
      ai: !!delegate.sections?.ai,
      warranties: !!delegate.sections?.warranties,
    },
  };
}

/** Apply READ-prerequisite rules to a single grant change. */
function applyGrantRule(
  current: DraftGrant,
  op: GrantOp,
  value: boolean,
): DraftGrant {
  const next: DraftGrant = { ...current, [op]: value };
  if (op === 'canRead' && !value) {
    next.canCreate = false;
    next.canEdit = false;
    next.canDelete = false;
    next.isJoint = false;
  }
  if (op !== 'canRead' && value) {
    next.canRead = true;
  }
  return next;
}

function grantsToArray(
  accounts: Account[],
  grants: Record<string, DraftGrant>,
): AccountGrant[] {
  return accounts
    .map((a) => ({ accountId: a.id, ...(grants[a.id] ?? emptyGrant()) }))
    .filter((g) => g.canRead);
}

interface DelegateAccessModalProps {
  delegate: DelegateSummary;
  accounts: Account[];
  onCancel: () => void;
  onSaved: () => void;
  setFormDirty: (dirty: boolean) => void;
  submitRef: MutableRefObject<(() => void) | null>;
}

export function DelegateAccessModal({
  delegate,
  accounts,
  onCancel,
  onSaved,
  setFormDirty,
  submitRef,
}: DelegateAccessModalProps) {
  const t = useTranslations('settings.delegateAccessModal');
  const tc = useTranslations('common');
  const baseline = useMemo(
    () => buildInitialDraft(delegate),
    [delegate],
  );
  const [draft, setDraft] = useState<Draft>(baseline);
  const [tab, setTab] = useState<Tab>('accounts');
  const [saving, setSaving] = useState(false);
  // Joint shares require the delegate to be a full Monize account; the
  // server re-checks on save (setGrants rejects otherwise).
  const jointAllowed = !!delegate.delegate.isFullAccount;

  // Only accounts the caller owns can be re-shared. `GET /accounts` returns a
  // union in own context -- own accounts plus accounts jointly shared *to* the
  // caller (`isJoint`), which belong to another owner. Those are neither
  // visible nor assignable here: a delegate must not be able to pass on access
  // they were given. The server refuses them too (setGrants -> 403), so an
  // unfiltered list could only ever offer a toggle that fails the save.
  const grantableAccounts = useMemo(
    () => accounts.filter((a) => !a.isJoint),
    [accounts],
  );

  const groupedAccounts = useMemo(() => {
    const groups = new Map<AccountType, Account[]>();
    for (const a of grantableAccounts) {
      const list = groups.get(a.accountType) ?? [];
      list.push(a);
      groups.set(a.accountType, list);
    }
    for (const list of groups.values()) {
      list.sort((a, b) => a.name.localeCompare(b.name));
    }
    return Array.from(groups.entries()).sort((x, y) =>
      formatAccountType(x[0], tc).localeCompare(formatAccountType(y[0], tc)),
    );
  }, [grantableAccounts, tc]);

  const baselineGrantArray = useMemo(
    () => grantsToArray(grantableAccounts, baseline.grants),
    [grantableAccounts, baseline],
  );

  // Diffs against the baseline drive both the dirty flag and the batched save.
  const grantChanged =
    JSON.stringify(grantsToArray(grantableAccounts, draft.grants)) !==
    JSON.stringify(baselineGrantArray);

  const capabilityPatch: DelegateCapabilities = {};
  for (const { key: resource } of CAP_RESOURCES) {
    for (const { op } of CAP_OPS) {
      if (
        draft.capabilities[resource][op] !==
        baseline.capabilities[resource][op]
      ) {
        const cap = op.charAt(0).toUpperCase() + op.slice(1);
        const field =
          `${resource}Can${cap}` as keyof DelegateCapabilities;
        capabilityPatch[field] = draft.capabilities[resource][op];
      }
    }
  }

  const sectionPatch: DelegateSectionFlags = {};
  for (const key of SECTIONS) {
    if (draft.sections[key] !== baseline.sections[key]) {
      sectionPatch[SECTION_FIELD[key]] = draft.sections[key];
    }
  }

  const dirty =
    grantChanged ||
    Object.keys(capabilityPatch).length > 0 ||
    Object.keys(sectionPatch).length > 0;
  setFormDirty(dirty);

  const setGrant = (accountId: string, op: GrantOp, value: boolean) => {
    setDraft((prev) => ({
      ...prev,
      grants: {
        ...prev.grants,
        [accountId]: applyGrantRule(
          prev.grants[accountId] ?? emptyGrant(),
          op,
          value,
        ),
      },
    }));
  };

  const setColumnForAccounts = (
    accountIds: string[],
    op: GrantOp,
    value: boolean,
  ) => {
    setDraft((prev) => {
      const grants = { ...prev.grants };
      for (const id of accountIds) {
        grants[id] = applyGrantRule(grants[id] ?? emptyGrant(), op, value);
      }
      return { ...prev, grants };
    });
  };

  const setCapability = (
    resource: CapResource,
    op: CapOp,
    value: boolean,
  ) => {
    setDraft((prev) => ({
      ...prev,
      capabilities: {
        ...prev.capabilities,
        [resource]: { ...prev.capabilities[resource], [op]: value },
      },
    }));
  };

  const setSection = (key: SectionKey, value: boolean) => {
    setDraft((prev) => ({
      ...prev,
      sections: { ...prev.sections, [key]: value },
    }));
  };

  const handleSave = async () => {
    if (!dirty) {
      onSaved();
      return;
    }
    setSaving(true);
    try {
      const calls: Promise<void>[] = [];
      if (grantChanged) {
        calls.push(
          delegationApi.setGrants(
            delegate.id,
            grantsToArray(grantableAccounts, draft.grants),
          ),
        );
      }
      if (Object.keys(capabilityPatch).length > 0) {
        calls.push(
          delegationApi.setCapabilities(delegate.id, capabilityPatch),
        );
      }
      if (Object.keys(sectionPatch).length > 0) {
        calls.push(
          delegationApi.setSectionGrants(delegate.id, sectionPatch),
        );
      }
      await Promise.all(calls);
      toast.success(t('toasts.saved'));
      setFormDirty(false);
      onSaved();
    } catch (err) {
      toast.error(getErrorMessage(err, t('toasts.saveFailed')));
      logger.error(err);
    } finally {
      setSaving(false);
    }
  };

  // Kept pointing at this render's save after commit, never written during render.
  useLayoutEffect(() => {
    submitRef.current = () => {
      void handleSave();
    };
  });

  const tabs: { key: Tab; label: string }[] = [
    { key: 'accounts', label: t('tabs.accounts') },
    { key: 'sections', label: t('tabs.sections') },
    { key: 'shared', label: t('tabs.shared') },
  ];

  return (
    <div className="flex flex-col max-h-[90vh]">
      <div className="border-b border-gray-200 dark:border-gray-700 px-4 py-3">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {t('title')}
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {delegate.delegate.email}
        </p>
      </div>

      {/* The shared tab bar, which this markup was the model for -- keeping a
          second copy of it meant keeping a copy without the roving tabindex or
          the arrow keys. */}
      <Tabs
        tabs={tabs}
        value={tab}
        onChange={setTab}
        idPrefix="delegate-access"
        ariaLabel={t('title')}
        className="px-2"
      />

      <div className="overflow-y-auto px-4 py-3 h-[65vh]">
        {tab === 'sections' && (
          <div className="space-y-3">
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {t('sections.description')}
            </p>
            {SECTIONS.map((key) => {
              const label = t(`sections.${key}.label`);
              const description = t(`sections.${key}.description`);
              return (
                <div
                  key={key}
                  className="flex items-center justify-between gap-4 border-b border-gray-100 dark:border-gray-700/50 pb-2"
                >
                  <div>
                    <p className="text-sm font-medium text-gray-800 dark:text-gray-200">
                      {label}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {description}
                    </p>
                    {key === 'ai' && (
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {t('sections.aiRequiresFullAccess')}
                      </p>
                    )}
                  </div>
                  <ToggleSwitch
                    checked={draft.sections[key]}
                    onChange={(v) => setSection(key, v)}
                    label={t('sections.toggleLabel', { section: label })}
                  />
                </div>
              );
            })}
          </div>
        )}

        {tab === 'accounts' && (
          <div className="space-y-3">
            {grantableAccounts.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {t('accounts.noAccounts')}
              </p>
            ) : (
              groupedAccounts.map(([type, list]) => {
                const typeLabel = formatAccountType(type, tc);
                const ids = list.map((a) => a.id);
                return (
                  <details
                    key={type}
                    open
                    className="border border-gray-200 dark:border-gray-700 rounded-lg"
                  >
                    <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium text-gray-800 dark:text-gray-200">
                      {typeLabel}{' '}
                      <span className="text-xs text-gray-400">
                        ({list.length})
                      </span>
                    </summary>
                    <div className="px-3 pb-3">
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-gray-100 dark:border-gray-700/50 pb-2 mb-2">
                        <span className="w-40 text-xs uppercase tracking-wide text-gray-400">
                          {t('accounts.grantAll')}
                        </span>
                        {GRANT_OPS.map((o) => (
                          <label
                            key={o.key}
                            className="flex items-center gap-1.5"
                            title={
                              o.key === 'isJoint' && !jointAllowed
                                ? t('accounts.jointRequiresFullAccount')
                                : undefined
                            }
                          >
                            <ToggleSwitch
                              size="sm"
                              checked={list.every(
                                (a) =>
                                  !!(draft.grants[a.id] ?? emptyGrant())[
                                    o.key
                                  ],
                              )}
                              disabled={o.key === 'isJoint' && !jointAllowed}
                              onChange={(v) =>
                                setColumnForAccounts(ids, o.key, v)
                              }
                              label={t('accounts.grantAllLabel', { op: t(o.labelKey), type: typeLabel })}
                            />
                            <span className="text-xs">{t(o.labelKey)}</span>
                          </label>
                        ))}
                      </div>
                      <div className="space-y-2">
                        {list.map((a) => {
                          const g = draft.grants[a.id] ?? emptyGrant();
                          return (
                            <div
                              key={a.id}
                              className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-700 dark:text-gray-300"
                            >
                              <span className="w-40 truncate font-medium">
                                {a.name}
                              </span>
                              {GRANT_OPS.map((o) => (
                                <label
                                  key={o.key}
                                  className="flex items-center gap-1.5"
                                  title={
                                    o.key === 'isJoint' && !jointAllowed
                                      ? t('accounts.jointRequiresFullAccount')
                                      : undefined
                                  }
                                >
                                  <ToggleSwitch
                                    size="sm"
                                    checked={!!g[o.key]}
                                    disabled={
                                      (o.key !== 'canRead' && !g.canRead) ||
                                      (o.key === 'isJoint' && !jointAllowed)
                                    }
                                    onChange={(v) =>
                                      setGrant(a.id, o.key, v)
                                    }
                                    label={t('accounts.grantLabel', { op: t(o.labelKey), account: a.name })}
                                  />
                                  <span className="text-xs">{t(o.labelKey)}</span>
                                </label>
                              ))}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </details>
                );
              })
            )}
          </div>
        )}

        {tab === 'shared' && (
          <div className="space-y-2">
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
              {t('shared.description')}
            </p>
            {CAP_RESOURCES.map((res) => (
              <div
                key={res.key}
                className="flex items-center gap-x-3 text-sm text-gray-700 dark:text-gray-300 border-b border-gray-100 dark:border-gray-700/50 pb-2"
              >
                <span className="w-24 shrink-0 truncate font-medium">
                  {t(res.labelKey)}
                </span>
                {CAP_OPS.map((o) => (
                  <label key={o.op} className="flex items-center gap-1.5">
                    <ToggleSwitch
                      size="sm"
                      checked={draft.capabilities[res.key][o.op]}
                      onChange={(v) => setCapability(res.key, o.op, v)}
                      label={t('shared.toggleLabel', { op: t(o.labelKey), resource: t(res.labelKey) })}
                    />
                    <span className="text-xs">{t(o.labelKey)}</span>
                  </label>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-gray-200 dark:border-gray-700 px-4 py-3 flex justify-end gap-3">
        <Button variant="outline" onClick={onCancel} disabled={saving}>
          {tc('cancel')}
        </Button>
        <Button
          onClick={() => void handleSave()}
          isLoading={saving}
          disabled={!dirty}
        >
          {t('saveButton')}
        </Button>
      </div>
    </div>
  );
}
