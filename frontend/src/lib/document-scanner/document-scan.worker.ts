/// <reference lib="webworker" />
import {
  handleScanMessage,
  transferablesFor,
} from './document-scan-messages';
import type { ScannerRequest } from './document-scan.types';

/**
 * The worker entry point, and nothing else.
 *
 * Every decision it makes is in `document-scan-messages.ts`, which runs
 * anywhere; what is left here is the part that needs a real `Worker` global and
 * therefore cannot be unit tested. Keep it this small -- a branch added here is
 * a branch no suite can reach, and that includes a ternary.
 *
 * The image buffers are transferred rather than copied (`transferablesFor`): a
 * multi-megabyte structured clone per reply is the difference between an
 * instant preview and a visible stall on a phone.
 */
self.onmessage = (event: MessageEvent<ScannerRequest>) => {
  void handleScanMessage(event.data).then((response) => {
    (self as unknown as Worker).postMessage(
      response,
      transferablesFor(response),
    );
  });
};
