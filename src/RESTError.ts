import { format } from 'util';
export enum RESTErrorCode {
  /** Used when a token is requried but cannot be found */
  TOKEN_REQUIRED,
  /** Used when a request takes too long to finish and is cancelled. */
  TIMEOUT
}

const messages: Record<RESTErrorCode, string> = {
  [RESTErrorCode.TOKEN_REQUIRED]:
    'A token is required to perform this operation.',
  [RESTErrorCode.TIMEOUT]: 'The request to %s timed out after %dms.'
};

export default class RESTError extends Error {
  public constructor(public readonly code: RESTErrorCode, ...args: unknown[]) {
    super(format(messages[code], ...args));
  }
}
