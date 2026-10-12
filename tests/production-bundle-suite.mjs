// SIMULATED ONLY. The `package` suite (FC-08, fulfillment-connectors #10): the real offline ProductionBundle consumer over the
// owner @jevelopers/shared-contracts 0.9.7 verifier, the actual print-production corpus bytes, fixture host ports and the fail-closed
// runtime gate. Passing proves this consumer against the owner's UNACCEPTED development candidate and synthetic bytes. It is not
// consumer conformance, not acceptance of issue 10, and approves, authorizes and accepts nothing.
import assert from "node:assert/strict";
import { PACKAGE_SUITE_CASE_IDS } from "../scripts/run-package-tests.mjs";
import { cleanupMockMeteringArtifacts } from "./mock-fixtures.mjs";
import { register as registerCore } from "./production-bundle-cases-core.mjs";
import { register as registerGeometry } from "./production-bundle-cases-geometry.mjs";
import { register as registerResources } from "./production-bundle-cases-resources.mjs";
import { register as registerRuntime } from "./production-bundle-cases-runtime.mjs";

const implementations = new Map();
function define(id, run) {
  assert.ok(!implementations.has(id), `duplicate case ${id}`);
  implementations.set(id, run);
}
registerCore(define);
registerResources(define);
registerGeometry(define);
registerRuntime(define);

const registered = [...implementations.keys()];
assert.deepEqual(registered.filter((id) => !PACKAGE_SUITE_CASE_IDS.includes(id)), [], "every implemented case must be listed in the runner");
assert.deepEqual(PACKAGE_SUITE_CASE_IDS.filter((id) => !implementations.has(id)), [], "every listed case must be implemented");

const caseRecords = [];
// Cases run strictly one after another: the deadline and allocation cases are timing- and heap-sensitive.
for (const id of PACKAGE_SUITE_CASE_IDS) {
  try {
    await implementations.get(id)();
    caseRecords.push({ id, status: "passed" });
  } catch (error) {
    const detail = error instanceof assert.AssertionError ? "assertion_failed" : "case_execution_failed";
    caseRecords.push({ id, status: "failed", detail });
    if (process.env.FC_PACKAGE_DEBUG === "1") process.stderr.write(`${id}: ${error?.stack ?? error}\n`);
  }
}
await cleanupMockMeteringArtifacts();

const passed = caseRecords.filter((record) => record.status === "passed").length;
const failed = caseRecords.length - passed;
process.stdout.write(`${JSON.stringify({
  schemaVersion: "fulfillment-package-case-results/1",
  suite: "package",
  caseCount: caseRecords.length,
  passed,
  failed,
  skipped: 0,
  cases: caseRecords
})}\n`);
if (failed !== 0) process.exitCode = 1;
