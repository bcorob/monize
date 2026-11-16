import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const SRC_ROOT = join(__dirname, "..");

/**
 * The files allowed to reach the `web-push` library at all, each with the
 * reason. This map may shrink; it may not grow without one.
 *
 * A business feature asks the notification layer to deliver something and never
 * imports a transport. That is what will let ntfy or UnifiedPush arrive without
 * budgets, bills or backups changing (discussion #1291, "delivery isolation"),
 * and it holds only while the import stays inside this module.
 */
const WEB_PUSH_IMPORTERS: Record<string, string> = {
  "push/web-push-sender.service.ts":
    "the only file that speaks the protocol: it signs and sends",
  "push/push-config.service.ts":
    "mints the instance key pair (generateVAPIDKeys) and never sends",
};

/**
 * Sending is narrower than importing, and it is the half that matters: one file
 * decides what crosses an external push service, so one file is where the
 * privacy-minimal payload rule can be enforced.
 */
const SEND_CALLERS = new Set(["push/web-push-sender.service.ts"]);

/**
 * The files allowed to touch the decrypted private key or the column holding
 * it: the service that owns the key pair, and the sender it hands the key to.
 */
const PRIVATE_KEY_READERS = new Set([
  "push/push-config.service.ts",
  "push/web-push-sender.service.ts",
]);

/** Entity definitions must name the column; that is what an entity is for. */
const PRIVATE_KEY_DECLARERS = new Set([
  "push/entities/push-instance-config.entity.ts",
]);

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
 * Blank comments while keeping every newline, so an offender report still
 * points at the right line.
 *
 * This scan bans identifiers that its own subjects have to *discuss* -- the
 * sender's header explains why it is the only importer of `web-push`, and the
 * entity's doc comment says what `vapidPrivateKeyEnc` holds. Reading raw text
 * would make those explanations fail the guard, and the cheap way out is
 * weakening the explanation, which is the opposite of the point.
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

interface Occurrence {
  file: string;
  line: number;
  text: string;
}

function scan(files: string[], pattern: RegExp): Occurrence[] {
  const found: Occurrence[] = [];
  for (const file of files) {
    const code = blankComments(readFileSync(file, "utf8"));
    code.split("\n").forEach((text, index) => {
      if (pattern.test(text)) {
        found.push({
          file: relative(SRC_ROOT, file).replace(/\\/g, "/"),
          line: index + 1,
          text: text.trim(),
        });
      }
      pattern.lastIndex = 0;
    });
  }
  return found;
}

function report(occurrences: Occurrence[]): string[] {
  return occurrences.map((o) => `${o.file}:${o.line} -- ${o.text}`);
}

describe("the VAPID private key stays on the server", () => {
  const files = sourceFiles(SRC_ROOT);

  it("finds source files to scan", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("keeps the comment blanker honest in both directions", () => {
    const source = [
      "const a = 1;",
      "// import * as webpush from 'web-push';",
      "/* vapidPrivateKeyEnc",
      "   still a comment */",
      "const b = 'https://x';",
    ].join("\n");
    const blanked = blankComments(source);

    // Same line count, so an offender report still points at the right line.
    expect(blanked.split("\n")).toHaveLength(5);
    expect(blanked).toContain("const a = 1;");
    expect(blanked).toContain("const b = 'https://x';");
    // ...and the prose is gone, so a comment cannot trip the scan.
    expect(blanked).not.toContain("web-push");
    expect(blanked).not.toContain("vapidPrivateKeyEnc");
    // A URL is not a comment.
    expect(blanked).toContain("https://x");
  });

  it("reaches the web-push library only from the files reviewed for it", () => {
    const importers = scan(
      files,
      /from\s+["']web-push["']|require\(["']web-push["']\)/,
    )
      .map((o) => o.file)
      .filter((file, index, all) => all.indexOf(file) === index);

    expect(importers.sort()).toEqual(Object.keys(WEB_PUSH_IMPORTERS).sort());
  });

  it("sends from exactly one file", () => {
    const senders = scan(files, /sendNotification\s*\(/)
      .map((o) => o.file)
      .filter((file, index, all) => all.indexOf(file) === index);

    expect(senders.sort()).toEqual([...SEND_CALLERS].sort());
  });

  it("reads the stored private key only where the key pair is owned", () => {
    const readers = scan(
      files,
      /vapidPrivateKeyEnc|vapid_private_key_enc/,
    ).filter(
      (o) =>
        !PRIVATE_KEY_READERS.has(o.file) && !PRIVATE_KEY_DECLARERS.has(o.file),
    );

    expect(report(readers)).toEqual([]);
  });

  it("hands the decrypted identity only to the sender", () => {
    const callers = scan(files, /getVapidIdentity/).filter(
      (o) => !PRIVATE_KEY_READERS.has(o.file),
    );

    expect(report(callers)).toEqual([]);
  });

  // The response shapes are the boundary the key must not cross. Whatever a
  // controller returns is serialized wholesale, so a private field on any of
  // them is a leak no reviewer would see in the route.
  it("declares no response shape carrying a private key", () => {
    const push = files.filter((f) =>
      relative(SRC_ROOT, f).replace(/\\/g, "/").startsWith("push/"),
    );
    const shapes = push.filter(
      (f) =>
        !PRIVATE_KEY_DECLARERS.has(relative(SRC_ROOT, f).replace(/\\/g, "/")),
    );

    const leaks = scan(shapes, /privateKey\s*[?]?\s*:/).filter(
      (o) => !PRIVATE_KEY_READERS.has(o.file),
    );

    expect(report(leaks)).toEqual([]);
  });
});
