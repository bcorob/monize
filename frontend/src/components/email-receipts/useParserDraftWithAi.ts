'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { stageChatHandoff } from '@/lib/ai-chat-handoff';
import { assistantCanAnswerNow } from '@/lib/assistant-ready';
import { buildParserDraftAttachments } from '@/lib/email-receipt-chat';
import { dominantSenderDomain, parserDraftKind } from '@/lib/email-receipts-format';
import { emailReceiptsApi } from '@/lib/email-receipts-api';
import { getErrorMessage } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import type { EmailReceiptListItem } from '@/types/email-receipts';

const logger = createLogger('ParserDraftWithAi');

/** What starting a draft came to: the chat was opened, the request waits for an agent, or nothing was queued. */
export type ParserDraftOutcome =
  | { kind: 'opened' }
  /** Queued; `handoffFailed` says the chat could have answered it but the emails could not be opened there. */
  | { kind: 'queued'; handoffFailed: boolean }
  | { kind: 'failed'; message: string };

/**
 * "Draft parser with AI" for one to five stored emails: queue a request for the
 * assistant (or an MCP agent) to write a parser from them, then either open the
 * chat or leave the request in the AI review inbox.
 *
 * 1. `POST /email-receipt-parsers/draft-with-ai` queues the request (no provider
 *    is called); a refusal is `failed` and nothing was queued.
 * 2. When the assistant can answer NOW (`assistantCanAnswerNow`: a provider is
 *    configured and, for the user's MCP relay, its agent is connected), each email
 *    is read in full and the chat opens with the emails attached as text files and
 *    a message already typed in the composer. The hand-off is STAGED, never sent:
 *    the user reads it and presses Send (INV-SHARE-002's contract). The message
 *    names the request id, which the assistant claims by id.
 * 3. Otherwise, or when the emails could not be read for the hand-off, the
 *    request just waits in the inbox for an agent: `queued`.
 *
 * Trade confirmations (every email `isTrade`) ask for a trade profile; the
 * caller never passes a mix of trade and order emails (`parserDraftKind`), which
 * no one profile reads, and such a mix is refused here before anything is queued.
 *
 * A parser the assistant saves is a DRAFT: it reads nothing until the user
 * approves it in the parser settings.
 */
export function useParserDraftWithAi(): (receipts: readonly EmailReceiptListItem[]) => Promise<ParserDraftOutcome> {
  const t = useTranslations('emailReceipts.receipts.draft');
  const router = useRouter();

  return useCallback(
    async (receipts) => {
      const ids = receipts.map((receipt) => receipt.id);
      const kind = parserDraftKind(receipts);
      if (kind === 'mixed') return { kind: 'failed', message: t('mixedKinds') };
      let requestId: string;
      try {
        requestId = (await emailReceiptsApi.parsers.draftWithAi(ids, kind)).requestId;
      } catch (error) {
        logger.error(error);
        return { kind: 'failed', message: getErrorMessage(error, t('failed')) };
      }
      if (!(await assistantCanAnswerNow())) return { kind: 'queued', handoffFailed: false };
      try {
        const details = await Promise.all(ids.map((id) => emailReceiptsApi.receipts.get(id)));
        const handoffId = stageChatHandoff({
          files: buildParserDraftAttachments(details),
          draft: t(kind === 'trade' ? 'chatPromptTrade' : 'chatPrompt', {
            count: details.length,
            domain: dominantSenderDomain(details),
            requestId,
          }),
        });
        toast.success(t('opened'));
        router.push(`/ai?handoff=${handoffId}`);
        return { kind: 'opened' };
      } catch (error) {
        logger.error(error);
        return { kind: 'queued', handoffFailed: true };
      }
    },
    [router, t],
  );
}
