import { format } from 'node:util';

/**
 * Error codes for {@link RESTError} objects.
 */
export enum RESTErrorCode {
  /** Used when a token is required but cannot be found */
  TOKEN_REQUIRED,
  /** Used when a request takes too long to finish and is cancelled. */
  TIMEOUT,
  /**
   * Used when an invalid API version is provided. API versions must be a whole
   * number greater than 0.
   */
  INVALID_API_VERSION
}

const messages: Record<RESTErrorCode, string> = {
  [RESTErrorCode.TOKEN_REQUIRED]:
    'A token is required to perform this operation.',
  [RESTErrorCode.TIMEOUT]: 'The request to %s timed out after %dms.',
  [RESTErrorCode.INVALID_API_VERSION]: 'An invalid API version was provided.'
};

/**
 * An error created by a {@link RESTClient}.
 */
export default class RESTError extends Error {
  public constructor(public readonly code: RESTErrorCode, ...args: unknown[]) {
    super(format(messages[code], ...args));
  }

  public override name = this.constructor.name;
}

/**
 * An error created by the Discord API.
 *
 * @remarks
 * If an API response did not fail with an error code, the
 * {@link DiscordAPIError.code} property will be set to `-1`.
 */
export class DiscordAPIError extends Error {
  public constructor(
    public readonly code: number,
    message: string,
    stack?: string
  ) {
    super(message);
    if (stack) this.stack = `${this.name} [${this.code}]: ${message}\n${stack}`;
  }

  public override name = this.constructor.name;
}
