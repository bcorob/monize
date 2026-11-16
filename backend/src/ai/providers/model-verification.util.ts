import { Logger } from "@nestjs/common";
import { tr } from "../../i18n/translate";

const logger = new Logger("AiModelVerification");

/** How much of an upstream error's text reaches the server log. */
const LOGGED_DETAIL_CHARS = 500;

/**
 * The reason a model check failed for a cause the provider code does not
 * recognise, as the person running the test sees it.
 *
 * Never the upstream text. The base URL of a self-hosted provider is chosen by
 * the user, so whatever that host answered -- an SDK error message quoting the
 * response body, a fetch error naming the address it could not reach -- would
 * otherwise be read back to the client verbatim. The HTTP status code is the
 * most this says; the full detail goes to the server log.
 */
export function unverifiedModelReason(
  provider: string,
  model: string,
  error: unknown,
  status?: number,
): string {
  const detail = error instanceof Error ? error.message : String(error ?? "");
  logger.warn(
    `Model verification failed provider=${provider} model=${model} status=${status ?? "none"}: ${detail.slice(0, LOGGED_DETAIL_CHARS)}`,
  );
  if (typeof status === "number" && Number.isInteger(status)) {
    return tr(
      "errors.ai.modelVerifyFailedStatus",
      `Could not verify the configured model: the provider answered with HTTP status ${status}.`,
      { status },
    );
  }
  return tr(
    "errors.ai.modelVerifyFailed",
    "Could not verify the configured model. Check the base URL and that the provider is reachable.",
  );
}
