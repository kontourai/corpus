/** Exit 1: a docs gate failed. Exit 2: the invocation or configuration is wrong. */
export const EXIT_OK = 0;
export const EXIT_GATE = 1;
export const EXIT_USAGE = 2;

export class DocsKitError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.name = this.constructor.name;
    this.exitCode = exitCode;
  }
}

export class UsageError extends DocsKitError {
  constructor(message) {
    super(message, EXIT_USAGE);
  }
}

export class GateFailure extends DocsKitError {
  constructor(message) {
    super(message, EXIT_GATE);
  }
}
