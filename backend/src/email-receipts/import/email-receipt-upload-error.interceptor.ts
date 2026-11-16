import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  HttpException,
  HttpStatus,
  PayloadTooLargeException,
} from "@nestjs/common";
import { Observable, catchError, defer, finalize, throwError } from "rxjs";
import { tr } from "../../i18n/translate";

/** Largest single file of an archive import, in MB (multer's `fileSize`). */
export const EMAIL_IMPORT_FILE_LIMIT_MB = 25;
export const EMAIL_IMPORT_FILE_LIMIT_BYTES =
  EMAIL_IMPORT_FILE_LIMIT_MB * 1024 * 1024;
/** Most files of one archive import request. */
export const EMAIL_IMPORT_MAX_FILES = 20;
/**
 * Largest whole import request, in MB: one 25 MB file and its multipart
 * framing. multer keeps the files in memory, and the frontend's route buffers
 * what the backend has not read yet (Next.js gives it no backpressure), so the
 * declared body size is refused above this before multer reads a byte; the
 * browser sends one part per request. A body of undeclared length
 * (an HTTP/3 edge relays one) is bounded by the frontend's streaming route for
 * this path (`LARGE_UPLOAD_ROUTES`), which cuts it off at the same ceiling.
 */
export const EMAIL_IMPORT_REQUEST_LIMIT_MB = 26;
export const EMAIL_IMPORT_REQUEST_LIMIT_BYTES =
  EMAIL_IMPORT_REQUEST_LIMIT_MB * 1024 * 1024;

/**
 * Users with an import request in flight on this replica. multer holds a
 * request's files in memory (up to the request limit), so one user's requests
 * run one at a time: the throttle bounds how many arrive a minute, this bounds
 * how many bodies are held at once. Per replica, which is where the memory is.
 */
const importsInFlight = new Set<string>();

/** The authenticated user's id (the JWT guard runs before interceptors), or null. */
function userIdOf(context: ExecutionContext): string | null {
  const request = context
    .switchToHttp()
    .getRequest<{ user?: { id?: unknown } }>();
  const id = request.user?.id;
  return typeof id === "string" && id !== "" ? id : null;
}

/** The request's declared body size, or null when it declares none or an unreadable one. */
function declaredLength(context: ExecutionContext): number | null {
  const request = context
    .switchToHttp()
    .getRequest<{ headers: Record<string, string | string[] | undefined> }>();
  const header = request.headers["content-length"];
  if (typeof header !== "string" || !/^\d+$/.test(header)) return null;
  return Number(header);
}

/**
 * Refuses a second import request of the same user while one is in flight,
 * refuses an import request whose declared body is above
 * `EMAIL_IMPORT_REQUEST_LIMIT_BYTES`, and replaces multer's untranslated "File too large" (a
 * `PayloadTooLargeException`) with a localized 413 that names the limit.
 * Registered before the `FilesInterceptor`, so it runs before multer reads the
 * body and sits outside it, like `MnyUploadErrorInterceptor`.
 */
@Injectable()
export class EmailReceiptUploadErrorInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const length = declaredLength(context);
    if (length !== null && length > EMAIL_IMPORT_REQUEST_LIMIT_BYTES) {
      return throwError(
        () =>
          new PayloadTooLargeException({
            message: tr(
              "errors.emailReceipts.importRequestTooLarge",
              `The files together are larger than the ${EMAIL_IMPORT_REQUEST_LIMIT_MB} MB limit. Import them in smaller groups.`,
              { limit: EMAIL_IMPORT_REQUEST_LIMIT_MB },
            ),
            errorCode: "emailReceiptImportRequestTooLarge",
          }),
      );
    }
    const userId = userIdOf(context);
    if (userId !== null && importsInFlight.has(userId)) {
      return throwError(
        () =>
          new HttpException(
            {
              message: tr(
                "errors.emailReceipts.importInProgress",
                "An import is already running. Wait until it finishes.",
              ),
              errorCode: "emailReceiptImportInProgress",
            },
            HttpStatus.TOO_MANY_REQUESTS,
          ),
      );
    }
    if (userId !== null) importsInFlight.add(userId);
    const release = () => {
      if (userId !== null) importsInFlight.delete(userId);
    };
    return defer(() => next.handle()).pipe(
      finalize(release),
      catchError((error: unknown) =>
        throwError(() =>
          error instanceof PayloadTooLargeException
            ? new PayloadTooLargeException({
                message: tr(
                  "errors.emailReceipts.importFileTooLarge",
                  `A file is larger than the ${EMAIL_IMPORT_FILE_LIMIT_MB} MB limit.`,
                  { limit: EMAIL_IMPORT_FILE_LIMIT_MB },
                ),
                errorCode: "emailReceiptImportFileTooLarge",
              })
            : error,
        ),
      ),
    );
  }
}
