import { format } from 'node:util';

export enum RESTErrorCode {
  /** Used when a token is requried but cannot be found */
  TOKEN_REQUIRED,
  /** Used when a request takes too long to finish and is cancelled. */
  TIMEOUT,
  /**
   * Used when an invalid API version is provided.
   * API versions must be a whole number greater than 0.
   */
  INVALID_API_VERSION
}

const messages: Record<RESTErrorCode, string> = {
  [RESTErrorCode.TOKEN_REQUIRED]:
    'A token is required to perform this operation.',
  [RESTErrorCode.TIMEOUT]: 'The request to %s timed out after %dms.',
  [RESTErrorCode.INVALID_API_VERSION]: 'An invalid API version was provided.'
};

export default class RESTError extends Error {
  public constructor(public readonly code: RESTErrorCode, ...args: unknown[]) {
    super(format(messages[code], ...args));
  }
}

export class RESTWarning extends RESTError {}

export class DiscordAPIError extends Error {
  public constructor(
    public readonly code: number,
    message: string,
    stack?: string
  ) {
    super(message);
    if (stack) this.stack = `${this.name}: ${message}\n${stack}`;
  }
}
