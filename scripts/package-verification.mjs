// SIMULATED ONLY. Helpers for `./scripts/verify-fulfillment --suite package --mode simulated --evidence-dir evidence/FC-08`.
// They are importable (and unit-tested by the package suite) so the verifier's evidence rules and report shape cannot drift
// from what the tests assert. Nothing here contacts a provider, an issuer or Finance, and nothing here issues authority.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const PACKAGE_EVIDENCE_DIR = "evidence/FC-08";
export const PACKAGE_ASSESSMENT_SCHEMA = "fulfillment-package-assessment/1";

export const PACKAGE_BLOCKERS = Object.freeze([
  "this result covers owner byte integrity and local observation of a synthetic, unaccepted print-production corpus; the best achievable verdict is integrity_passed_blocked with eligibility blocked",
  "owner @jevelopers/shared-contracts 0.9.7 is an unaccepted development candidate and its eligibility result is intentionally unreachable; no approval, acceptance or pin is minted or forged here",
  "genuine issuer approval for the exact preview, PrintSpec and capability bytes, accepted pins, a row scope, a second spec revision and an independent host publication record do not exist and stay critical-blocked",
  "artifact access/expiry, rights/terms, destination resolution and provider quantity limits have no owner representation and stay critical-unsupported; PDF and SVG geometry is declared by the manifest and not observed",
  "provider-fetched-bytes immutability needs a host store/access contract that does not exist; the abort-signal memory bound assumes the host honours the signal",
  "this is not a complete approved-package validator, not consumer conformance, and not acceptance of issue 10; every non-simulated submit is refused before any port is touched"
]);

/** The verifier accepts exactly this directory, resolved against the repository root, and refuses symlinked parents. */
export function packageEvidenceDirAllowed(repositoryRoot, requested) {
  if (typeof requested !== "string" || requested.length === 0) return false;
  return resolve(repositoryRoot, requested) === resolve(repositoryRoot, PACKAGE_EVIDENCE_DIR);
}

/** `git rev-parse HEAD` with a minimal environment; null when unavailable. */
export function sourceRevision(repositoryRoot, run = execFileSync) {
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  try {
    const sha = String(run("git", ["-C", repositoryRoot, "rev-parse", "HEAD"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })).trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) return { sha: null, dirty: null };
    let dirty = null;
    try { dirty = String(run("git", ["-C", repositoryRoot, "status", "--porcelain"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })).trim().length > 0; } catch { dirty = null; }
    return { sha, dirty };
  } catch {
    return { sha: null, dirty: null };
  }
}

/** Runs the real gate over the committed baseline fixtures with fixture host ports and the real clock. */
export async function buildPackageBundleReport({ repositoryRoot, revision }) {
  const fixtures = await import(pathToFileURL(resolve(repositoryRoot, "tests/production-bundle-fixtures.mjs")).href);
  const world = fixtures.createWorld();
  fixtures.publishFromBaseline(world);
  const gate = fixtures.createGate(world, { clock: { now: () => Date.now() }, consumerRevision: revision });
  return gate.checkBeforeSubmit(fixtures.gateRequest());
}

const exact = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");

const ASSESSMENT_KEYS = ["schemaVersion", "evidenceScope", "completion", "validator", "sourceRevision", "evaluatedAt", "ownerPin", "anchor", "bundle", "specRef",
  "criteria", "openCriticalCodes", "inputDigests", "outputDigests", "unchanged", "setDigest", "reportDigest", "verdict", "eligibility", "authorityIssued", "accepted",
  "handoffEligible", "bundleReport", "localFixtureResult", "localFixtureCounts", "sandboxReady", "liveEnabled", "releaseReady", "externalProviderCalls", "orderCalls",
  "financeCalls", "runner", "blockers", "evidenceWriteStatus"];

export function buildPackageAssessment({ runnerReport, bundleReport, revision, status, checks }) {
  return {
    schemaVersion: PACKAGE_ASSESSMENT_SCHEMA,
    evidenceScope: "owner_byte_verification_and_local_observation_of_synthetic_corpus_with_fail_closed_runtime_gate",
    completion: "partial_owner_byte_integrity_only_critical_criteria_blocked_or_unsupported",
    validator: { name: "fulfillment-production-bundle-validator", version: bundleReport?.consumer?.validatorVersion ?? null },
    sourceRevision: { sha: revision?.sha ?? null, dirty: revision?.dirty ?? null },
    evaluatedAt: bundleReport?.evaluatedAt ?? null,
    ownerPin: bundleReport?.owner ?? null,
    anchor: bundleReport?.anchor ?? null,
    bundle: bundleReport?.bundle ?? null,
    specRef: bundleReport?.specRef ?? null,
    criteria: bundleReport?.criteria ?? [],
    openCriticalCodes: bundleReport?.openCriticalCodes ?? [],
    inputDigests: bundleReport?.inputDigests ?? {},
    outputDigests: bundleReport?.outputDigests ?? {},
    unchanged: bundleReport?.unchanged ?? false,
    setDigest: bundleReport?.setDigest ?? null,
    reportDigest: bundleReport?.reportDigest ?? null,
    verdict: bundleReport?.verdict ?? "integrity_failed",
    eligibility: "blocked",
    authorityIssued: false,
    accepted: false,
    handoffEligible: false,
    bundleReport: bundleReport ?? null,
    localFixtureResult: status === "passed" ? "passed" : checks.length === 0 ? "not_run" : "failed",
    localFixtureCounts: { total: checks.length, passed: checks.filter((check) => check.status === "passed").length, failed: checks.filter((check) => check.status !== "passed").length },
    sandboxReady: false,
    liveEnabled: false,
    releaseReady: false,
    externalProviderCalls: runnerReport?.externalProviderCalls ?? 0,
    orderCalls: runnerReport?.orderCalls ?? 0,
    financeCalls: runnerReport?.financeCalls ?? 0,
    runner: runnerReport ?? null,
    blockers: PACKAGE_BLOCKERS,
    evidenceWriteStatus: "not_attempted"
  };
}

/** Structural validity of an assessment: exact keys and the literals that must never change. */
export function validPackageAssessment(assessment) {
  if (!exact(assessment, ASSESSMENT_KEYS) || assessment.schemaVersion !== PACKAGE_ASSESSMENT_SCHEMA) return false;
  if (assessment.eligibility !== "blocked" || assessment.authorityIssued !== false || assessment.accepted !== false || assessment.handoffEligible !== false) return false;
  if (assessment.sandboxReady !== false || assessment.liveEnabled !== false || assessment.releaseReady !== false) return false;
  if (assessment.externalProviderCalls !== 0 || assessment.orderCalls !== 0 || assessment.financeCalls !== 0) return false;
  if (!exact(assessment.validator, ["name", "version"]) || assessment.validator.name !== "fulfillment-production-bundle-validator" || typeof assessment.validator.version !== "string") return false;
  if (!exact(assessment.sourceRevision, ["sha", "dirty"])) return false;
  if (typeof assessment.evaluatedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(assessment.evaluatedAt)) return false;
  if (assessment.ownerPin === null || assessment.ownerPin.accepted !== false || assessment.ownerPin.version !== "0.9.7") return false;
  if (assessment.bundle === null || assessment.anchor === null || assessment.anchor.provenance?.kind !== "development_fixture") return false;
  if (assessment.specRef === null || !Array.isArray(assessment.criteria) || assessment.criteria.length === 0 || !Array.isArray(assessment.openCriticalCodes)) return false;
  if (typeof assessment.setDigest !== "string" || typeof assessment.reportDigest !== "string") return false;
  if (assessment.bundleReport === null || assessment.bundleReport.reportDigest !== assessment.reportDigest) return false;
  return true;
}
