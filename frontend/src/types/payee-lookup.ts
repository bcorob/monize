/** Which source a user wants asked first. Mirrors the column's CHECK. */
export type PayeeLookupPreferredSource = 'google-places' | 'ai';

/** Which source would answer a payee contact lookup, and whether one can. */
export interface PayeeLookupStatus {
  /**
   * True when a lookup can run at all -- Google Places is configured and
   * within its cap, or an AI provider is configured. False means a lookup
   * control has nothing to offer and is not drawn.
   */
  available: boolean;
  /** The source that would answer right now, or null when nothing can. */
  source: 'google-places' | 'ai' | null;
  /**
   * A provider exists. Drives whether the AI row is offered at all -- with no
   * provider there is nothing to switch on, so the row is not drawn.
   */
  aiConfigured: boolean;
  /** The AI switch. False means AI is never reached, provider or not. */
  aiEnabled: boolean;
  /** The order the user asked for, whether or not both sources can answer. */
  preferredSource: PayeeLookupPreferredSource;
  googlePlaces: {
    /**
     * Who configures Places here. `operator` means the deployment supplies the
     * key and only the on/off switch is the user's; `user` means this user
     * stored one; `none` means neither.
     */
    mode: 'operator' | 'user' | 'none';
    enabled: boolean;
    /** True when this month's cap is spent, so lookups have fallen back to AI. */
    capReached: boolean;
  };
}

/** The Google Places settings card's state. Never carries the key itself. */
export interface PayeeLookupSettings {
  mode: 'operator' | 'user' | 'none';
  configured: boolean;
  enabled: boolean;
  /** The AI source's own switch, independent of whether a provider exists. */
  aiEnabled: boolean;
  capEnabled: boolean;
  monthlyCap: number;
  /** `'****'` when a key is stored, else null. Shown as a placeholder. */
  apiKeyMasked: string | null;
  /**
   * False when a key is stored that this server cannot decrypt. Distinct from
   * having no key: the repair is to enter it again.
   */
  apiKeyReadable: boolean;
  usedThisMonth: number;
  /**
   * Which source is asked first. Stored even when only one can answer, so
   * configuring the second later does not silently reorder the first.
   */
  preferredSource: PayeeLookupPreferredSource;
  /**
   * The AI provider pinned for lookups, or null for "no preference" (every
   * active provider in priority order). Offered only when the user has more
   * than one: with a single provider there is nothing to choose.
   */
  aiProviderConfigId: string | null;
  /** False when the server holds no ENCRYPTION_KEY, so no key can be stored. */
  encryptionAvailable: boolean;
}

export interface UpdatePayeeLookupSettings {
  enabled?: boolean;
  aiEnabled?: boolean;
  /** A new key; `''` clears the stored one; omit to keep it. */
  apiKey?: string;
  capEnabled?: boolean;
  monthlyCap?: number;
  preferredSource?: PayeeLookupPreferredSource;
  /** `null` clears the pin; omit to leave it alone. */
  aiProviderConfigId?: string | null;
}

export interface PayeeLookupKeyTestResult {
  available: boolean;
  error?: string;
}
