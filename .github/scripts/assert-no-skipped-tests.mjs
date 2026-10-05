// Fails the CI job when a vitest JSON report holds a skipped or todo test, or
// no test at all.
//
// The PostgreSQL-backed suites skip themselves when they cannot reach their
// database (`describe.skipIf(!dbUp)`), and vitest counts a skip as a pass. In
// the CI database steps a skip therefore means the database never reached the
// test, so it must fail the job instead of turning it green.
//
// Usage: node assert-no-skipped-tests.mjs <report.json>...
// A missing or unreadable report fails too.
import { readFileSync } from "node:fs";

const reports = process.argv.slice(2);
if (reports.length === 0) {
  console.error("assert-no-skipped-tests: no report given");
  process.exit(1);
}

let failed = false;
for (const report of reports) {
  const { numTotalTests, testResults } = JSON.parse(readFileSync(report, "utf8"));
  const notRun = testResults.flatMap((file) =>
    file.assertionResults
      .filter((test) => test.status !== "passed" && test.status !== "failed")
      .map((test) => `${file.name} > ${test.fullName} (${test.status})`)
  );
  console.log(`${report}: ${numTotalTests} tests, ${notRun.length} not run`);
  for (const line of notRun) console.error(`  not run: ${line}`);
  if (numTotalTests === 0 || notRun.length > 0) failed = true;
}
process.exit(failed ? 1 : 0);
