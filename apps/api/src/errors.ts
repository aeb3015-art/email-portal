export class HttpError extends Error {
  constructor(public status: number, message: string, public code = 'error') {
    super(message);
  }
}
export const notFound = (what = 'Resource') => new HttpError(404, `${what} not found`, 'not_found');
export const forbidden = (msg = 'Forbidden') => new HttpError(403, msg, 'forbidden');
export const badRequest = (msg: string) => new HttpError(400, msg, 'bad_request');
