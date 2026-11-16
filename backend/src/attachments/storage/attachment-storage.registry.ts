import { ServiceUnavailableException } from "@nestjs/common";
import { tr } from "../../i18n/translate";
import { AttachmentStorageProvider } from "./attachment-storage.interface";

/**
 * Every storage backend this build knows how to address, and which of them is
 * bound for new bytes.
 *
 * `ATTACHMENT_STORAGE_PROVIDER` names where the NEXT attachment is written.
 * `transaction_attachments.storage_provider` names where an EXISTING one's bytes
 * already are. Those were assumed to be the same value, and the download path
 * simply asked the bound provider for the row's key -- so the boot after an
 * operator changed the setting served 404 for every attachment uploaded before
 * it, with the row, the size and the filename all still listed. The bytes were
 * intact the whole time, in a backend this process could still reach.
 *
 * So resolution is per row, through this registry, and relocation
 * (`AttachmentStorageMigrator`) is what eventually makes the two agree again.
 * Both need the same two questions answered -- which provider holds this row's
 * bytes, and can this deployment reach it at all -- which is why they are asked
 * in one place rather than by each caller with its own `if` on a name.
 *
 * The class is its own DI token, built by the factory in `attachments.module.ts`
 * beside the one that binds the active provider: a consumer needs the class for
 * its type in any case, so a second name for the same thing would be one more
 * thing to keep in step.
 */
/**
 * The refusal for a row whose backend this deployment cannot address.
 *
 * `503` with a **code**, following `BackupPasswordRequiredError`: the client has
 * to tell this apart from every other failure, and a bare status cannot carry
 * that. A reverse proxy answers 503 when the backend is down, and a preview that
 * read the status alone would tell the reader their file is in an unconfigured
 * storage backend during an ordinary outage. The code is what
 * `isStoreUnreachable` (`frontend/src/lib/attachments.ts`) matches on.
 */
export class AttachmentStoreUnreachableError extends ServiceUnavailableException {
  constructor(readonly providerName: string) {
    super({
      message: tr(
        "errors.attachments.storageUnavailable",
        `This attachment's file is held in the "${providerName}" storage backend, which this server is not configured to reach`,
        { provider: providerName },
      ),
      code: ATTACHMENT_STORE_UNREACHABLE_CODE,
    });
  }
}

/** The stable code on that refusal's body, matched by the client. */
export const ATTACHMENT_STORE_UNREACHABLE_CODE = "ATTACHMENT_STORE_UNREACHABLE";

export class AttachmentStorageRegistry {
  constructor(
    /** Where new bytes go: the provider `ATTACHMENT_STORAGE_PROVIDER` selected. */
    readonly active: AttachmentStorageProvider,
    /** Every backend this build has, whether or not it is configured. */
    private readonly providers: readonly AttachmentStorageProvider[],
  ) {
    const names = new Set<string>();
    for (const provider of providers) {
      // Two providers answering to one name would make `resolve` return whichever
      // came first, which is a silently wrong backend rather than an error. The
      // names are persisted in a column, so this is the only place to catch it.
      if (names.has(provider.name)) {
        throw new Error(
          `Two attachment storage providers are named "${provider.name}"`,
        );
      }
      names.add(provider.name);
    }
    if (!providers.includes(active)) {
      throw new Error(
        `The active attachment storage provider "${active.name}" is not among the ` +
          `registered providers`,
      );
    }
  }

  /**
   * The provider a row's `storage_provider` names, or `null` when this
   * deployment cannot reach it.
   *
   * `null` covers two cases the caller must not conflate with "no bytes": a
   * provider this build does not have (a row restored from a future version) and
   * one it has but cannot address (`s3` with no bucket configured). Both are a
   * deployment that is missing configuration, not an attachment that is missing
   * bytes.
   */
  resolve(providerName: string): AttachmentStorageProvider | null {
    // A scan of three, read fresh, rather than a map built in the constructor: a
    // name resolved once and cached is a lookup that can outlive its answer, and
    // three string comparisons are not worth a cache anyway.
    const provider = this.providers.find((p) => p.name === providerName);
    if (!provider || !provider.addressable) return null;
    return provider;
  }

  /**
   * The provider for a row, or a refusal that says which backend is missing.
   *
   * The refusal is `AttachmentStoreUnreachableError`, deliberately not the
   * `NotFoundException` a missing object gets: nothing is lost, one setting is
   * absent, and the two have different repairs. Naming the provider is the whole
   * value of the message -- "attachment unavailable" sends an operator to the
   * wrong place.
   */
  require(providerName: string): AttachmentStorageProvider {
    const provider = this.resolve(providerName);
    if (!provider) throw new AttachmentStoreUnreachableError(providerName);
    return provider;
  }

  /**
   * Every backend this deployment can reach, the active one included.
   *
   * The relocation pass and the orphan sweep both need it: one to know whether a
   * row's source is readable, the other to know whose objects it may reclaim. A
   * provider left out here is not swept and not migrated, which is the only safe
   * answer -- its bytes are unreachable, so a record pointing at them is the last
   * thing that can still find them.
   */
  addressable(): AttachmentStorageProvider[] {
    return this.providers.filter((provider) => provider.addressable);
  }
}
