/**
 * A Jest reporter that prints nothing for a passing spec file, the full failure
 * message for a failing one, and one line when the run ends. `npm run
 * test:changed` uses it so that the output an agent reads is the failures and
 * nothing else. The built-in `summary` reporter is not used: it prints failure
 * detail only above a suite-count threshold, so a small failing run would
 * report a count and no cause.
 */
class FailuresOnlyReporter {
  onTestResult(_test, result) {
    if (result.numFailingTests > 0 || result.testExecError) {
      process.stdout.write(`${result.failureMessage ?? ""}\n`);
    }
  }

  onRunComplete(_contexts, results) {
    const { numTotalTestSuites, numFailedTestSuites, numFailedTests } = results;
    process.stdout.write(
      `Specs: ${numTotalTestSuites - numFailedTestSuites}/${numTotalTestSuites} files passed, ${numFailedTests} failing tests\n`,
    );
  }

  getLastError() {
    return undefined;
  }
}

module.exports = FailuresOnlyReporter;
