export class HttpError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export const badRequest = (message: string) => new HttpError(400, message);
export const notFound = (message = 'Not found') => new HttpError(404, message);
export const conflict = (message: string) => new HttpError(409, message);
