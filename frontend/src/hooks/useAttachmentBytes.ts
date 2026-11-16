'use client';

import { useEffect, useRef, useState } from 'react';
import { attachmentsApi, isStoreUnreachable } from '@/lib/attachments';
import { createLogger } from '@/lib/logger';

const logger = createLogger('AttachmentBytes');

/**
 * Where a preview's bytes come from: a saved attachment fetched by id, or a
 * file still held in the browser (the New Transaction window stages files
 * before the transaction exists).
 */
export type PreviewSource =
  | { kind: 'saved'; id: string }
  | { kind: 'file'; file: File };

export type PreviewBytes =
  | { status: 'loading' }
  | { status: 'ready'; bytes: ArrayBuffer; contentType: string }
  /**
   * `storeUnreachable` is the one failure with a different repair and different
   * advice: the bytes are intact in a storage backend this deployment is not
   * configured to reach (a provider switch whose old backend was decommissioned
   * before the relocation finished), so telling the reader to download instead
   * would send them at the same 503. Everything else is the generic failure.
   */
  | { status: 'error'; storeUnreachable: boolean };

const LOADING: PreviewBytes = { status: 'loading' };

/**
 * Two staged files can share name, size and modification time (two photos of
 * the same receipt), so a `File` is identified by the object, not its fields.
 */
const fileIds = new WeakMap<File, number>();
let nextFileId = 0;

function fileIdentity(file: File): number {
  const known = fileIds.get(file);
  if (known !== undefined) return known;
  const id = nextFileId++;
  fileIds.set(file, id);
  return id;
}

export function previewSourceKey(source: PreviewSource): string {
  return source.kind === 'saved'
    ? `saved:${source.id}`
    : `file:${fileIdentity(source.file)}`;
}

/**
 * The bytes for a preview source, keyed to the request that produced them.
 *
 * The payload and its key travel together: a response is adopted only while
 * its source is still the one on screen, so switching from the enhanced scan
 * to its original and back cannot paint the slower answer over the newer one.
 * A failed read is `error`, never an empty result -- there is no such thing as
 * an attachment with no bytes, and rendering one as blank would claim there
 * is. An abandoned request (source changed, preview closed) sets nothing at
 * all. A staged `File` cannot reach a storage backend at all, so its failures
 * are never `storeUnreachable`.
 *
 * Returns `null` for a `null` source (the preview is closed), so the caller
 * can hold one hook whether or not anything is open.
 */
export function useAttachmentBytes(
  source: PreviewSource | null,
): PreviewBytes | null {
  const key = source === null ? null : previewSourceKey(source);
  // The result is stored with the key it answers, and read only when that
  // key is the current one. That is what makes a source change show
  // `loading` on the very render it happens, without a setState in an
  // effect to reset it ("info from previous render").
  const [answer, setAnswer] = useState<{
    key: string;
    result: PreviewBytes;
  } | null>(null);
  // Which key the most recent effect claimed; a response checks it before
  // being adopted. A ref rather than a cleanup flag, so StrictMode's
  // mount-unmount-mount does not discard the only request that ran.
  const currentKeyRef = useRef<string | null>(null);

  useEffect(() => {
    currentKeyRef.current = key;
    if (source === null || key === null) return;

    const controller = new AbortController();
    const read =
      source.kind === 'saved'
        ? attachmentsApi.fetchBytes(source.id, controller.signal)
        : source.file.arrayBuffer().then((bytes) => ({
            bytes,
            contentType: source.file.type,
          }));

    read
      .then((result) => {
        if (currentKeyRef.current !== key) return;
        setAnswer({ key, result: { status: 'ready', ...result } });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (currentKeyRef.current !== key) return;
        logger.error('Failed to load attachment bytes:', error);
        setAnswer({
          key,
          result: {
            status: 'error',
            storeUnreachable: isStoreUnreachable(error),
          },
        });
      });

    return () => {
      controller.abort();
    };
    // `source` is a fresh object on every render; `key` is its identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (key === null) return null;
  return answer !== null && answer.key === key ? answer.result : LOADING;
}
