import { simplefinEqual } from "./providers/simplefin/simplefin-equal";
import { simplefinRedactor } from "./providers/simplefin/simplefin-redact";
import { ConflictException, Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { createHash } from "node:crypto";
import { withScopedDb, getActiveScopedManager } from "../common/db/scoped-db";
import { tr } from "../i18n/translate";
import { User } from "../users/entities/user.entity";
import { BankSyncCredential } from "./entities/bank-sync-credential.entity";
import { BankSyncConnection } from "./entities/bank-sync-connection.entity";
import { BankSyncAccount } from "./entities/bank-sync-account.entity";
import { BankSyncCredentialsService } from "./bank-sync-credentials.service";
import { SimplefinRequestBudgetService } from "./simplefin-request-budget.service";
import { SimplefinClient } from "./providers/simplefin/simplefin.client";
import { SimplefinTransportError } from "./providers/simplefin/simplefin.transport";
import { simplefinAccessRequest } from "./providers/simplefin/simplefin.urls";
import {
  mapSimplefinAccountSet,
  simplefinAccountBlocked,
} from "./providers/simplefin/simplefin.mapper";

export type SimplefinReadError =
  | "unauthorized"
  | "payment_required"
  | "rate_limited"
  | "unavailable"
  | "invalid_response"
  | "no_accounts"
  | "partial_data"
  | "identity_review";
export interface SimplefinDiscoveryView {
  ok: boolean;
  reviewRequired: boolean;
  errors: SimplefinReadError[];
  connections: Array<{
    id: string;
    name: string;
    accounts: Array<{
      id: string;
      name: string | null;
      currencyCode: string | null;
      balance: string | null;
      balanceAt: string | null;
    }>;
  }>;
}

function readFailure(error: unknown): SimplefinReadError {
  if (error instanceof SimplefinTransportError) {
    if (error.status === 401 || error.status === 403) return "unauthorized";
    if (error.status === 402) return "payment_required";
    if (error.status === 429) return "rate_limited";
    if (error.kind === "transport" || (error.status ?? 0) >= 500)
      return "unavailable";
  }
  return "invalid_response";
}

/** Metadata-only: never links accounts, imports transactions or enables auto sync. */
@Injectable()
export class SimplefinDiscoveryService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly credentials: BankSyncCredentialsService,
    private readonly budget: SimplefinRequestBudgetService,
    private readonly client: SimplefinClient,
  ) {}

  async discover(userId: string): Promise<SimplefinDiscoveryView> {
    if (getActiveScopedManager())
      throw new Error(
        "Discover SimpleFIN accounts outside an active database transaction",
      );
    const credential = await this.credentials.resolveCredentials(
      userId,
      "simplefin",
    );
    const request = simplefinAccessRequest(credential.accessUrl);
    const safeText = simplefinRedactor(credential.accessUrl);
    const reservation = await this.budget.reserve(
      userId,
      credential.credentialId,
    );
    if (!reservation.allowed) return this.failure("rate_limited");
    let set: ReturnType<typeof mapSimplefinAccountSet>;
    try {
      set = mapSimplefinAccountSet(
        await this.client.accounts(credential.accessUrl),
        request.root.origin,
      );
    } catch (error) {
      return this.failure(readFailure(error));
    }
    return withScopedDb(this.dataSource, async (m) => {
      // First saves / repeat discovery serialize on the same owner row as setup.
      // The credential lock also fences removal and replacement after HTTP.
      const owner = await m.getRepository(User).findOne({
        where: { id: userId },
        lock: { mode: "pessimistic_write" },
      });
      if (!owner)
        throw new ConflictException(
          tr(
            "errors.bankSync.simplefinOwnerMissing",
            "The account for this SimpleFIN connection no longer exists.",
          ),
        );
      const current = await m.getRepository(BankSyncCredential).findOne({
        where: { id: credential.credentialId, userId, provider: "simplefin" },
        lock: { mode: "pessimistic_write" },
      });
      if (!current) return this.failure("identity_review");
      const latest = await this.credentials.resolveCredentials(
        userId,
        "simplefin",
      );
      if (latest.accessUrl !== credential.accessUrl)
        return this.failure("identity_review");

      const connections = m.getRepository(BankSyncConnection);
      const accounts = m.getRepository(BankSyncAccount);
      await m.query(
        "SELECT id FROM bank_sync_connections WHERE user_id=$1 AND provider='simplefin' ORDER BY id FOR UPDATE",
        [userId],
      );
      const existing = await connections.find({
        where: { userId, provider: "simplefin" },
      });
      const seenConnections = new Set<string>();
      const result: SimplefinDiscoveryView = {
        ok: set.errors.length === 0 && set.accounts.length > 0,
        reviewRequired: set.errors.length > 0 || set.accounts.length === 0,
        errors: set.errors.length
          ? ["partial_data"]
          : set.accounts.length
            ? []
            : ["no_accounts"],
        connections: [],
      };
      const reviewMessage = tr(
        "errors.bankSync.simplefinIdentityReview",
        "SimpleFIN account identities changed or are missing. Review the accounts before enabling syncing; existing mappings were preserved.",
      );
      for (const remote of set.connections) {
        // Including origin prevents a reconnect to another Bridge server from
        // silently inheriting a former institution's account mappings.
        const externalSessionId =
          "sf2:" +
          createHash("sha256")
            .update(JSON.stringify([request.root.origin, remote.id]))
            .digest("hex");
        seenConnections.add(externalSessionId);
        let connection = existing.find(
          (row) =>
            row.externalSessionId !== null &&
            simplefinEqual(row.externalSessionId, externalSessionId),
        );
        if (!connection) {
          connection = connections.create({
            userId,
            provider: "simplefin",
            institutionName: safeText(remote.name)!,
            // Bridge does not report an ISO country. Empty means unspecified;
            // do not infer US from the user's location or the bank's name.
            institutionCountry: "",
            psuType: "personal",
            status: "active",
            externalSessionId,
            validUntil: null,
            authStateHash: null,
            authStartedAt: null,
            autoSync: false,
            tagOperationType: false,
            lastError: null,
          });
          connection = await connections.save(connection);
        }
        connection.institutionName = safeText(remote.name)!;
        const previous = await accounts.find({
          where: { userId, connectionId: connection.id },
        });
        const found = set.accounts.filter(
          (account) => account.connectionId === remote.id,
        );
        const seenAccounts = new Set(
          found.map((account) => account.descriptor.externalAccountId),
        );
        const missing = previous.some(
          (account) => !seenAccounts.has(account.externalAccountId),
        );
        const currencyChanged = found.some((remoteAccount) =>
          previous.some(
            (old) =>
              old.externalAccountId ===
                remoteAccount.descriptor.externalAccountId &&
              old.accountId !== null &&
              old.currencyCode !== remoteAccount.descriptor.currencyCode,
          ),
        );
        const blocked =
          found.some((account) =>
            simplefinAccountBlocked(
              set.errors,
              remote.id,
              account.remoteAccountId,
            ),
          ) ||
          (set.errors.length > 0 && found.length === 0);
        if (missing || blocked || currencyChanged) {
          if (connection.status !== "revoked") connection.status = "failed";
          connection.lastError = reviewMessage;
          result.reviewRequired = true;
          result.ok = false;
          if (
            (missing || currencyChanged) &&
            !result.errors.includes("identity_review")
          )
            result.errors.push("identity_review");
        } else if (connection.status !== "revoked") {
          connection.status = "active";
          connection.lastError = null;
        }
        await connections.save(connection);
        const view: SimplefinDiscoveryView["connections"][number] = {
          id: connection.id,
          name: connection.institutionName,
          accounts: [],
        };
        for (const remoteAccount of found) {
          if (
            simplefinAccountBlocked(
              set.errors,
              remote.id,
              remoteAccount.remoteAccountId,
            )
          )
            continue;
          const descriptor = remoteAccount.descriptor;
          let account = previous.find(
            (row) => row.externalAccountId === descriptor.externalAccountId,
          );
          if (!account) {
            account = accounts.create({
              userId,
              connectionId: connection.id,
              ...descriptor,
              displayName: safeText(descriptor.displayName),
              accountId: null,
              syncFromDate: null,
            });
          } else {
            // Deliberately preserve accountId, cut-off, history and import ledger.
            account.displayName = safeText(descriptor.displayName);
            if (account.accountId === null)
              account.currencyCode = descriptor.currencyCode;
          }
          account = await accounts.save(account);
          const acceptedBalance =
            account.currencyCode === descriptor.currencyCode
              ? remoteAccount.balance
              : null;
          if (acceptedBalance) {
            await m.query(
              `UPDATE bank_sync_accounts SET bank_balance=$1::numeric,
                bank_balance_currency=$2, bank_balance_date=$3::date, bank_balance_at=$6::timestamptz WHERE id=$4 AND user_id=$5`,
              [
                acceptedBalance.amount,
                acceptedBalance.currencyCode,
                acceptedBalance.referenceDate,
                account.id,
                userId,
                remoteAccount.balanceTimestamp === null
                  ? null
                  : new Date(
                      remoteAccount.balanceTimestamp * 1000,
                    ).toISOString(),
              ],
            );
          } else {
            await m.query(
              "UPDATE bank_sync_accounts SET bank_balance=NULL, bank_balance_currency=NULL, bank_balance_date=NULL, bank_balance_at=NULL WHERE id=$1 AND user_id=$2",
              [account.id, userId],
            );
          }
          view.accounts.push({
            id: account.id,
            name: account.displayName,
            currencyCode: account.currencyCode,
            balance: acceptedBalance?.amount ?? null,
            balanceAt:
              acceptedBalance === null ||
              remoteAccount.balanceTimestamp === null
                ? null
                : new Date(remoteAccount.balanceTimestamp * 1000).toISOString(),
          });
        }
        result.connections.push(view);
      }
      for (const old of existing) {
        if (
          old.externalSessionId &&
          !seenConnections.has(old.externalSessionId)
        ) {
          // Absence is a review condition, never permission to erase or remap.
          if (old.status !== "revoked") old.status = "failed";
          old.lastError = reviewMessage;
          await connections.save(old);
          result.ok = false;
          result.reviewRequired = true;
          if (!result.errors.includes("identity_review"))
            result.errors.push("identity_review");
        }
      }
      return result;
    });
  }

  private failure(error: SimplefinReadError): SimplefinDiscoveryView {
    return {
      ok: false,
      reviewRequired: true,
      errors: [error],
      connections: [],
    };
  }
}
