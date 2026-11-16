import { Logger } from "@nestjs/common";
import { TestingModuleBuilder } from "@nestjs/testing";

// Jest `setupFiles` entry for the unit suite. Services log their failure
// paths through the Nest `Logger`, and the unit tests drive those paths on
// purpose, so the default console logger filled the CI log with hundreds of
// ERROR and WARN lines and stack traces that were not failures. With no
// static logger every `Logger` instance call is a no-op, while a
// `jest.spyOn(Logger.prototype, ...)` or a spy on a service's own `logger`
// still records the call, so assertions on what was logged are unaffected.
Logger.overrideLogger(false);

// `TestingModuleBuilder.compile()` re-installs Nest's `TestingLogger`, which
// prints every error, so keep it silent too unless a spec chose a logger with
// `setLogger(...)`.
type LoggerApplying = { testingLogger?: Logger; applyLogger: () => void };
(TestingModuleBuilder.prototype as unknown as LoggerApplying).applyLogger =
  function (this: LoggerApplying) {
    Logger.overrideLogger(this.testingLogger ?? false);
  };
