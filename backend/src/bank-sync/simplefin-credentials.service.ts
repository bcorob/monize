import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { DataSource } from "typeorm";
import { EncryptionService } from "../common/encryption/encryption.service";
import { withScopedDb } from "../common/db/scoped-db";
import { tr } from "../i18n/translate";
import { User } from "../users/entities/user.entity";
import { BankSyncCredential } from "./entities/bank-sync-credential.entity";
import { BankSyncConnection } from "./entities/bank-sync-connection.entity";
import { simplefinAccessRequest } from "./providers/simplefin/simplefin.urls";
import {
  SimplefinRequestBudgetService,
  type SimplefinRequestBudget,
} from "./simplefin-request-budget.service";
import {
  BANK_SYNC_PROVIDER_CAPABILITIES,
  type BankSyncProviderCapabilities,
} from "./providers/bank-sync-capabilities";

export interface SimplefinCredentialStatus {
  provider: "simplefin";
  credentialSet: boolean;
  encryptionAvailable: boolean;
  capabilities: BankSyncProviderCapabilities;
  quota: SimplefinRequestBudget | null;
}

/** Stores only already-claimed URLs; the setup-token claim flow is a separate external operation. */
@Injectable()
export class SimplefinCredentialsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly encryption: EncryptionService,
    private readonly budget: SimplefinRequestBudgetService,
  ) {}

  async status(userId: string): Promise<SimplefinCredentialStatus> {
    return withScopedDb(this.dataSource, async (m) => {
      const row = await m
        .getRepository(BankSyncCredential)
        .findOne({ where: { userId, provider: "simplefin" } });
      return {
        provider: "simplefin",
        credentialSet: !!row?.accessUrlEnc,
        encryptionAvailable: this.encryption.isConfigured(),
        capabilities: BANK_SYNC_PROVIDER_CAPABILITIES.simplefin,
        quota: row ? await this.budget.status(userId, row.id) : null,
      };
    });
  }

  /** First-save races serialize on users; replacement shares the request budget's credential lock. */
  async storeClaimedAccessUrl(
    userId: string,
    accessUrl: string,
    replaceExisting = false,
  ): Promise<void> {
    try {
      simplefinAccessRequest(accessUrl);
    } catch {
      throw new BadRequestException(
        tr(
          "errors.bankSync.simplefinAccessInvalid",
          "SimpleFIN returned an invalid access URL. Generate a new setup token in SimpleFIN Bridge.",
        ),
      );
    }
    if (!this.encryption.isConfigured())
      throw new BadRequestException(
        tr(
          "errors.bankSync.simplefinEncryptionRequired",
          "This server cannot store SimpleFIN credentials. Ask an administrator to configure ENCRYPTION_KEY.",
        ),
      );
    const ciphertext = this.encryption.encrypt(accessUrl);
    await withScopedDb(this.dataSource, async (m) => {
      const owner = await m.getRepository(User).findOne({
        where: { id: userId },
        lock: { mode: "pessimistic_write" },
      });
      if (!owner)
        throw new NotFoundException(
          tr(
            "errors.bankSync.simplefinOwnerMissing",
            "The account for this SimpleFIN connection no longer exists.",
          ),
        );
      const repo = m.getRepository(BankSyncCredential);
      const row = await repo.findOne({
        where: { userId, provider: "simplefin" },
        lock: { mode: "pessimistic_write" },
      });
      if (row && !replaceExisting)
        throw new ConflictException(
          tr(
            "errors.bankSync.simplefinReplaceRequired",
            "Confirm replacement of the existing SimpleFIN connection before connecting again.",
          ),
        );
      if (row) {
        row.accessUrlEnc = ciphertext;
        await repo.save(row);
      } else {
        await repo.save(
          repo.create({
            userId,
            provider: "simplefin",
            applicationId: null,
            privateKeyEnc: null,
            accessUrlEnc: ciphertext,
          }),
        );
      }
    });
  }

  async remove(userId: string): Promise<void> {
    await withScopedDb(this.dataSource, async (m) => {
      const repo = m.getRepository(BankSyncCredential);
      const row = await repo.findOne({
        where: { userId, provider: "simplefin" },
        lock: { mode: "pessimistic_write" },
      });
      if (!row) return;
      await m.getRepository(BankSyncConnection).update(
        { userId, provider: "simplefin" },
        {
          autoSync: false,
          status: "failed",
          lastError: tr(
            "errors.bankSync.simplefinDisconnected",
            "SimpleFIN was disconnected in Monize. Reconnect to resume syncing; revoke the app token in SimpleFIN Bridge to remove remote access.",
          ),
        },
      );
      await repo.delete({ id: row.id, userId, provider: "simplefin" });
    });
  }
}
