import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { Response } from 'express';

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (error instanceof HttpException) {
      const body = error.getResponse();
      response.status(error.getStatus()).json(typeof body === 'string'
        ? { statusCode: error.getStatus(), message: body } : body);
      return;
    }
    // Express raw-body transport errors are not Nest HttpExceptions.
    const status = (error as { status?: number } | null)?.status;
    if (status === 413 || status === 415 || status === 400) {
      response.status(status).json({ statusCode: status, message: 'Invalid request body' });
      return;
    }
    response.status(500).json({ statusCode: 500, message: 'Internal server error' });
  }
}
