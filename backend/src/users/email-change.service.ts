import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ModuleRef } from "@nestjs/core";
import { I18nService } from "nestjs-i18n";
import * as crypto from "crypto";
import { DataSource } from "typeorm";

import { withScopedDb } from "../common/db/scoped-db";
import { hashToken } from "../auth/crypto.util";
import { EmailService } from "../notifications/email.service";
import {
  emailChangeConfirmTemplate,
  emailChangeNoticeTemplate,
} from "../notifications/email-change-templates";
import { emailTranslator } from "../i18n/email-translator";
import { resolveUserEmailLocale } from "../i18n/resolve-user-email-locale";
import { User } from "./entities/user.entity";
import { UserPreference } from "./entities/user-preference.entity";
import { EMAIL_CHANGE_TOKEN_TTL_MS } from "./email-change.util";

/** What a staged change needs to have its two messages sent after the commit. */
export interface StagedEmailChange {
  oldEmail: string | null;
  newEmail: string;
  /** The raw token for the link; only its hash is on the row. */
  token: string;
}

/**
 * The request half of a self-service email change.
 *
 * With SMTP configured, a change does not touch `users.email`: the address
 * waits in `pending_email` beside the hash of a single-use token, the link goes
 * to the NEW address and a notice to the CURRENT one, and the change is applied
 * by `AuthEmailService.confirmEmailChange` when the link is followed. Without
 * SMTP there is no way to deliver a link, and the change applies on the password
 * check alone, as it did before -- the same rule registration follows, which
 * creates its accounts already verified when it cannot send the verification
 * email. `docs/external-side-effects.md` section 4 has the send ordering.
 */
@Injectable()
export class EmailChangeService {
  private readonly logger = new Logger(EmailChangeService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly moduleRef: ModuleRef,
    private readonly configService: ConfigService,
    private readonly i18n: I18nService,
  ) {}

  /**
   * `EmailService` lives in NotificationsModule, which imports UsersModule; it
   * is resolved at call time for the same reason the other cross-module
   * services in `UsersService` are.
   */
  private emailService(): EmailService {
    return this.moduleRef.get(EmailService, { strict: false });
  }

  /** Whether a change must be confirmed from the new address. */
  requiresConfirmation(): boolean {
    return this.emailService().getStatus().configured;
  }

  /**
   * Put a pending change on `user` (the caller saves it). A newer request
   * replaces the pending address and its token, so an older link stops working.
   */
  stage(user: User, newEmail: string): StagedEmailChange {
    const token = crypto.randomBytes(32).toString("hex");
    user.pendingEmail = newEmail;
    user.emailChangeToken = hashToken(token);
    user.emailChangeTokenExpiry = new Date(
      Date.now() + EMAIL_CHANGE_TOKEN_TTL_MS,
    );
    return { oldEmail: user.email, newEmail, token };
  }

  /** Apply a change directly (no SMTP), dropping any change still pending. */
  applyImmediately(user: User, newEmail: string): void {
    user.email = newEmail;
    user.pendingEmail = null;
    user.emailChangeToken = null;
    user.emailChangeTokenExpiry = null;
  }

  /**
   * Send the confirmation link and the notice. Runs after the pending row has
   * committed, so a link never names a token the database does not hold; a
   * failed send is logged, never thrown, and leaves a pending change that
   * expires or is replaced by the next request (mirrors the verification email).
   */
  async sendMessages(user: User, change: StagedEmailChange): Promise<void> {
    const frontendUrl = this.configService.get<string>(
      "PUBLIC_APP_URL",
      "http://localhost:3000",
    );
    const confirmUrl = `${frontendUrl}/confirm-email-change?token=${change.token}`;
    const lang = await withScopedDb(this.dataSource, (manager) =>
      resolveUserEmailLocale(manager.getRepository(UserPreference), user.id),
    );
    const t = emailTranslator(this.i18n, lang);
    const firstName = user.firstName ?? "";
    const email = this.emailService();

    try {
      await email.sendMail(
        change.newEmail,
        t("emails.emailChangeConfirm.subject", "Confirm your new Monize email"),
        emailChangeConfirmTemplate(firstName, confirmUrl, t),
      );
    } catch (error) {
      this.logger.error(
        "Failed to send email change confirmation",
        error instanceof Error ? error.stack : error,
      );
    }

    if (!change.oldEmail) return;
    try {
      await email.sendMail(
        change.oldEmail,
        t("emails.emailChangeNotice.subject", "Monize email change requested"),
        emailChangeNoticeTemplate(firstName, change.newEmail, t),
      );
    } catch (error) {
      this.logger.error(
        "Failed to send email change notice",
        error instanceof Error ? error.stack : error,
      );
    }
  }
}
