import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_SUITE_CASE_IDS = Object.freeze([
  "provenance.generated-pins-all-64-plus-corpus",
  "provenance.variants-derived-55-in-memory",
  "provenance.synthetic-flags-and-null-finance",
  "provenance.spec-hash-derived-not-typed",
  "provenance.new-source-crossbound-to-manifest-corpus-receipt-and-owner-pin",
  "provenance.superseded-input-recorded-by-digest-with-computed-delta",
  "anchor.resolved-only-from-scope-and-digest",
  "anchor.envelope-cannot-choose-anchor-hash-or-provenance",
  "anchor.caller-supplied-anchor-object-rejected",
  "anchor.hash-and-length-before-parse",
  "anchor.forged-eligibility-commitment-rejected-by-pin",
  "anchor.unpublished-fails",
  "anchor.digest-mismatch-fails",
  "anchor.provenance-development-fixture-upgrades-nothing",
  "anchor.corpus-control-inventory-crosscheck-only",
  "anchor.superseded-commitment-and-manifest-cannot-bind-the-new-bundle",
  "anchor.control-json-cap-is-consumer-resource-bound-and-parse-overflow-mapped",
  "bytes.content-addressed-read-uses-owner-byte-hash",
  "bytes.maxlength-honored-and-wrong-length-rejected-before-hash",
  "bytes.missing-file-fails",
  "bytes.extra-file-fails",
  "bytes.store-throw-fails-closed",
  "snapshot.exact-uint8array-only",
  "snapshot.subarray-window-copied",
  "snapshot.mutation-after-copy-neutral",
  "snapshot.single-read-of-caller-fields",
  "snapshot.owner-and-png-see-private-copy-only",
  "snapshot.digests-before-after-unchanged",
  "snapshot.native-intrinsics-captured-at-module-load",
  "snapshot.own-bytelength-shadow-typed-rejection",
  "snapshot.own-bytelength-hides-overcap-typed-rejection",
  "snapshot.own-length-shadow-typed-rejection",
  "snapshot.own-buffer-masks-sab-rejected",
  "snapshot.sab-own-tostringtag-rejected",
  "snapshot.sab-plain-rejected",
  "snapshot.resizable-own-false-rejected",
  "snapshot.resizable-length-tracking-own-false-rejected",
  "snapshot.own-byteoffset-shadow-typed-rejection",
  "snapshot.own-symbol-iterator-shadow-typed-rejection",
  "snapshot.own-symbol-tostringtag-shadow-typed-rejection",
  "snapshot.own-constructor-species-shadow-typed-rejection",
  "snapshot.own-set-slice-subarray-shadows-typed-rejection",
  "snapshot.own-throwing-buffer-getter-typed-rejection",
  "snapshot.detached-buffer-rejected",
  "snapshot.buffer-dataview-clamped-crossrealm-rejected",
  "snapshot.proxy-view-file-array-entry-revoked-rejected",
  "snapshot.shadows-inert-without-denylist-copy-hash-equals-truth",
  "snapshot.post-capture-intrinsic-tampering-neutral",
  "snapshot.entry-accessor-rejected-extra-getter-never-read",
  "snapshot.files-array-hostile-length-holes-iterator-hook",
  "snapshot.byte-source-result-shapes-typed",
  "snapshot.all-throw-paths-typed-no-uncaught",
  "snapshot.large-view-no-key-enumeration-allocation-bound",
  "bounds.duplicate-and-case-variant-names-rejected-before-any-copy",
  "bounds.count-is-exactly-owner-outer-descriptors-without-slack",
  "bounds.per-name-role-caps-and-payload-group-checked-before-copy",
  "bounds.aggregate-and-group-sums-explicit-with-safe-integer-arithmetic",
  "bounds.repeated-view-no-copy-amplification-child-process",
  "bounds.shadow-denylist-switch-unreachable-from-the-validators",
  "budgets.descriptor-count-over-limit",
  "budgets.per-role-cap-over",
  "budgets.aggregate-over-cap",
  "budgets.checked-before-any-copy-or-payload-read",
  "budgets.limits-read-from-owner-export",
  "budgets.concurrency-semaphore-and-queue-overflow",
  "owner.valid-integrity-passed-eligibility-blocked",
  "owner.tampered-payload",
  "owner.tampered-manifest",
  "owner.tampered-detached",
  "owner.missing-payload",
  "owner.missing-manifest",
  "owner.extra-file",
  "owner.flip-and-truncate-each-of-8-files",
  "owner.colliding-traversal-duplicate-names",
  "owner.scope-snake-case-mapping",
  "owner.wrong-scope",
  "owner.commitment-in-file-list-rejected",
  "owner.commitment-prevalidated-before-any-budget-read",
  "owner.commitment-prevalidation-structural-not-scope",
  "owner.all-owner-throws-caught-typed",
  "attribution.only-after-owner-failure",
  "attribution.names-file-from-anchored-file-set",
  "attribution.unattributed-when-hashes-agree",
  "attribution.absent-on-pass",
  "attribution.removal-changes-no-verdict",
  "attribution.never-parses-manifest-zip-detached",
  "png.observed-pixels-match-manifest",
  "png.effective-dpi-derived-integer-exact",
  "png.phys-metadata-consistent",
  "png.phys-absent-or-unit0-not-observed",
  "png.wrong-hash-and-one-byte-mutation",
  "pdfsvg.geometry-declared-not-observed",
  "geometry.unit.png-pixel-mismatch-fails",
  "geometry.unit.png-phys-mismatch-fails",
  "geometry.unit.spoofed-mime-fails",
  "geometry.unit.pdf-and-svg-signature-negatives",
  "geometry.e2e.recommitted-png-phys-mismatch-owner-passes-consumer-fails",
  "geometry.e2e.recommitted-declared-width-owner-passes-consumer-fails",
  "geometry.e2e.recommitted-declared-dpi-owner-passes-consumer-fails",
  "geometry.e2e.recommitted-png-bytes-are-pdf-owner-passes-consumer-fails",
  "geometry.e2e.recommitted-garbage-png-owner-passes-consumer-fails",
  "geometry.e2e.recommitted-pdf-without-signature-owner-passes-consumer-fails",
  "geometry.e2e.recommitted-svg-without-root-owner-passes-consumer-fails",
  "geometry.owner-first-ordering-mutated-png-under-real-anchor-is-owner-integrity",
  "fixtures.recommit-helper-reproduces-baseline-manifest-detached-archive-byte-identical",
  "fixtures.recommit-uses-only-owner-hash-helpers-and-test-only-zip-writer",
  "fixtures.test-zip-writer-not-importable-from-src",
  "fixtures.independent-fixture-publication-pin-matches-committed-bytes",
  "criteria.frozen-table-immutable",
  "criteria.no-option-or-type-selects-criteria",
  "criteria.critical-blocked-typed-codes",
  "criteria.no-caller-providerfit-effect",
  "criteria.no-preflight-trust-from-bundle",
  "criteria.no-positive-eligible-representable",
  "terms.binding-match-fixture-diagnostic-only",
  "terms.approval-id-exact",
  "terms.capability-version-unmapped-blocked",
  "terms.source-absent-is-critical-blocked-TERMS_SOURCE_ABSENT",
  "terms.source-absent-never-verified-binding",
  "terms.binding-mismatch-invalid",
  "digest.defined-as-owner-bundle-content-hash",
  "digest.simulator-reference-adaptation",
  "digest.existing-suites-digests-unchanged",
  "digest.submit-body-and-auth-facts-and-terms-request-bind-same",
  "digest.envelope-reference-mismatch-fails",
  "deadline.never-resolving-resolve-hits-finite-deadline-with-frozen-clock",
  "deadline.never-resolving-read-hits-finite-deadline-with-frozen-clock",
  "deadline.abort-signal-delivered-to-ports",
  "deadline.late-completion-ignored-and-bytes-not-retained",
  "deadline.late-rejection-swallowed-no-unhandled-rejection",
  "deadline.semaphore-release-idempotent-no-permanent-hold",
  "deadline.stalled-holders-do-not-block-queue-forever",
  "deadline.total-validation-deadline",
  "runtime.simulated-integrity-observation-evidence-blocked",
  "runtime.gate-missing-with-accepted-binding-contract-missing",
  "runtime.gate-missing-simulated-unchanged",
  "runtime.hook-installed-gate-only",
  "runtime.hook-installed-verifier-only",
  "runtime.hook-order-gate-then-auth-last-then-sync-compare",
  "runtime.recheck-every-transport-attempt-including-retries",
  "runtime.bytes-changed-bundle-changed-zero-transport",
  "runtime.store-failure-zero-transport",
  "runtime.error-codes-nonretryable-sideeffect-from-transportcalled",
  "runtime.existing-gates-unweakened",
  "runtime.nonsimulated-submit-hard-block-before-any-port-call",
  "runtime.hard-block-follows-existing-mode-and-binding-gates-codes-preserved",
  "runtime.quote-preflight-status-shipment-cancel-behaviors-unaffected",
  "runtime.sandbox-forged-accepted-binding-with-gate-zero-ports-zero-transports",
  "runtime.unbranded-gate-rejected",
  "runtime.gate-claiming-eligible-or-extra-keys-rejected",
  "runtime.fixed-criterion-code-tamper-with-recomputed-digests-rejected-zero-effects",
  "runtime.gate-report-literals-digests-provenance-sorted-codes-validated",
  "runtime.simulated-no-effect-simulation-labelled-blocked-with-open-critical-codes",
  "runtime.hard-block-precedes-validateInbound-with-all-bindings-forged-accepted",
  "runtime.recommitted-invalid-geometry-or-signature-never-reaches-simulated-transport",
  "static.single-owner-import-site",
  "static.forbidden-owner-functions-never-imported",
  "static.owner-not-loaded-by-index",
  "static.docs-d6-wording-consistent",
  "static.docs-pbr25-abort-signal-memory-bound-limit-documented",
  "suite.package-wrapper-fixed-evidence-dir",
  "suite.report-fields-complete",
  "suite.node-pin-24-21-0",
  "suite.zero-provider-order-finance-calls",
  "runner.output-parser-rejects-malformed-and-inconsistent-reports",
  "runner.report-validator-and-process-control-reject-unsafe-reports"
]);

export const PACKAGE_SUITE_CASE_COUNT = PACKAGE_SUITE_CASE_IDS.length;

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const suiteFile = fileURLToPath(new URL("../tests/production-bundle-suite.mjs", import.meta.url));
const caseSchema = "fulfillment-package-case-results/1";
const reportSchema = "fulfillment-package-suite-result/1";
const outputFailureId = "runner.output-validation";
const processFailureId = "runner.process-exit";
const stderrFailureId = "runner.stderr";

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");
}

export function parsePackageOutput(stdout) {
  if (typeof stdout !== "string" || stdout.length === 0 || !stdout.endsWith("\n") || stdout.includes("\r")) {
    return { valid: false, cases: [] };
  }
  let report;
  try {
    report = JSON.parse(stdout.slice(0, -1));
  } catch {
    return { valid: false, cases: [] };
  }
  const reportKeys = ["schemaVersion", "suite", "caseCount", "passed", "failed", "skipped", "cases"];
  if (!exactKeys(report, reportKeys) || report.schemaVersion !== caseSchema || report.suite !== "package" ||
    report.caseCount !== PACKAGE_SUITE_CASE_COUNT || !Number.isSafeInteger(report.passed) ||
    !Number.isSafeInteger(report.failed) || report.skipped !== 0 || !Array.isArray(report.cases) ||
    report.passed < 0 || report.failed < 0 || report.passed + report.failed !== report.cases.length ||
    report.cases.length !== PACKAGE_SUITE_CASE_COUNT) return { valid: false, cases: [] };

  const cases = [];
  const seen = new Set();
  for (let index = 0; index < report.cases.length; index += 1) {
    const item = report.cases[index];
    const validStatus = item?.status === "passed"
      ? exactKeys(item, ["id", "status"])
      : item?.status === "failed" && exactKeys(item, ["id", "status", "detail"]) &&
        ["assertion_failed", "case_execution_failed"].includes(item.detail);
    if (!validStatus || item.id !== PACKAGE_SUITE_CASE_IDS[index] ||
      !["passed", "failed"].includes(item.status) || seen.has(item.id)) return { valid: false, cases: [] };
    seen.add(item.id);
    cases.push({ name: item.id, status: item.status, ...(item.status === "failed" ? { detail: item.detail } : {}) });
  }
  if (seen.size !== PACKAGE_SUITE_CASE_COUNT ||
    report.passed !== report.cases.filter((item) => item.status === "passed").length ||
    report.failed !== report.cases.filter((item) => item.status === "failed").length) {
    return { valid: false, cases: [] };
  }
  return { valid: true, cases };
}

export function validPackageRunnerReport(report) {
  const reportKeys = ["schemaVersion", "suite", "mode", "status", "passed", "failed", "results",
    "processExitCode", "processSignal", "processError", "stderrPresent", "externalProviderCalls",
    "orderCalls", "financeCalls", "sandboxReady", "liveEnabled", "releaseReady", "skipped"];
  if (!exactKeys(report, reportKeys) || report.schemaVersion !== reportSchema || report.suite !== "package" ||
    report.mode !== "simulated" || !["passed", "failed"].includes(report.status) ||
    !Number.isSafeInteger(report.passed) || !Number.isSafeInteger(report.failed) || !Array.isArray(report.results) ||
    report.passed < 0 || report.failed < 0 || report.passed + report.failed !== report.results.length ||
    ((!Number.isSafeInteger(report.processExitCode) || report.processExitCode < 0 || report.processExitCode > 255) && report.processExitCode !== null) ||
    (report.processSignal !== null && (typeof report.processSignal !== "string" || !/^SIG[A-Z0-9]{1,32}$/u.test(report.processSignal))) ||
    (report.processError !== null && (typeof report.processError !== "string" || !/^[A-Z][A-Z0-9_]{0,39}$/u.test(report.processError))) ||
    typeof report.stderrPresent !== "boolean" || report.externalProviderCalls !== 0 || report.orderCalls !== 0 ||
    report.financeCalls !== 0 || report.sandboxReady !== false || report.liveEnabled !== false ||
    report.releaseReady !== false || report.skipped !== 0) return false;

  const names = new Set();
  for (const item of report.results) {
    if (item === null || typeof item !== "object" || Array.isArray(item) ||
      !["passed", "failed"].includes(item.status) || typeof item.name !== "string" || names.has(item.name)) return false;
    if (item.status === "passed" && !exactKeys(item, ["name", "status"])) return false;
    if (item.status === "failed" && (!exactKeys(item, ["name", "status", "detail"]) || typeof item.detail !== "string")) return false;
    names.add(item.name);
  }
  if (report.passed !== report.results.filter((item) => item.status === "passed").length ||
    report.failed !== report.results.filter((item) => item.status === "failed").length ||
    report.status !== (report.failed === 0 ? "passed" : "failed")) return false;

  const ordinary = report.results.filter((item) => ![outputFailureId, processFailureId, stderrFailureId].includes(item.name));
  const ordinaryNames = ordinary.map((item) => item.name);
  const validOrdinaryPrefix = ordinaryNames.length === PACKAGE_SUITE_CASE_COUNT &&
    ordinaryNames.every((name, index) => name === PACKAGE_SUITE_CASE_IDS[index]) &&
    ordinary.every((item) => item.status === "passed" ||
      ["assertion_failed", "case_execution_failed"].includes(item.detail));
  if (report.status === "passed") {
    return validOrdinaryPrefix && ordinary.every((item) => item.status === "passed") &&
      report.results.length === PACKAGE_SUITE_CASE_COUNT &&
      report.processExitCode === 0 && report.processSignal === null && report.processError === null &&
      report.stderrPresent === false;
  }

  const special = report.results.filter((item) => [outputFailureId, processFailureId, stderrFailureId].includes(item.name));
  if (special.some((item) => item.status !== "failed")) return false;
  const allowedDetails = new Map([
    [outputFailureId, new Set(["invalid_suite_output", "runner_report_invalid"])],
    [processFailureId, new Set(["ENOENT", "EACCES", "spawn_failed", "invalid_spawn_result", "child_signaled",
      "child_exit_nonzero_or_unknown", "suite_failed_exit_success"])],
    [stderrFailureId, new Set(["stderr_present"])]
  ]);
  if (special.some((item) => item.name === processFailureId
    ? !allowedDetails.get(item.name)?.has(item.detail) && item.detail !== report.processError
    : !allowedDetails.get(item.name)?.has(item.detail))) return false;
  if (ordinary.length !== 0 && !validOrdinaryPrefix) return false;
  if (special.some((item) => item.name === outputFailureId) && ordinary.length !== 0) return false;
  if (report.stderrPresent !== special.some((item) => item.name === stderrFailureId)) return false;
  if ((report.processError !== null || report.processSignal !== null ||
    (report.processExitCode !== null && report.processExitCode !== 0)) &&
    !special.some((item) => item.name === processFailureId)) return false;
  if (ordinary.some((item) => item.status === "failed") && report.processExitCode === 0 &&
    !special.some((item) => item.name === processFailureId && item.detail === "suite_failed_exit_success")) return false;
  if (special.length === 0 && !ordinary.some((item) => item.status === "failed")) return false;
  if (report.processExitCode === 0 && report.processSignal === null && report.processError === null &&
    !report.stderrPresent && !special.some((item) => item.name === outputFailureId)) return false;
  return true;
}

function credentialFreeEnvironment() {
  const environment = {};
  for (const key of ["PATH", "TMPDIR", "TMP", "TEMP"]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return environment;
}

function safeProcessError(error) {
  const code = error !== null && typeof error === "object" && typeof error.code === "string" ? error.code : "";
  return /^[A-Z][A-Z0-9_]{0,39}$/u.test(code) ? code : "spawn_failed";
}

// The suite child's stderr is NEVER part of the validated report (its mere presence is the `runner.stderr` failure). When the run FAILED, the command-line
// entry below copies a bounded, control-character-free head of it to this process's own stderr so a CI log carries the narrow diagnostic a failing case wrote.
let lastChildStderr = "";

export function runPackageTests({ spawn = spawnSync } = {}) {
  lastChildStderr = "";
  let child;
  try {
    child = spawn(process.execPath, [suiteFile], {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 300_000,
      maxBuffer: 2 * 1024 * 1024,
      env: credentialFreeEnvironment()
    });
  } catch (error) {
    child = { stdout: "", stderr: "", status: null, signal: null, error: { code: safeProcessError(error) } };
  }
  if (child === null || typeof child !== "object") {
    child = { stdout: "", stderr: "", status: null, signal: null, error: { code: "invalid_spawn_result" } };
  }

  if (typeof child.stderr === "string") lastChildStderr = child.stderr;
  const parsed = parsePackageOutput(child.stdout);
  const processError = child.error === undefined ? null : safeProcessError(child.error);
  const rawSignal = child.signal;
  const processSignal = rawSignal === null || rawSignal === undefined
    ? null
    : typeof rawSignal === "string" && /^SIG[A-Z0-9]{1,32}$/u.test(rawSignal) ? rawSignal : "SIGUNKNOWN";
  const processExitCode = Number.isSafeInteger(child.status) && child.status >= 0 && child.status <= 255 ? child.status : null;
  const stderrPresent = typeof child.stderr !== "string" || child.stderr.length !== 0;
  const results = parsed.valid ? [...parsed.cases] : [];
  if (!parsed.valid) results.push({ name: outputFailureId, status: "failed", detail: "invalid_suite_output" });
  if ((processError !== null || processExitCode !== 0 || processSignal !== null) &&
    !results.some((item) => item.name === processFailureId)) {
    results.push({
      name: processFailureId,
      status: "failed",
      detail: processError ?? (processSignal !== null ? "child_signaled" : "child_exit_nonzero_or_unknown")
    });
  }
  if (stderrPresent) results.push({ name: stderrFailureId, status: "failed", detail: "stderr_present" });
  if (parsed.valid && parsed.cases.some((item) => item.status === "failed") && processExitCode === 0 &&
    processError === null && processSignal === null) {
    results.push({ name: processFailureId, status: "failed", detail: "suite_failed_exit_success" });
  }
  const passed = results.filter((item) => item.status === "passed").length;
  const failed = results.length - passed;
  const report = {
    schemaVersion: reportSchema,
    suite: "package",
    mode: "simulated",
    status: failed === 0 && processError === null && processExitCode === 0 && processSignal === null && !stderrPresent
      ? "passed" : "failed",
    passed,
    failed,
    results,
    processExitCode,
    processSignal,
    processError,
    stderrPresent,
    externalProviderCalls: 0,
    orderCalls: 0,
    financeCalls: 0,
    sandboxReady: false,
    liveEnabled: false,
    releaseReady: false,
    skipped: 0
  };
  return validPackageRunnerReport(report)
    ? report
    : {
      ...report,
      status: "failed",
      results: [{ name: outputFailureId, status: "failed", detail: "runner_report_invalid" }],
      passed: 0,
      failed: 1
    };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = runPackageTests();
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.status !== "passed") {
    process.exitCode = 1;
    if (lastChildStderr !== "") process.stderr.write(`package suite child stderr (first 8192 characters):\n${lastChildStderr.slice(0, 8192).replace(/[^\x09\x0a\x20-\x7e]/gu, "?")}\n`);
  }
}
