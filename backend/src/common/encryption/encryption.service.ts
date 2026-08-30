import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { encrypt, decrypt } from "../../auth/crypto.util";
import {
  missingEncryptionKeyMessage,
  resolveEncryptionKey,
  ResolvedEncryptionKey,
} from "./encryption-key";

/**
 * Everything this deployment encrypts at rest under one server-side key:
 * AI provider API keys, emergency-access grant credentials, and the copy of a
 * user's password that automatic backups are encrypted with.
 *
 * It was `AiEncryptionService`, keyed on `AI_ENCRYPTION_KEY`, and the name is
 * why issue #1269 happened: a variable documented as being for cloud AI
 * providers was left unset by every deployment that configured none, and the
 * backup password capture silently had nowhere to store its copy.
 *
 * The key is `ENCRYPTION_KEY`. It is not required to boot in this release --
 * `logEncryptionKeyStatus` warns on every start that it will be -- but a
 * deployment without one stores no secret at all, so every method here refuses
 * rather than inventing a fallback. `AI_ENCRYPTION_KEY` is still read, and
 * still wins where both are set, so an existing deployment takes the upgrade
 * without re-keying a single column.
 */
@Injectable()
export class EncryptionService {
  private readonly resolved: ResolvedEncryptionKey | null;

  constructor(private readonly configService: ConfigService) {
    this.resolved = resolveEncryptionKey((name) =>
      this.configService.get<string>(name, ""),
    );
  }

  isConfigured(): boolean {
    return this.resolved !== null;
  }

  encrypt(plaintext: string): string {
    return encrypt(plaintext, this.requireKey());
  }

  decrypt(ciphertext: string): string {
    return decrypt(ciphertext, this.requireKey());
  }

  /**
   * Unreachable in a booted server -- startup refuses without a key -- and kept
   * because a spec, a script or a future entry point can construct this service
   * outside that path, and returning ciphertext-shaped garbage would be worse.
   */
  private requireKey(): string {
    if (!this.resolved) {
      throw new Error(missingEncryptionKeyMessage());
    }
    return this.resolved.key;
  }

  /**
   * Whether a stored ciphertext can still be read on this instance.
   *
   * Three states, not two, and the caller has to be able to tell them apart:
   * nothing stored, stored and readable, stored and unreadable. The last is what
   * a backup restored onto an instance with a different `ENCRYPTION_KEY`
   * leaves behind -- the column is non-null, so every "is a key configured?"
   * check says yes, and only the provider call finds out otherwise. AES-GCM
   * authenticates, so a wrong key raises rather than returning plausible bytes;
   * that is what makes this answerable at all.
   *
   * Not cheap: `decrypt` derives its key with `scryptSync`, tens of milliseconds
   * per call by design. Fine on a restore or a connection test, wrong on a list
   * endpoint -- do not put it in a loop over a page of rows.
   */
  canDecrypt(ciphertext: string | null | undefined): boolean {
    if (!ciphertext) return false;
    if (!this.isConfigured()) return false;
    try {
      this.decrypt(ciphertext);
      return true;
    } catch {
      return false;
    }
  }

  maskApiKey(apiKey: string | null): string | null {
    if (!apiKey) return null;
    if (apiKey.length <= 4) return "****";
    return "****" + apiKey.slice(-4);
  }
}
