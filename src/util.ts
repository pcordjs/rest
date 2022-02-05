export function captureStack(this: void) {
  const stackObject: { stack: string } = { stack: '' };
  Error.captureStackTrace(stackObject, captureStack);
  return stackObject.stack;
}
