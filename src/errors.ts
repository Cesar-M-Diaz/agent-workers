export class JobError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'JobError';
    this.code = code;
  }
}
