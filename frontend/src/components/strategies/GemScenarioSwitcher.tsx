"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { PlusIcon, TrashIcon } from "@heroicons/react/24/outline";
import {
  EntitySwitcher,
  type EntitySwitcherItem,
} from "@/components/ui/EntitySwitcher";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import type { GemStrategyRef } from "@/types/gem-strategy";

/**
 * What became of a confirmed create or delete.
 *
 * Three answers, because a boolean folded two of them together: "did not
 * happen" covered both the server refusing and the parent holding the action
 * behind an unsaved-changes prompt, and the dialog stayed open for both. Left
 * open through the second, the delete confirmation re-reads the current
 * scenario -- so once the deferred delete removed the one it was opened for,
 * the same dialog was pointed at whichever scenario took its place, and
 * confirming again deleted that.
 *
 * Only `"failed"` keeps a dialog on screen. `"deferred"` means the user has
 * said what they want and the unsaved-changes prompt is what they deal with
 * next; the action runs, or does not, without this dialog in the way.
 */
export type GemScenarioOutcome = "done" | "failed" | "deferred";

interface GemScenarioSwitcherProps {
  /**
   * The scenario on screen; it is not offered as a destination. Null before
   * the first save: there is nothing yet to switch away from or delete, so
   * only "start another one" is offered.
   */
  currentId: string | null;
  currentName: string;
  scenarios: readonly GemStrategyRef[];
  onSelect: (id: string) => void;
  /**
   * Creates the scenario and says what happened. The parent catches its own
   * errors, so a plain `Promise<void>` looked identical whether the server
   * accepted the name or rejected it -- and the dialog closed on both, taking
   * the typed name with it. See `GemScenarioOutcome`.
   */
  onCreate: (name: string) => Promise<GemScenarioOutcome>;
  /** Deletes the scenario and says what happened; same three answers. */
  onDelete: (id: string) => Promise<GemScenarioOutcome>;
  /** True while a scenario call is in flight, to stop a double submit. */
  busy?: boolean;
}

/**
 * The scenario controls beside the report title: switch to another saved
 * strategy, start one, or delete this one.
 *
 * Switching is `EntitySwitcher`, the same caret the security, payee and account
 * detail pages use, so the menu, filter and keyboard behaviour are defined once.
 * Creating and deleting sit next to it because a scenario is only useful
 * alongside another one to compare it with.
 *
 * Deleting takes the evaluation history with it, which is the part that cannot
 * be rebuilt -- the confirmation says so rather than asking a generic "are you
 * sure".
 */
export function GemScenarioSwitcher({
  currentId,
  currentName,
  scenarios,
  onSelect,
  onCreate,
  onDelete,
  busy = false,
}: GemScenarioSwitcherProps) {
  const t = useTranslations("strategies");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  /**
   * The scenario the open confirmation is about, captured when it opened.
   *
   * A boolean made the dialog read `currentId` at confirm time, which is a
   * different scenario the moment the selection moves under it. Holding the
   * id and the name together is the same rule the report follows for its
   * asynchronous data: what an action is aimed at travels with the action.
   */
  const [confirmingDelete, setConfirmingDelete] = useState<{
    id: string;
    name: string;
  } | null>(null);

  /**
   * And it is only shown while that scenario is still the current one. A
   * confirmation whose subject has been replaced is not a confirmation of
   * anything the user asked about.
   */
  const pendingDelete =
    confirmingDelete !== null && confirmingDelete.id === currentId
      ? confirmingDelete
      : null;

  const items = useMemo<EntitySwitcherItem[]>(
    () =>
      scenarios.map((scenario) => ({
        id: scenario.id,
        primary: scenario.name,
      })),
    [scenarios],
  );

  /** A name the server will accept -- it refuses a blank one. */
  const trimmedName = newName.trim();
  const canCreate = trimmedName.length > 0 && !busy;

  const submitCreate = async () => {
    // The button is disabled without a name rather than the server round-trip
    // answering with a generic toast, which said nothing about which field was
    // wrong.
    if (!canCreate) return;
    // Only clear and close on success: a failed create leaves the name in the
    // field and the dialog open, so retrying is one click rather than typing
    // it again.
    if ((await onCreate(trimmedName)) === "failed") return;
    setNewName("");
    setCreating(false);
  };

  return (
    <>
      <span className="flex items-center gap-0.5">
        {currentId !== null && items.length > 1 && (
          <EntitySwitcher
            currentId={currentId}
            items={items}
            onSelect={onSelect}
            triggerLabel={t("gem.scenarios.switch")}
            // Named on the control itself: the caret beside the title switches
            // reports, this one switches scenarios, and they sit on the same
            // line.
            triggerText={t("gem.scenarios.triggerText")}
            filterPlaceholder={t("gem.scenarios.filterPlaceholder")}
            noMatchesLabel={t("gem.scenarios.noMatches")}
          />
        )}
        <button
          type="button"
          onClick={() => setCreating(true)}
          disabled={busy}
          title={t("gem.scenarios.create")}
          aria-label={t("gem.scenarios.create")}
          className="rounded p-1 text-gray-400 hover:text-blue-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50 dark:hover:text-blue-400"
        >
          <PlusIcon className="h-4 w-4" aria-hidden="true" />
        </button>
        {/* Deleting the only scenario would leave nothing to report on, and the
            unconfigured report is reachable by clearing it instead. */}
        {currentId !== null && scenarios.length > 1 && (
          <button
            type="button"
            onClick={() =>
              setConfirmingDelete({ id: currentId, name: currentName })
            }
            disabled={busy}
            title={t("gem.scenarios.delete")}
            aria-label={t("gem.scenarios.delete")}
            className="rounded p-1 text-gray-400 hover:text-red-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50 dark:hover:text-red-400"
          >
            <TrashIcon className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </span>

      <Modal
        isOpen={creating}
        onClose={() => setCreating(false)}
        maxWidth="sm"
        pushHistory
        className="p-6"
        title={t("gem.scenarios.createTitle")}
        description={t("gem.scenarios.createHint")}
      >
        <Input
          label={t("gem.scenarios.nameLabel")}
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          // Enter submits, as it would in a form. This dialog is not a `<form>`
          // -- it lives inside the report page's own -- so the key is handled
          // here rather than inherited.
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            void submitCreate();
          }}
          placeholder={t("gem.scenarios.namePlaceholder")}
          maxLength={100}
        />
        <div className="mt-4 flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => setCreating(false)}
          >
            {t("gem.scenarios.cancel")}
          </Button>
          <Button type="button" onClick={submitCreate} disabled={!canCreate}>
            {t("gem.scenarios.createConfirm")}
          </Button>
        </div>
      </Modal>

      <ConfirmDialog
        isOpen={pendingDelete !== null}
        onCancel={() => setConfirmingDelete(null)}
        onConfirm={async () => {
          if (pendingDelete === null) return;
          // Same rule as the create dialog: a rejected delete keeps the
          // confirmation on screen with its context intact. A deferred one
          // does not -- the user has confirmed, and what happens next is the
          // unsaved-changes dialog, not this.
          if ((await onDelete(pendingDelete.id)) === "failed") return;
          setConfirmingDelete(null);
        }}
        pushHistory
        title={t("gem.scenarios.deleteTitle")}
        message={t("gem.scenarios.deleteMessage", {
          name: pendingDelete?.name ?? currentName,
        })}
        confirmLabel={t("gem.scenarios.delete")}
        variant="danger"
      />
    </>
  );
}
