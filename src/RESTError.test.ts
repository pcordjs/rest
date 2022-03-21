/// <reference types="jest" />

import * as errors from './RESTError';

describe(errors.default, () => {
  it('should take arguments to augment the message', () => {
    const error = new errors.default(
      errors.RESTErrorCode.TIMEOUT,
      'argumentOne',
      1500
    );
    expect(error.message).toMatch(/argumentOne/);
    expect(error.message).toMatch(/1500/);
  });
});

describe(errors.DiscordAPIError, () => {
  it('should show its error code in the stack', () => {
    const error = new errors.DiscordAPIError(
      123,
      'An error message',
      'A stack trace'
    );

    expect(error.stack).toContain('123');
  });
});
