import { ExceptionFilter, Catch, ArgumentsHost, Logger } from "@nestjs/common";
import { Response } from "express";
import { httpErrorBody } from "./http-error-body";

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);
  private readonly isProduction = process.env.NODE_ENV === "production";

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    if (response.headersSent) {
      return;
    }

    const { statusCode, message, errorCode, errors, currentCount } =
      httpErrorBody(exception, this.logger);

    response.status(statusCode).json({
      statusCode,
      message,
      ...(errorCode ? { errorCode } : {}),
      ...(errors ? { errors } : {}),
      ...(currentCount !== undefined ? { currentCount } : {}),
      ...(this.isProduction ? {} : { timestamp: new Date().toISOString() }),
    });
  }
}
