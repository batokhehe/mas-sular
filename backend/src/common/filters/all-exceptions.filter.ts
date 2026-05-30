import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { Logger } from 'nestjs-pino';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest<{ url: string; method: string }>();
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const rawMessage = exception instanceof HttpException ? exception.getResponse() : 'Internal server error';
    const message = this.parseMessage(rawMessage);

    this.logger.error({ err: exception, method: request.method, url: request.url }, 'request failed');
    response.status(status).json({
      statusCode: status,
      message,
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }

  private parseMessage(raw: unknown): string {
    if (typeof raw === 'string') {
      return raw;
    }

    if (Array.isArray(raw)) {
      return raw.map((item) => this.parseMessage(item)).join(', ');
    }

    if (raw && typeof raw === 'object') {
      const messageField = (raw as Record<string, unknown>).message;
      if (messageField !== undefined) {
        return this.parseMessage(messageField);
      }

      const errorField = (raw as Record<string, unknown>).error;
      if (typeof errorField === 'string') {
        return `${errorField}`;
      }

      return JSON.stringify(raw);
    }

    return String(raw);
  }
}
