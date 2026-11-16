import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const SRC_ROOT = join(__dirname, "..");

/**
 * An email producer gates delivery on the per-category matrix, never on the
 * bare `user_preferences.notification_email` master switch.
 *
 * `NotificationPreferenceService.resolveEmail(userId, category)` reads BOTH the
 * category row and the master switch, so a producer that reaches for
 * `notificationEmail` directly is gating on half the preference: the user's
 * per-category "Budgets: off" or "Bills: off" choice is silently ignored, and
 * the matrix toggle becomes a control that does not control that email
 * (audit Finding 1 -- the monthly budget summary and the mortgage reminder
 * each shipped this way, missed by the spec's producer inventory).
 *
 * So: a file that SENDS email and still reads the master-switch property must
 * also go through the resolver. And the known per-category producers are pinned
 * to the category they gate on, because a mirror-mock in their own unit specs
 * ignores that argument -- swapping PAYMENTS for BUDGETS passes those suites but
 * silences the wrong emails.
 */

/**
 * Email senders that are deliberately NOT category notifications and must never
 * be gated by the matrix: transactional and auth mail (password reset, email
 * verification, delegation invites, the raw transport). They do not read
 * `notificationEmail`, so the scan below would not flag them; the allowlist is
 * documentation of that intent. It may shrink; it may not grow without a reason.
 */
const NON_CATEGORY_EMAIL_SENDERS: Record<string, string> = {
  "notifications/email.service.ts": "the raw SMTP transport, gates nothing",
  "system-alerts/system-alert.service.ts":
    "admin fan-out (SYSTEM), gated by queryAdminRecipients.emailEnabled in SQL",
};

/**
 * The per-category email producers and the category each one gates on. Held by
 * a source scan because the producers' own unit specs mock `resolveEmail` and
 * cannot assert the category argument.
 */
const CATEGORY_PRODUCERS: Record<string, string> = {
  "notifications/bill-reminder.service.ts": "NotificationCategory.PAYMENTS",
  "budgets/budget-alert.service.ts": "NotificationCategory.BUDGETS",
  "budgets/budget-period-cron.service.ts": "NotificationCategory.BUDGETS",
  "accounts/mortgage-reminder.service.ts": "NotificationCategory.PAYMENTS",
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".spec.ts")) continue;
    out.push(full);
  }
  return out;
}

/**
 * Blank comments while keeping every newline, so a producer's doc comment may
 * still name `notificationEmail` (the mortgage reminder's does) without tripping
 * the scan, and an offender report still points at the right line.
 */
function blankComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(
      /(^|[^:])\/\/[^\n]*/g,
      (match, prefix: string) =>
        prefix + " ".repeat(match.length - prefix.length),
    );
}

function rel(file: string): string {
  return relative(SRC_ROOT, file).replace(/\\/g, "/");
}

describe("email delivery is gated by the per-category matrix", () => {
  const files = sourceFiles(SRC_ROOT);

  it("finds source files to scan", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("blankComments blanks a comment that a scan would otherwise trip", () => {
    // Both directions: a comment naming the token is neutralised, and code is
    // preserved -- otherwise the comment carve-out could hide a real offender.
    expect(blankComments("// respects notificationEmail")).not.toContain(
      "notificationEmail",
    );
    expect(blankComments("if (!prefs.notificationEmail) return;")).toContain(
      "notificationEmail",
    );
  });

  it("no email sender gates on the bare notification_email master switch", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const relPath = rel(file);
      if (relPath in NON_CATEGORY_EMAIL_SENDERS) continue;
      const code = blankComments(readFileSync(file, "utf8"));
      const sendsEmail = /\bsendMail\s*\(/.test(code);
      const readsMasterSwitch = /\bnotificationEmail\b/.test(code);
      if (
        sendsEmail &&
        readsMasterSwitch &&
        !/\bresolveEmail\s*\(/.test(code)
      ) {
        offenders.push(relPath);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("each per-category producer gates on the resolver with its category", () => {
    for (const [relPath, category] of Object.entries(CATEGORY_PRODUCERS)) {
      const code = blankComments(readFileSync(join(SRC_ROOT, relPath), "utf8"));
      expect({
        file: relPath,
        resolves: /\bresolveEmail\s*\(/.test(code),
      }).toEqual({ file: relPath, resolves: true });
      expect({
        file: relPath,
        category,
        present: code.includes(category),
      }).toEqual({ file: relPath, category, present: true });
    }
  });
});
