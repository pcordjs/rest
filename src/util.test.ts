/// <reference types="jest" />

// eslint-disable-next-line no-restricted-imports
import * as util from './util';

it('should capture stack frames', () => {
  function thisShouldBeInTheStack() {
    return util.captureStack();
  }

  const stack = thisShouldBeInTheStack();

  // the stack should contain the function name
  expect(stack).toMatch(/thisShouldBeInTheStack/);

  // there should be a prefix of a single newline
  expect(stack).toMatch(/^\n[^\n]/);
});

export {};
