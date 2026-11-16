import { scanMbox, startsWithFromLine } from "./mbox-scan";
import {
  PART_MAX_BYTES,
  packRequests,
  planParts,
  type UploadPart,
} from "./upload-plan";
import { looksLikeZip, newZipBudget, splitZip } from "./zip-split";

/** What the browser found out about one selected file while planning. */
export interface PlanNote {
  /** The selected file's name. */
  origin: string;
  /** Archive entries that are not mail files. */
  ignoredEntries: number;
  /** Single messages above the part limit, which are not sent. */
  oversizedMessages: number;
  /** The file could not be read as the archive it is. */
  error: "invalid_archive" | "archive_too_large" | null;
}

export interface UploadPlan {
  requests: UploadPart[][];
  /** One note per file that has something to report; in selection order. */
  notes: PlanNote[];
}

function isMboxName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".mbox") || lower.endsWith(".mbx");
}

function isMessageName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".eml") || lower.endsWith(".msg");
}

async function head(file: Blob): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(0, 5).arrayBuffer());
}

/**
 * Turns the selected files into requests. A file up to the part limit is sent as
 * it is (the server decides its format). A larger `.zip` is read locally; a larger
 * `.mbox` (or a file that starts with `From `) is scanned for message boundaries.
 * Any other large file is one message above the limit and is counted, not sent.
 */
export async function buildUploadPlan(
  files: readonly File[],
): Promise<UploadPlan> {
  const parts: UploadPart[] = [];
  const notes: PlanNote[] = [];
  const zipBudget = newZipBudget();

  for (const file of files) {
    if (file.size <= PART_MAX_BYTES) {
      parts.push(...planParts([{ kind: "file", file }]).parts);
      continue;
    }

    const start = isMessageName(file.name)
      ? new Uint8Array(0)
      : await head(file);
    if (!isMessageName(file.name) && looksLikeZip(file.name, start)) {
      const zip = await splitZip(file, { budget: zipBudget });
      parts.push(...zip.parts);
      if (
        zip.error ||
        zip.ignoredEntries > 0 ||
        zip.oversizedMessages > 0 ||
        zip.parts.length === 0
      ) {
        notes.push({
          origin: file.name,
          ignoredEntries: zip.ignoredEntries,
          oversizedMessages: zip.oversizedMessages,
          error: zip.error,
        });
      }
      continue;
    }

    const mboxLike =
      isMboxName(file.name) ||
      (!isMessageName(file.name) && startsWithFromLine(start));
    if (mboxLike) {
      const { starts } = await scanMbox(file);
      const planned = planParts([
        { kind: "mbox", name: file.name, blob: file, starts },
      ]);
      parts.push(...planned.parts);
      const oversized = planned.oversizedMessages[0]?.count ?? 0;
      if (oversized > 0) {
        notes.push({
          origin: file.name,
          ignoredEntries: 0,
          oversizedMessages: oversized,
          error: null,
        });
      }
      continue;
    }

    notes.push({
      origin: file.name,
      ignoredEntries: 0,
      oversizedMessages: 1,
      error: null,
    });
  }

  return { requests: packRequests(parts), notes };
}
