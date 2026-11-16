import { escapeHtml } from "../common/escape-html.util";
import { EmailT, englishEmailT } from "../i18n/email-translator";

/**
 * The two messages of a self-service email change. Kept beside
 * `email-templates.ts` rather than in it only because that file is already at
 * its size ceiling; the markup and the escaping rules are the same.
 */

/** Sent to the NEW address: following the link is what applies the change. */
export function emailChangeConfirmTemplate(
  firstName: string,
  confirmUrl: string,
  t: EmailT = englishEmailT,
): string {
  const safeName = escapeHtml(firstName || "there");
  const safeUrl = escapeHtml(confirmUrl);
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #1f2937;">${t("emails.emailChangeConfirm.heading", "Confirm your new email address")}</h2>
      <p style="color: #374151;">${t("emails.emailChangeConfirm.greeting", `Hi ${safeName},`, { name: safeName })}</p>
      <p style="color: #374151;">${t("emails.emailChangeConfirm.intro", "A request was made to use this address for a Monize account. Your email will not change until you confirm it by clicking the button below:")}</p>
      <p style="margin: 24px 0;">
        <a href="${safeUrl}" style="display: inline-block; padding: 12px 24px; background: #2563eb; color: #ffffff; border-radius: 6px; text-decoration: none; font-weight: 500;">${t("emails.emailChangeConfirm.button", "Confirm Email Change")}</a>
      </p>
      <p style="color: #374151;">${t("emails.emailChangeConfirm.disclaimer", "This link will expire in 24 hours. If you did not request this change, you can safely ignore this email.")}</p>
      <p style="color: #6b7280; font-size: 14px; margin-top: 24px;">-- Monize</p>
    </div>
  `;
}

/** Sent to the CURRENT address, so a change its owner did not ask for is seen. */
export function emailChangeNoticeTemplate(
  firstName: string,
  newEmail: string,
  t: EmailT = englishEmailT,
): string {
  const safeName = escapeHtml(firstName || "there");
  const safeEmail = escapeHtml(newEmail);
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #1f2937;">${t("emails.emailChangeNotice.heading", "Email change requested")}</h2>
      <p style="color: #374151;">${t("emails.emailChangeNotice.greeting", `Hi ${safeName},`, { name: safeName })}</p>
      <p style="color: #374151;">${t("emails.emailChangeNotice.body1", `A request was made to change the email address of your Monize account to ${safeEmail}. The change takes effect only once it is confirmed from that address.`, { email: safeEmail })}</p>
      <p style="color: #374151;">${t("emails.emailChangeNotice.body2", "If you did not make this request, change your password immediately and review the devices signed in to your account.")}</p>
      <p style="color: #6b7280; font-size: 14px; margin-top: 24px;">-- Monize</p>
    </div>
  `;
}
