/**
 * How an AI provider's API key travels in a backup.
 *
 * `ai_provider_configs.api_key_enc` is ciphertext under `ENCRYPTION_KEY`,
 * which is server configuration: it is not in the backup and cannot be, because
 * shipping the master key beside the ciphertext would make encrypting the column
 * pointless. Exporting the ciphertext verbatim therefore produced a row that
 * restores onto a *different* instance -- or onto the same one after that
 * variable was rotated or regenerated -- populated and unreadable. Nothing said
 * so: the column is non-null, so every "is a key configured?" check answered yes
 * and the provider row drew a masked key, and the only symptom was that AI calls
 * failed.
 *
 * So the key is decrypted on the way out and re-encrypted on the way in, under
 * whichever key the receiving instance holds. The backup becomes self-contained
 * for this column, which is the property the rest of the file already has.
 *
 * **The artifact then holds the key in plaintext.** That is the cost, and it is
 * not hidden: a backup is normally encrypted with the user's own password, but an
 * unencrypted export (an OIDC account that has set no backup password) and an
 * unencrypted automatic backup on disk both put third-party provider credentials
 * in a readable file. `BackupExportService` logs when it writes one. The support
 * (de-identified) backup drops `ai_provider_configs` entirely and is unaffected
 * -- see `support-backup-rules.ts`, which must keep dropping it.
 *
 * Both directions live here rather than at the two call sites, because the field
 * name and the fallback rules are one contract: an export that writes a field the
 * restore does not read loses the key silently, in exactly the way this file
 * exists to stop.
 */

/**
 * Where the decrypted key rides. A separate field, never `api_key_enc` itself:
 * that column's name is a claim about its contents, and a restore has to be able
 * to tell "plaintext to re-encrypt" from "ciphertext from this instance" without
 * guessing at the shape of the string.
 */
export const AI_PROVIDER_KEY_PLAINTEXT_FIELD = "api_key_plaintext";

/** The decrypt/encrypt pair this module needs, so specs can supply a double. */
export interface AiKeyCrypto {
  isConfigured(): boolean;
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

/** What the export did with one row's key, for the caller's log line. */
export type AiProviderKeyExportOutcome =
  | "no-key"
  | "decrypted"
  | "left-encrypted";

export interface AiProviderKeyExportResult {
  row: Record<string, unknown>;
  outcome: AiProviderKeyExportOutcome;
}

/**
 * Replace a row's stored ciphertext with the plaintext key, where this instance
 * can read it.
 *
 * The failure mode is deliberately conservative. A key this instance cannot
 * decrypt (already restored from elsewhere, or encrypted before the variable was
 * rotated) keeps its `api_key_enc` verbatim: that is exactly today's behaviour,
 * so the artifact is never *worse* than the one this replaces, and a restore back
 * onto the instance that originally wrote it still works. The same applies when
 * `ENCRYPTION_KEY` is unset, where there is nothing to decrypt with.
 *
 * `decrypt` is attempted once rather than probed with `canDecrypt` and then run:
 * the key derivation is `scryptSync`, tens of milliseconds, and doing it twice
 * per row doubles the cost of an export for no answer it did not already have.
 */
export function exportAiProviderKey(
  row: Record<string, unknown>,
  crypto: AiKeyCrypto,
): AiProviderKeyExportResult {
  const stored = row.api_key_enc;
  if (typeof stored !== "string" || stored.length === 0) {
    return { row, outcome: "no-key" };
  }
  if (!crypto.isConfigured()) {
    return { row, outcome: "left-encrypted" };
  }
  let plaintext: string;
  try {
    plaintext = crypto.decrypt(stored);
  } catch {
    return { row, outcome: "left-encrypted" };
  }
  return {
    row: {
      ...row,
      // Nulled, not left beside the plaintext: two representations of one secret
      // is one more than the restore can be asked to choose between, and the
      // stale one would be unreadable on the target anyway.
      api_key_enc: null,
      [AI_PROVIDER_KEY_PLAINTEXT_FIELD]: plaintext,
    },
    outcome: "decrypted",
  };
}

/** What the restore did with one row's key, for the caller's counters. */
export type AiProviderKeyRestoreOutcome =
  | "no-key"
  | "re-encrypted"
  | "kept-foreign-ciphertext"
  | "dropped-unencryptable";

export interface AiProviderKeyRestoreResult {
  row: Record<string, unknown>;
  outcome: AiProviderKeyRestoreOutcome;
}

/**
 * Turn whatever the artifact carries back into a ciphertext this instance can
 * read, and never leave the plaintext field on the row.
 *
 * Four cases, and the caller has to be able to tell them apart:
 *
 * - **no key** -- Ollama, the MCP relay, or a provider the user never keyed.
 *   Nothing was lost.
 * - **re-encrypted** -- the ordinary path for an artifact written by any build
 *   that has this module. Works across instances, which is the point.
 * - **kept-foreign-ciphertext** -- an older artifact, or one whose exporting
 *   instance could not read its own key. Restored verbatim, which succeeds only
 *   if this instance holds the key that produced it; otherwise it is the old
 *   silent failure and the caller reports it (`unusableAiProviderKeys`).
 * - **dropped-unencryptable** -- plaintext arrived but `ENCRYPTION_KEY` is
 *   unset here, so there is nothing to store it under. Storing it in the clear
 *   would be worse than losing it: the column is read by everything that builds
 *   a provider, and a plaintext value there would be handed to `decrypt` and
 *   throw anyway. The key is dropped and the caller reports it.
 */
export function restoreAiProviderKey(
  row: Record<string, unknown>,
  crypto: AiKeyCrypto,
): AiProviderKeyRestoreResult {
  const plaintext = row[AI_PROVIDER_KEY_PLAINTEXT_FIELD];
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    // The generic insert strips unknown columns anyway, but leaving the field on
    // the row would make that stripping the thing that protects the database.
    const { [AI_PROVIDER_KEY_PLAINTEXT_FIELD]: _dropped, ...rest } = row;
    const stored = rest.api_key_enc;
    return {
      row: rest,
      outcome:
        typeof stored === "string" && stored.length > 0
          ? "kept-foreign-ciphertext"
          : "no-key",
    };
  }

  const { [AI_PROVIDER_KEY_PLAINTEXT_FIELD]: _key, ...rest } = row;
  if (!crypto.isConfigured()) {
    return {
      row: { ...rest, api_key_enc: null },
      outcome: "dropped-unencryptable",
    };
  }
  return {
    row: { ...rest, api_key_enc: crypto.encrypt(plaintext) },
    outcome: "re-encrypted",
  };
}
