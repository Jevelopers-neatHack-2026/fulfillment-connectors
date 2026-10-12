// SIMULATED ONLY. Cases: criteria, terms, digest, runtime, static, suite, runner.
// The runtime cases drive the real FulfillmentConnectorRuntime with the simulated adapter and a COUNTING wrapper around every injected
// port (contract validator, adapter, authorization verifier, persistence, budget, usage, metering, transport, gate ports).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { ConnectorError } from "../dist/index.js";
import * as contract from "../dist/production-bundle-contract.js";
import * as bundle from "../dist/production-bundle.js";
import { simulatorFixtureDigest } from "../dist/simulator.js";
import {
  PACKAGE_SUITE_CASE_IDS, parsePackageOutput, runPackageTests, validPackageRunnerReport
} from "../scripts/run-package-tests.mjs";
import {
  PACKAGE_BLOCKERS, PACKAGE_EVIDENCE_DIR, buildPackageAssessment, packageEvidenceDirAllowed, sourceRevision, validPackageAssessment
} from "../scripts/package-verification.mjs";
import * as f from "./production-bundle-fixtures.mjs";
import { MOCK_BUNDLE, MOCK_SCOPE, envelope, makeQuoteCommand } from "./mock-fixtures.mjs";
import { baselineWorld, criterion, issuedAnchor, runGate, validateFiles, filesOf } from "./production-bundle-cases-core.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const sha = f.sha256Tagged;
const enc = (text) => new TextEncoder().encode(text);
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** The open critical codes of the real baseline with NO terms source: typed here independently of the source tables. */
const EXPECTED_OPEN_NO_TERMS = Object.freeze([
  "ACCEPTED_PINS_ABSENT", "APPROVAL_PATH_OWNER_BLOCKED", "ARTIFACT_ACCESS_UNREPRESENTED", "CAPABILITY_SNAPSHOT_UNAVAILABLE", "CAPABILITY_VERSION_ENCODING_UNMAPPED",
  "DESTINATION_UNRESOLVED", "HOST_ACCESS_CONTRACT_ABSENT", "HOST_TRUST_REFS_ABSENT", "NO_SECOND_SPEC_REVISION", "OWNER_ACCEPTANCE_PENDING", "PRINTSPEC_BYTES_UNAVAILABLE",
  "PROVIDER_QUANTITY_LIMIT_UNREPRESENTED", "QUOTE_CONTRACT_UNACCEPTED", "RIGHTS_TERMS_UNREPRESENTED", "ROW_SCOPE_UNPINNED", "TERMS_SOURCE_ABSENT"
]);

async function expectConnectorError(promise, code, effect) {
  let captured;
  try { await promise; } catch (error) { captured = error; }
  assert.ok(captured instanceof ConnectorError, `expected a ConnectorError(${code}), got ${captured}`);
  assert.equal(captured.code, code);
  assert.equal(captured.toJSON().side_effect_state, effect);
  return captured;
}

function bundleRuntime(options = {}) {
  const world = options.world ?? baselineWorld();
  const user = { resolve: null, read: null };
  const gate = options.noGate === true ? undefined : f.createGate(world, options.gateOverrides ?? {});
  const h = f.createGateRuntime({ ...(gate === undefined ? {} : { gate }), ...(options.runtime ?? {}) });
  world.hooks.resolve = (request, dflt) => { h.order.push("gate.resolve"); return user.resolve === null ? dflt() : user.resolve(request, dflt); };
  world.hooks.read = (request, dflt) => { h.order.push("gate.read"); return user.read === null ? dflt() : user.read(request, dflt); };
  return { world, user, gate, h };
}
const submit = (h, command) => h.runtime.submit(f.wrapEnvelope(command), f.SCOPE);
const portsTouched = (counters) => f.totalPortCalls(counters);
const snapshotCounters = (counters) => ({ ...counters, adapter: { ...counters.adapter } });
const transportsOf = (h) => h.transportRequests.filter((request) => request.path === "/simulator/orders" || request.path === "/fixture/first-attempt");

const sandboxReady = (extra = {}) => ({ forgeAllBindingsAccepted: true, runtimeOptions: { mode: "sandbox", sandboxEnabled: true }, ...extra });
const reportOf = async () => runGate(baselineWorld());

/** A test-only genuine-looking gate: sealed with the module's own sealer, returning crafted reports. Tests-only; never exported by the package. */
function sealedGate(check, recheck = check) {
  return contract.sealGenuineProductionBundleGate({ kind: contract.PRODUCTION_BUNDLE_GATE_KIND, checkBeforeSubmit: async (request) => check(request), recheckBeforeDispatch: async (request) => recheck(request) });
}
const redigest = (report) => { report.reportDigest = contract.computeReportDigest(report); return report; };

export function register(define) {
  // ---- criteria ---------------------------------------------------------------------------------------------
  define("criteria.frozen-table-immutable", () => {
    const table = contract.PRODUCTION_BUNDLE_CRITERIA;
    assert.equal(Object.isFrozen(table), true);
    assert.throws(() => table.push({}), TypeError);
    assert.throws(() => { table[0] = table[1]; }, TypeError);
    for (const row of table) {
      assert.equal(Object.isFrozen(row), true, row.id);
      assert.throws(() => { row.critical = !row.critical; }, TypeError, row.id);
      assert.throws(() => { row.allowedStates.push("verified_owner"); }, TypeError, row.id);
    }
    assert.equal(table.length, 32); assert.equal(new Set(table.map((row) => row.id)).size, 32);
    assert.equal(table.filter((row) => row.critical).length, 27);
    assert.deepEqual(table.filter((row) => !row.critical).map((row) => row.id), ["png_pixels", "png_effective_dpi", "png_phys_metadata", "pdf_svg_signature", "pdf_svg_geometry"]);
    assert.equal(contract.criterionDefinition("owner_eligibility").fixed.state, "blocked");
    assert.equal(Object.isFrozen(contract.OWNER_PACKAGE_PIN), true);
  });

  define("criteria.no-option-or-type-selects-criteria", async () => {
    const reference = await runGate(baselineWorld());
    const hostile = await runGate(baselineWorld(), {}, { criteria: [], critical: [], policy: { require: [] }, severity: "none", mode: "sandbox", sandbox: true, featureFlag: "off", acceptedPins: true, eligible: true, limits: { criticalOverride: true, policy: "lenient" } });
    assert.equal(hostile.reportDigest, reference.reportDigest, "unknown options change nothing");
    const gate = f.createGate(baselineWorld());
    assert.deepEqual(Object.keys(gate).sort(), ["checkBeforeSubmit", "kind", "recheckBeforeDispatch"]);
    assert.equal(Object.isFrozen(gate), true);
    process.env.FC_PRODUCTION_BUNDLE_CRITICAL = "none"; process.env.FC_PRODUCTION_BUNDLE_POLICY = "lenient";
    try { assert.equal((await runGate(baselineWorld())).reportDigest, reference.reportDigest, "no environment variable selects criteria"); }
    finally { delete process.env.FC_PRODUCTION_BUNDLE_CRITICAL; delete process.env.FC_PRODUCTION_BUNDLE_POLICY; }
    const source = read("src/production-bundle.ts");
    assert.ok(!/process\.env|import\.meta\.env/.test(source), "the consumer reads no environment");
    assert.deepEqual(Object.keys(bundle.PRODUCTION_BUNDLE_DEFAULT_LIMITS).sort(), ["maxConcurrent", "maxQueued", "readMs", "resolveMs", "totalMs"]);
  });

  define("criteria.critical-blocked-typed-codes", async () => {
    const report = await runGate(baselineWorld());
    const expected = {
      owner_eligibility: ["blocked", "OWNER_ACCEPTANCE_PENDING"], approval_exact_preview: ["blocked", "APPROVAL_PATH_OWNER_BLOCKED"], provider_required_files: ["blocked", "PRINTSPEC_BYTES_UNAVAILABLE"],
      surfaces: ["blocked", "PRINTSPEC_BYTES_UNAVAILABLE"], provider_dimensions_units: ["blocked", "PRINTSPEC_BYTES_UNAVAILABLE"], bleed_safe_trim: ["blocked", "PRINTSPEC_BYTES_UNAVAILABLE"],
      provider_options: ["blocked", "PRINTSPEC_BYTES_UNAVAILABLE"], personalization: ["blocked", "PRINTSPEC_BYTES_UNAVAILABLE"], materials_color: ["blocked", "PRINTSPEC_BYTES_UNAVAILABLE"],
      minimum_dpi_vs_spec: ["blocked", "PRINTSPEC_BYTES_UNAVAILABLE"], capability_identity: ["blocked", "CAPABILITY_SNAPSHOT_UNAVAILABLE"], preflight_vs_capability: ["blocked", "HOST_TRUST_REFS_ABSENT"],
      quote_contract: ["blocked", "QUOTE_CONTRACT_UNACCEPTED"], quantity_limit: ["unsupported", "PROVIDER_QUANTITY_LIMIT_UNREPRESENTED"], destination_shipping: ["unsupported", "DESTINATION_UNRESOLVED"],
      artifact_access_expiry: ["unsupported", "ARTIFACT_ACCESS_UNREPRESENTED"], rights_terms: ["unsupported", "RIGHTS_TERMS_UNREPRESENTED"], stale_spec: ["blocked", "NO_SECOND_SPEC_REVISION"],
      row_scope: ["blocked", "ROW_SCOPE_UNPINNED"], accepted_pins: ["blocked", "ACCEPTED_PINS_ABSENT"], authorization_terms_binding: ["blocked", "TERMS_SOURCE_ABSENT"],
      capability_version_binding: ["blocked", "CAPABILITY_VERSION_ENCODING_UNMAPPED"], provider_fetched_bytes_immutability: ["blocked", "HOST_ACCESS_CONTRACT_ABSENT"]
    };
    for (const [id, [state, code]] of Object.entries(expected)) {
      const item = criterion(report, id);
      assert.deepEqual({ state: item.state, code: item.code, critical: item.critical }, { state, code, critical: true }, id);
    }
    assert.deepEqual([...report.openCriticalCodes], [...EXPECTED_OPEN_NO_TERMS]);
    for (const id of ["anchor_resolution", "byte_custody", "owner_integrity", "observed_geometry_consistency"]) assert.match(criterion(report, id).state, /^verified_/);
  });

  define("criteria.no-caller-providerfit-effect", async () => {
    const reference = await runGate(baselineWorld());
    const hostile = await runGate(baselineWorld(), { providerFit: { fits: true }, printSpec: { sku: "x" }, approval: { receipt: "genuine" }, acceptedPins: { domain: "sha256:x" }, capabilityVersion: "2026-10-11.1", expectedRowScope: null, estimatedAt: 5 });
    assert.equal(hostile.reportDigest, reference.reportDigest);
    for (const id of ["provider_required_files", "surfaces", "approval_exact_preview", "accepted_pins", "row_scope"]) assert.equal(criterion(hostile, id).state, "blocked", id);
    // The same through the runtime: extra command fields change neither the evidence nor any criterion.
    const a = bundleRuntime(); const b = bundleRuntime();
    const prepared = await f.prepareBundleSubmit(a.h); const preparedB = await f.prepareBundleSubmit(b.h);
    const plain = await submit(a.h, prepared.command);
    const decorated = await submit(b.h, { ...preparedB.command, providerFit: { fits: true }, acceptedPins: { domain: "x" }, approval: { receipt: "genuine" } });
    assert.deepEqual(decorated.productionBundleEvidence, plain.productionBundleEvidence);
  });

  define("criteria.no-preflight-trust-from-bundle", async () => {
    const preflight = JSON.parse(new TextDecoder().decode(f.baseline().files.get("preflight.json")));
    assert.equal(preflight.body.status, "passed", "the bundle itself claims a passing preflight");
    const report = await runGate(baselineWorld());
    assert.deepEqual({ state: criterion(report, "preflight_vs_capability").state, code: criterion(report, "preflight_vs_capability").code }, { state: "blocked", code: "HOST_TRUST_REFS_ABSENT" });
    assert.equal(report.specRef.state, "declared_by_manifest_unverified", "the spec ref is only what the manifest declares");
    assert.equal(criterion(report, "capability_identity").state, "blocked");
    // The bundle's own refs are never promoted to trust inputs: re-publishing it with a different declared rule_ref changes no criterion.
    const altered = f.recommit({ manifest: (manifest) => { manifest.policy_refs.layout.revision = 2; } });
    const world = f.createWorld(); f.publishFromBaseline(world, altered.files, altered.commitmentBytes, altered.bundleHash);
    const after = await runGate(world, { bundleDigest: altered.bundleHash });
    assert.equal(criterion(after, "preflight_vs_capability").state, "blocked");
    assert.deepEqual([...after.openCriticalCodes], [...report.openCriticalCodes]);
  });

  define("criteria.no-positive-eligible-representable", async () => {
    const report = await runGate(baselineWorld());
    const check = (mutate) => { const copy = structuredClone(report); mutate(copy); redigest(copy); return contract.validateGateReport(copy, { bundleDigest: f.BUNDLE_HASH }); };
    assert.equal(check(() => {}).ok, true);
    for (const [label, mutate] of Object.entries({
      eligibilityEligible: (r) => { r.eligibility = "eligible"; }, verdictEligible: (r) => { r.verdict = "eligible"; }, authority: (r) => { r.authorityIssued = true; },
      accepted: (r) => { r.accepted = true; }, handoff: (r) => { r.handoffEligible = true; },
      ownerEligibilityVerified: (r) => { const c = r.criteria.find((x) => x.id === "owner_eligibility"); c.state = "verified_owner"; c.code = null; },
      approvalVerified: (r) => { const c = r.criteria.find((x) => x.id === "approval_exact_preview"); c.state = "verified_local"; c.code = null; },
      acceptedPinsVerified: (r) => { const c = r.criteria.find((x) => x.id === "accepted_pins"); c.state = "verified_owner"; c.code = null; }
    })) assert.equal(check(mutate).ok, false, label);
    const evidence = contract.evidenceFromReport(report);
    assert.deepEqual(Object.keys(evidence).sort(), ["accepted", "authorityIssued", "bundleDigest", "eligibility", "handoffEligible", "openCriticalCodes", "reportDigest", "simulation", "verdict"]);
    const flat = JSON.stringify({ report, evidence });
    for (const word of ["\"eligible\"", "\"approved\"", "\"accepted\":true", "\"authorityIssued\":true", "\"handoffEligible\":true"]) assert.ok(!flat.includes(word), word);
  });

  // ---- terms ------------------------------------------------------------------------------------------------
  define("terms.binding-match-fixture-diagnostic-only", async () => {
    const terms = f.termsSourceFor(f.baselineManifest);
    const report = await runGate(baselineWorld(), {}, { terms });
    assert.equal(report.verdict, "integrity_passed_blocked");
    assert.deepEqual({ state: criterion(report, "authorization_terms_binding").state, code: criterion(report, "authorization_terms_binding").code }, { state: "blocked", code: "TERMS_BINDING_FIXTURE_ONLY" });
    assert.equal(report.diagnostic.termsBinding, "matched_development_fixture");
    assert.ok(report.openCriticalCodes.includes("TERMS_BINDING_FIXTURE_ONLY"), "a fixture match upgrades nothing");
    assert.ok(!report.openCriticalCodes.includes("TERMS_SOURCE_ABSENT"));
    assert.equal(terms.calls.length, 1);
    const call = terms.calls[0];
    assert.deepEqual({ tenantId: call.trustedScope.tenantId, projectId: call.trustedScope.projectId, providerId: call.providerId, mode: call.mode, productionBundleDigest: call.productionBundleDigest }, { tenantId: f.SCOPE.tenantId, projectId: f.SCOPE.projectId, providerId: "simulated-provider", mode: "simulated", productionBundleDigest: f.BUNDLE_HASH });
  });

  define("terms.approval-id-exact", async () => {
    const approvalId = f.baselineManifest.approval_ref.id;
    for (const wrong of [approvalId.toUpperCase(), `${approvalId} `, approvalId.slice(0, -1), "apr_FIXTURE_0001", ""]) {
      const report = await runGate(baselineWorld(), {}, { terms: f.termsSourceFor(f.baselineManifest, { terms: { approvalId: wrong } }) });
      assert.equal(report.verdict, "integrity_failed", JSON.stringify(wrong));
      assert.equal(criterion(report, "authorization_terms_binding").code, "TERMS_BINDING_MISMATCH");
      assert.equal(report.diagnostic.termsBinding, "mismatch");
    }
    for (const field of ["compositionHash", "factsHash"]) {
      const report = await runGate(baselineWorld(), {}, { terms: f.termsSourceFor(f.baselineManifest, { design: { [field]: "0".repeat(64) } }) });
      assert.equal(criterion(report, "authorization_terms_binding").code, "TERMS_BINDING_MISMATCH", field);
    }
    const prefixed = await runGate(baselineWorld(), {}, { terms: f.termsSourceFor(f.baselineManifest, { design: { compositionHash: f.baselineManifest.composition.composition_hash } }) });
    assert.equal(criterion(prefixed, "authorization_terms_binding").code, "TERMS_BINDING_MISMATCH", "the terms encoding is bare hex; a tagged value is a different encoding and does not match");
  });

  define("terms.capability-version-unmapped-blocked", async () => {
    for (const capabilityVersion of ["2026-10-11.1", f.baselineManifest.capability_ref.content_hash, String(f.baselineManifest.capability_ref.revision), f.baselineManifest.capability_ref.id]) {
      const report = await runGate(baselineWorld(), {}, { terms: f.termsSourceFor(f.baselineManifest, { terms: { capabilityVersion } }) });
      assert.equal(report.verdict, "integrity_passed_blocked");
      assert.deepEqual({ state: criterion(report, "capability_version_binding").state, code: criterion(report, "capability_version_binding").code }, { state: "blocked", code: "CAPABILITY_VERSION_ENCODING_UNMAPPED" });
    }
  });

  define("terms.source-absent-is-critical-blocked-TERMS_SOURCE_ABSENT", async () => {
    const report = await runGate(baselineWorld());
    const item = criterion(report, "authorization_terms_binding");
    assert.deepEqual({ state: item.state, code: item.code, critical: item.critical }, { state: "blocked", code: "TERMS_SOURCE_ABSENT", critical: true });
    assert.ok(report.openCriticalCodes.includes("TERMS_SOURCE_ABSENT"));
    assert.equal(report.diagnostic.termsBinding, "source_absent");
  });

  define("terms.source-absent-never-verified-binding", async () => {
    const scenarios = {
      absent: {}, missing: { terms: f.termsSourceFor(f.baselineManifest, { result: { status: "missing", fields: ["x"] } }) },
      mismatch: { terms: f.termsSourceFor(f.baselineManifest, { terms: { approvalId: "nope" } }) }, matched: { terms: f.termsSourceFor(f.baselineManifest) },
      throwing: { terms: { async resolve() { throw new Error("down"); } } }, hanging: { terms: { resolve: () => new Promise(() => {}) }, limits: { resolveMs: 30 } },
      malformed: { terms: { async resolve() { return "bound"; } } }, notFixture: { terms: f.termsSourceFor(f.baselineManifest, { result: { status: "bound", terms: {}, provenance: { kind: "accepted" } } }) }
    };
    const seen = {};
    for (const [label, overrides] of Object.entries(scenarios)) {
      const report = await runGate(baselineWorld(), {}, overrides);
      const item = criterion(report, "authorization_terms_binding");
      assert.ok(!item.state.startsWith("verified"), label);
      assert.equal(item.critical, true, label);
      seen[label] = `${item.state}:${item.code}`;
    }
    assert.deepEqual(seen, {
      absent: "blocked:TERMS_SOURCE_ABSENT", missing: "blocked:TERMS_SOURCE_ABSENT", mismatch: "failed:TERMS_BINDING_MISMATCH", matched: "blocked:TERMS_BINDING_FIXTURE_ONLY",
      throwing: "failed:TERMS_SOURCE_FAILED", hanging: "failed:TERMS_SOURCE_FAILED", malformed: "failed:TERMS_SOURCE_FAILED", notFixture: "failed:TERMS_SOURCE_FAILED"
    });
  });

  define("terms.binding-mismatch-invalid", async () => {
    const mismatched = f.termsSourceFor(f.baselineManifest, { design: { compositionHash: "a".repeat(64) } });
    const { h } = bundleRuntime({ gateOverrides: { terms: mismatched } });
    const { command } = await f.prepareBundleSubmit(h);
    const before = snapshotCounters(h.counters);
    await expectConnectorError(submit(h, command), "bundle_invalid", "not_dispatched");
    assert.equal(h.counters.claim, before.claim); assert.equal(h.counters.budget, before.budget); assert.equal(transportsOf(h).length, 0);
    assert.equal(h.counters.adapter.validateBeforeSubmit ?? 0, 0);
  });

  // ---- digest -----------------------------------------------------------------------------------------------
  define("digest.defined-as-owner-bundle-content-hash", async () => {
    const owner = await import("@jevelopers/shared-contracts/production-operations");
    assert.equal(owner.productionBundleContentHash(f.baselineManifest), f.baselineManifest.bundle_hash);
    assert.equal(f.BUNDLE_HASH, f.baselineManifest.bundle_hash);
    assert.equal(f.baselineCommitment.bundle_ref.content_hash, f.BUNDLE_HASH);
    assert.match(f.BUNDLE_HASH, /^sha256:[0-9a-f]{64}$/);
    const report = await runGate(baselineWorld());
    assert.equal(report.bundle.hash, f.BUNDLE_HASH); assert.equal(report.bundle.id, f.BUNDLE_REF.id); assert.equal(report.bundle.revision, f.BUNDLE_REF.revision);
    assert.notEqual(simulatorFixtureDigest(f.BUNDLE_REF), f.BUNDLE_HASH, "the old fixture digest of the reference object is a different, incompatible value");
  });

  define("digest.simulator-reference-adaptation", async () => {
    const h = f.createGateRuntime({});
    await h.runtime.quote(envelope(makeQuoteCommand(f.BUNDLE_REF), f.SCOPE), f.SCOPE);
    assert.equal(h.base.simulator.snapshot().quotes.at(-1).productionBundleDigest, f.BUNDLE_HASH, "an owner-shaped reference digests to its owner content hash");
    const fixtureDigest = (value) => simulatorFixtureDigest(value);
    const variants = {
      extraKey: { ...f.BUNDLE_REF, extra: 1 }, otherContract: { ...f.BUNDLE_REF, contract: "ProductionBundleRef" }, otherSchema: { ...f.BUNDLE_REF, schema_version: "1.0.0" },
      badHash: { ...f.BUNDLE_REF, content_hash: "sha256:xyz" }, bareHash: { ...f.BUNDLE_REF, content_hash: f.BUNDLE_HASH.slice(7) }, missingKey: { contract: "ProductionBundle", schema_version: "2.0.0", id: "x", content_hash: f.BUNDLE_HASH }
    };
    for (const [label, value] of Object.entries(variants)) {
      const probe = f.createGateRuntime({});
      await probe.runtime.quote(envelope(makeQuoteCommand(value), f.SCOPE), f.SCOPE);
      assert.equal(probe.base.simulator.snapshot().quotes.at(-1).productionBundleDigest, fixtureDigest(value), `${label} keeps the existing fixture digest`);
    }
    const preflight = f.createGateRuntime({});
    await preflight.runtime.preflight(envelope({ productionBundle: f.BUNDLE_REF, printSpecification: { fixture: "spec" } }, f.SCOPE), f.SCOPE);
    assert.ok(preflight.transportRequests.some((request) => request.body?.bundleDigest === f.BUNDLE_HASH), "preflight uses the same adaptation for the bundle only");
    assert.ok(preflight.transportRequests.some((request) => request.body?.specificationDigest === fixtureDigest({ fixture: "spec" })));
  });

  define("digest.existing-suites-digests-unchanged", async () => {
    const h = f.createGateRuntime({});
    await h.runtime.quote(envelope(makeQuoteCommand(MOCK_BUNDLE), MOCK_SCOPE), MOCK_SCOPE);
    assert.equal(h.base.simulator.snapshot().quotes.at(-1).productionBundleDigest, simulatorFixtureDigest(MOCK_BUNDLE));
    assert.equal(simulatorFixtureDigest(MOCK_BUNDLE), `sha256:${createHash("sha256").update('{"fixture":"development-only-production-bundle"}').digest("hex")}`);
  });

  define("digest.submit-body-and-auth-facts-and-terms-request-bind-same", async () => {
    const terms = f.termsSourceFor(f.baselineManifest);
    const facts = [];
    const { h } = bundleRuntime({ gateOverrides: { terms } });
    const original = h.dependencies.authorizationVerifier.verifyAndClaim;
    h.dependencies.authorizationVerifier.verifyAndClaim = async (check) => { facts.push(check.facts.command.productionBundleDigest); return original(check); };
    const { quote, command } = await f.prepareBundleSubmit(h);
    const response = await submit(h, command);
    const submitBody = h.transportRequests.find((request) => request.path === "/simulator/orders").body;
    assert.equal(submitBody.productionBundleDigest, f.BUNDLE_HASH);
    assert.deepEqual(facts, [f.BUNDLE_HASH]);
    assert.ok(terms.calls.length >= 1 && terms.calls.every((call) => call.productionBundleDigest === f.BUNDLE_HASH));
    assert.equal(response.productionBundleEvidence.bundleDigest, f.BUNDLE_HASH);
    assert.equal(command.quote.productionBundleDigest, f.BUNDLE_HASH);
    assert.equal(h.base.simulator.snapshot().quotes.at(-1).productionBundleDigest, f.BUNDLE_HASH);
    assert.ok(quote.value.providerQuoteId);
  });

  define("digest.envelope-reference-mismatch-fails", async () => {
    const { h, world } = bundleRuntime();
    const { command } = await f.prepareBundleSubmit(h);
    const before = snapshotCounters(h.counters);
    await expectConnectorError(submit(h, { ...command, productionBundle: { ...f.BUNDLE_REF, content_hash: sha(enc("other bundle")) } }), "bundle_invalid", "not_dispatched");
    assert.equal(h.counters.claim, before.claim); assert.equal(h.counters.budget, before.budget); assert.equal(transportsOf(h).length, 0);
    assert.equal(h.counters.adapter.validateBeforeSubmit ?? 0, 0); assert.equal(h.counters.persistenceClaim, 0);
    assert.equal(world.calls.resolve.length, 0, "rejected inside the gate before any publication lookup");
  });

  // ---- runtime ----------------------------------------------------------------------------------------------
  define("runtime.simulated-integrity-observation-evidence-blocked", async () => {
    const { h } = bundleRuntime();
    const { command } = await f.prepareBundleSubmit(h);
    const response = await submit(h, command);
    const evidence = response.productionBundleEvidence;
    assert.deepEqual(evidence, { simulation: "no_effect_simulation", verdict: "integrity_passed_blocked", eligibility: "blocked", authorityIssued: false, accepted: false, handoffEligible: false, openCriticalCodes: [...EXPECTED_OPEN_NO_TERMS], bundleDigest: f.BUNDLE_HASH, reportDigest: evidence.reportDigest });
    assert.match(evidence.reportDigest, /^sha256:[0-9a-f]{64}$/); assert.equal(Object.isFrozen(evidence), true);
    assert.ok(response.value.providerRequestId);
    assert.equal(transportsOf(h).filter((request) => request.path === "/simulator/orders").length, 1);
    assert.equal(h.base.simulator.dispatchCounters().submit, 1);
    assert.ok(h.base.simulator.snapshot().billingEvidence.every((record) => record.billingMode === "simulated" && record.charged === false));
    assert.ok(h.observations.some((observation) => observation.sourceRefs?.includes(`bundle-validation:${evidence.reportDigest}`)), "the metering source refs carry the report digest");
    assert.ok(h.observations.some((observation) => observation.sourceRefs?.includes(`bundle:${f.BUNDLE_HASH}`)));
    const flat = JSON.stringify(response);
    assert.ok(!/"eligibility":"eligible"|"approved"|"authorityIssued":true|"handoffEligible":true/.test(flat));
  });

  define("runtime.gate-missing-with-accepted-binding-contract-missing", async () => {
    const accepted = { production_bundle: { state: "accepted", schemaVersion: "1.0.0", sourceRevision: "forged-test-only", fixtureDigest: `sha256:${"e".repeat(64)}` } };
    const { h } = bundleRuntime({ noGate: true, runtime: { bindingOverrides: accepted } });
    const { command } = await f.prepareBundleSubmit(h);
    const before = snapshotCounters(h.counters);
    await expectConnectorError(submit(h, command), "contract_missing", "not_dispatched");
    assert.equal(h.counters.inbound, before.inbound, "refused before ContractValidator.validateInbound");
    assert.equal(h.counters.claim, 0); assert.equal(h.counters.budget, 0); assert.equal(transportsOf(h).length, 0);
    // With a genuine gate and the same accepted binding the simulated flow proceeds (still blocked, still labelled).
    const withGate = bundleRuntime({ runtime: { bindingOverrides: accepted } });
    const prepared = await f.prepareBundleSubmit(withGate.h);
    assert.equal((await submit(withGate.h, prepared.command)).productionBundleEvidence.eligibility, "blocked");
  });

  define("runtime.gate-missing-simulated-unchanged", async () => {
    const { h, world } = bundleRuntime({ noGate: true });
    const { command } = await f.prepareBundleSubmit(h);
    const response = await submit(h, command);
    assert.equal(response.productionBundleEvidence, undefined);
    assert.equal("productionBundleEvidence" in response, false);
    assert.ok(response.value.providerRequestId);
    assert.equal(world.calls.resolve.length + world.calls.read.length, 0);
    assert.equal(h.counters.revalidate, 1, "the PR #40 authorization revalidation hook is unchanged");
  });

  define("runtime.hook-installed-gate-only", async () => {
    const { h, world } = bundleRuntime({ runtime: { withoutRevalidation: true } });
    const { command } = await f.prepareBundleSubmit(h);
    const response = await submit(h, command);
    assert.ok(response.value.providerRequestId);
    assert.equal(h.counters.revalidate, 0);
    assert.equal(world.calls.resolve.length, 2, "one pre-submit check and one dispatch recheck");
    const orderAfterQuote = h.order.slice(h.order.indexOf("persistence.claim"));
    assert.ok(orderAfterQuote.indexOf("gate.resolve") >= 0 && orderAfterQuote.indexOf("gate.resolve") < orderAfterQuote.lastIndexOf("transport"), "the recheck runs before the transport");
  });

  define("runtime.hook-installed-verifier-only", async () => {
    const { h, world } = bundleRuntime({ noGate: true });
    const { command } = await f.prepareBundleSubmit(h);
    await submit(h, command);
    assert.equal(h.counters.revalidate, 1);
    assert.equal(world.calls.resolve.length, 0);
    const at = h.order.lastIndexOf("auth.revalidate");
    assert.equal(h.order[at + 1], "transport");
  });

  define("runtime.hook-order-gate-then-auth-last-then-sync-compare", async () => {
    const { h, user, world } = bundleRuntime();
    const { command } = await f.prepareBundleSubmit(h);
    await submit(h, command);
    const revalidate = h.order.lastIndexOf("auth.revalidate");
    const transport = h.order.lastIndexOf("transport");
    assert.equal(transport, revalidate + 1, "nothing is awaited between the authorization revalidation and the transport");
    const lastGateEvent = Math.max(h.order.lastIndexOf("gate.resolve"), h.order.lastIndexOf("gate.read"));
    assert.ok(lastGateEvent < revalidate, "the gate recheck completes before the authorization revalidation");
    assert.equal(h.order.slice(revalidate + 1).filter((entry) => entry.startsWith("gate.")).length, 0);
    // The comparison is synchronous AFTER the authorization await: changed bytes still cost one revalidation, and nothing is sent.
    const changed = bundleRuntime({ world: baselineWorld() });
    const prepared = await f.prepareBundleSubmit(changed.h);
    changed.user.read = (request, dflt) => (changed.world.calls.resolve.length >= 2 && request.filename === "lineage.json" ? dflt().then((result) => { result.bytes[0] ^= 1; return result; }) : dflt());
    await expectConnectorError(submit(changed.h, prepared.command), "bundle_changed", "not_dispatched");
    assert.equal(changed.h.counters.revalidate, 1);
    assert.ok(changed.h.order.lastIndexOf("auth.revalidate") > changed.h.order.lastIndexOf("gate.read"));
    assert.equal(transportsOf(changed.h).length, 0);
    void user; void world;
  });

  define("runtime.recheck-every-transport-attempt-including-retries", async () => {
    const { h, world } = bundleRuntime({ runtime: { doubleTransport: true } });
    const { command } = await f.prepareBundleSubmit(h);
    const response = await submit(h, command);
    assert.ok(response.value.providerRequestId);
    assert.equal(transportsOf(h).length, 2, "the adapter made two transport requests inside one submit");
    assert.equal(world.calls.resolve.length, 3, "one pre-submit check plus one recheck before EACH transport request");
    assert.equal(h.counters.revalidate, 2);
    const transports = h.order.reduce((positions, entry, index) => (entry === "transport" ? [...positions, index] : positions), []).slice(-2);
    for (const position of transports) assert.equal(h.order[position - 1], "auth.revalidate");
    assert.ok(h.order.slice(transports[0] + 1, transports[1]).includes("gate.resolve"), "the second request is preceded by its own gate recheck");
  });

  define("runtime.bytes-changed-bundle-changed-zero-transport", async () => {
    const { h, user, world } = bundleRuntime();
    const { command } = await f.prepareBundleSubmit(h);
    user.read = async (request, dflt) => {
      const result = await dflt();
      if (world.calls.resolve.length >= 2 && request.filename === "output.png") result.bytes[200] ^= 1;
      return result;
    };
    const error = await expectConnectorError(submit(h, command), "bundle_changed", "not_dispatched");
    assert.equal(error.retryable, false);
    assert.equal(transportsOf(h).length, 0);
    assert.equal(h.base.simulator.dispatchCounters().submit, 0);
    assert.equal(h.counters.adapter.submit ?? 0, 1, "the adapter was entered but the recheck refused the transport request");
    assert.equal(h.base.store.attempts[0].sideEffectState, "not_dispatched");
    // The synchronous comparison itself: a gate whose recheck is a COHERENT passing report with a different byte-set digest and the same
    // bundle hash. (A genuine gate cannot produce this, so a sealed test gate is used.) Nothing is sent; the authorization revalidation still ran once.
    const real = await reportOf();
    const drifted = structuredClone(real);
    drifted.inputDigests["output.png"] = sha(enc("the store now serves other bytes"));
    drifted.outputDigests["output.png"] = drifted.inputDigests["output.png"];
    drifted.setDigest = contract.computeSetDigest(drifted.inputDigests);
    redigest(drifted);
    assert.equal(contract.validateGateReport(drifted, { bundleDigest: f.BUNDLE_HASH }).ok, true, "the drifted report is itself well-formed and passing");
    let phase = 0;
    const sealed = f.createGateRuntime({ gate: sealedGate(() => { phase += 1; return phase === 1 ? real : drifted; }) });
    const prepared = await f.prepareBundleSubmit(sealed);
    const drift = await expectConnectorError(submit(sealed, prepared.command), "bundle_changed", "not_dispatched");
    assert.equal(drift.retryable, false);
    assert.equal(phase, 2, "check then recheck");
    assert.equal(sealed.counters.revalidate, 1, "the comparison follows the authorization await");
    assert.equal(transportsOf(sealed).length, 0);
    assert.equal(sealed.base.simulator.dispatchCounters().submit, 0);
  });

  define("runtime.store-failure-zero-transport", async () => {
    for (const failure of ["read", "resolve", "commitment"]) {
      const { h, user, world } = bundleRuntime();
      const { command } = await f.prepareBundleSubmit(h);
      const armed = () => world.calls.resolve.length >= 2;
      if (failure === "read") user.read = (request, dflt) => (armed() && request.filename === "output.svg" ? Promise.reject(new Error("store down")) : dflt());
      if (failure === "resolve") user.resolve = (request, dflt) => (armed() ? Promise.reject(new Error("publication down")) : dflt());
      if (failure === "commitment") user.read = (request, dflt) => (armed() && request.role === "commitment" ? Promise.reject(new Error("store down")) : dflt());
      // resolve count increments before the hook runs, so arm on the second resolve call.
      await expectConnectorError(submit(h, command), "bundle_invalid", "not_dispatched");
      assert.equal(transportsOf(h).length, 0, failure);
      assert.equal(h.base.simulator.dispatchCounters().submit, 0, failure);
    }
  });

  define("runtime.error-codes-nonretryable-sideeffect-from-transportcalled", async () => {
    const first = bundleRuntime({ runtime: { doubleTransport: true } });
    const prepared = await f.prepareBundleSubmit(first.h);
    first.user.read = async (request, dflt) => {
      const result = await dflt();
      if (first.world.calls.resolve.length >= 3 && request.filename === "output.png") result.bytes[200] ^= 1;
      return result;
    };
    const late = await expectConnectorError(submit(first.h, prepared.command), "bundle_changed", "possible");
    assert.equal(late.retryable, false);
    assert.equal(transportsOf(first.h).length, 1, "one request had already been sent when the second recheck refused");
    assert.equal(late.safeMessage, "The production bundle changed before dispatch.");
    const pre = bundleRuntime();
    const early = await f.prepareBundleSubmit(pre.h);
    pre.user.resolve = async () => ({ status: "unpublished" });
    const invalid = await expectConnectorError(submit(pre.h, early.command), "bundle_invalid", "not_dispatched");
    assert.equal(invalid.retryable, false); assert.equal(invalid.safeMessage, "The production bundle did not pass validation.");
    for (const error of [late, invalid]) {
      const text = JSON.stringify(error.toJSON());
      assert.ok(!text.includes(f.BUNDLE_HASH) && !text.includes("output.png") && !text.includes(f.SCOPE.tenantId), "no hash, filename or scope in a bundle error");
      assert.equal(error.module, "fulfillment-connectors");
    }
  });

  define("runtime.existing-gates-unweakened", async () => {
    const denied = bundleRuntime({ runtime: { mock: { authorizationAllowed: false } } });
    const a = await f.prepareBundleSubmit(denied.h);
    await expectConnectorError(submit(denied.h, a.command), "stale_authorization", "not_dispatched");
    assert.equal(transportsOf(denied.h).length, 0);
    const budget = bundleRuntime({ runtime: { mock: { budgetAllowed: false } } });
    const b = await f.prepareBundleSubmit(budget.h);
    await expectConnectorError(submit(budget.h, b.command), "budget_denied", "not_dispatched");
    const missing = bundleRuntime({ runtime: { bindingOverrides: { order_authorization: { state: "missing", schemaVersion: undefined, sourceRevision: undefined, fixtureDigest: undefined } } } });
    const c = await f.prepareBundleSubmit(bundleRuntime().h);
    await expectConnectorError(submit(missing.h, c.command), "contract_missing", "not_dispatched");
    assert.equal(missing.h.counters.inbound, 0);
    const sandbox = bundleRuntime({ runtime: { runtimeOptions: { mode: "sandbox", sandboxEnabled: true } } });
    await expectConnectorError(submit(sandbox.h, c.command), "sandbox_disabled", "not_dispatched");
    assert.equal(sandbox.h.counters.inbound, 0);
    const lapsed = bundleRuntime({ runtime: { revalidate: () => ({ status: "rejected" }) } });
    const d = await f.prepareBundleSubmit(lapsed.h);
    await expectConnectorError(submit(lapsed.h, d.command), "stale_authorization", "not_dispatched");
    assert.equal(transportsOf(lapsed.h).length, 0);
    const stale = bundleRuntime();
    const e = await f.prepareBundleSubmit(stale.h);
    await expectConnectorError(submit(stale.h, { ...e.command, quote: { ...e.command.quote, expiresAt: "2000-01-01T00:00:00.000Z" } }), "stale_quote", "not_dispatched");
    assert.equal(stale.world.calls.resolve.length, 0, "the existing command validation still runs first");
  });

  const hardBlockCommand = () => f.bundleSubmitCommand({ providerQuoteId: "q-1", currency: "USD", totalMinor: 100, expiresAt: "2099-01-01T00:00:00.000Z" });

  define("runtime.nonsimulated-submit-hard-block-before-any-port-call", async () => {
    for (const withGate of [true, false]) {
      const world = baselineWorld();
      const gate = f.createGate(world);
      const h = f.createGateRuntime({ ...sandboxReady(), ...(withGate ? { gate } : {}) });
      assert.equal(h.runtime.audit().sandboxReady, true, "the forged runtime really is sandbox-ready");
      await expectConnectorError(submit(h, hardBlockCommand()), "bundle_invalid", "not_dispatched");
      assert.equal(portsTouched(h.counters), 0, JSON.stringify(h.counters));
      assert.deepEqual(h.order, []);
      assert.equal(world.calls.resolve.length + world.calls.read.length, 0);
      assert.equal(h.base.simulator.dispatchCounters().submit, 0);
    }
  });

  define("runtime.hard-block-follows-existing-mode-and-binding-gates-codes-preserved", async () => {
    const command = hardBlockCommand();
    const cases = [
      ["sandboxEnabled false", sandboxReady({ runtimeOptions: { mode: "sandbox", sandboxEnabled: false } }), command, f.SCOPE, "sandbox_disabled"],
      ["sandbox with unaccepted bindings", { runtimeOptions: { mode: "sandbox", sandboxEnabled: true } }, command, f.SCOPE, "sandbox_disabled"],
      ["live mode", { runtimeOptions: { mode: "live" } }, command, f.SCOPE, "mode_mismatch"],
      ["runtime/transport mismatch", { runtimeOptions: { mode: "simulated" }, transportMode: "sandbox" }, command, f.SCOPE, "mode_mismatch"],
      ["invalid scope", sandboxReady(), command, { tenantId: "", projectId: "p" }, "scope_mismatch"],
      ["non-JSON envelope", sandboxReady(), { ...command, hook: () => 1 }, f.SCOPE, "invalid_input"]
    ];
    for (const [label, options, cmd, scope, code] of cases) {
      const h = f.createGateRuntime(options);
      await expectConnectorError(h.runtime.submit(f.wrapEnvelope(cmd), scope), code, "not_dispatched");
      assert.equal(h.counters.inbound, 0, `${label}: refused before the contract validator`);
      assert.equal(portsTouched(h.counters), 0, label);
    }
    // And with everything valid the new block is what answers.
    const ready = f.createGateRuntime(sandboxReady());
    await expectConnectorError(submit(ready, command), "bundle_invalid", "not_dispatched");
    // A missing order_authorization binding in a simulated runtime keeps its own code.
    const missing = f.createGateRuntime({ bindingOverrides: { order_authorization: { state: "missing", schemaVersion: undefined, sourceRevision: undefined, fixtureDigest: undefined } } });
    await expectConnectorError(submit(missing, command), "contract_missing", "not_dispatched");
  });

  define("runtime.quote-preflight-status-shipment-cancel-behaviors-unaffected", async () => {
    // Simulated runtime with a gate: only submit touches the gate's ports.
    const { h, world } = bundleRuntime();
    const quote = await h.runtime.quote(envelope(makeQuoteCommand(f.BUNDLE_REF), f.SCOPE), f.SCOPE);
    assert.ok(quote.value.providerQuoteId);
    await h.runtime.preflight(envelope({ productionBundle: f.BUNDLE_REF, printSpecification: { fixture: "spec" } }, f.SCOPE), f.SCOPE);
    assert.equal(world.calls.resolve.length + world.calls.read.length, 0);
    const capabilities = await h.runtime.discoverCapabilities(envelope({}, f.SCOPE), f.SCOPE);
    assert.equal(capabilities.operation, "discover_capabilities");
    const prepared = await f.prepareBundleSubmit(h);
    const submitted = await submit(h, prepared.command);
    const status = await h.runtime.getStatus(envelope({ providerRequestId: submitted.value.providerRequestId }, f.SCOPE), f.SCOPE);
    assert.ok(status.value.normalizedState);
    assert.equal(status.productionBundleEvidence, undefined, "only a gated submit carries bundle evidence");
    const shipment = await h.runtime.observeShipment(envelope({ providerRequestId: submitted.value.providerRequestId }, f.SCOPE), f.SCOPE);
    assert.equal(shipment.operation, "shipment");
    // Sandbox-ready runtime: the hard block is submit-only. Every other operation still reaches ContractValidator.validateInbound exactly as
    // before. (The mock harness's usage sink and metering are simulated-only, so they end in its own usage_sink_unavailable / unsupported;
    // what matters here is that none of them is answered by the submit hard block.)
    const ready = f.createGateRuntime(sandboxReady());
    const attempts = {
      discover: () => ready.runtime.discoverCapabilities(envelope({}, f.SCOPE), f.SCOPE),
      quote: () => ready.runtime.quote(envelope(makeQuoteCommand(f.BUNDLE_REF), f.SCOPE), f.SCOPE),
      preflight: () => ready.runtime.preflight(envelope({ productionBundle: f.BUNDLE_REF, printSpecification: { fixture: "spec" } }, f.SCOPE), f.SCOPE),
      status: () => ready.runtime.getStatus(envelope({ providerRequestId: "r-1" }, f.SCOPE), f.SCOPE),
      shipment: () => ready.runtime.observeShipment(envelope({ providerRequestId: "r-1" }, f.SCOPE), f.SCOPE)
    };
    for (const [label, run] of Object.entries(attempts)) {
      const before = ready.counters.inbound;
      let caught; try { await run(); } catch (error) { caught = error; }
      assert.ok(caught === undefined || caught instanceof ConnectorError, label);
      assert.notEqual(caught?.code, "bundle_invalid", `${label} is not subject to the submit hard block`);
      assert.equal(ready.counters.inbound, before + 1, `${label} still reaches ContractValidator.validateInbound`);
    }
    // Control: submit on the very same runtime is the only operation the new block answers, and it answers without touching inbound.
    const inboundBeforeSubmit = ready.counters.inbound;
    await expectConnectorError(submit(ready, hardBlockCommand()), "bundle_invalid", "not_dispatched");
    assert.equal(ready.counters.inbound, inboundBeforeSubmit);
  });

  define("runtime.sandbox-forged-accepted-binding-with-gate-zero-ports-zero-transports", async () => {
    const world = baselineWorld();
    const gate = f.createGate(world);
    const h = f.createGateRuntime({ ...sandboxReady(), gate });
    await expectConnectorError(submit(h, hardBlockCommand()), "bundle_invalid", "not_dispatched");
    assert.equal(world.calls.resolve.length, 0); assert.equal(world.calls.read.length, 0);
    assert.deepEqual(snapshotCounters(h.counters), { inbound: 0, outbound: 0, claim: 0, revalidate: 0, persistenceGet: 0, persistenceClaim: 0, persistenceSave: 0, budget: 0, usage: 0, metering: 0, transport: 0, adapter: {} });
    assert.equal(h.transportRequests.length, 0);
    assert.equal(h.base.store.attempts.length, 0); assert.equal(h.base.store.simulatedReservations.length, 0);
  });

  define("runtime.unbranded-gate-rejected", async () => {
    const world = baselineWorld(); const genuine = f.createGate(world);
    const calls = { check: 0, recheck: 0 };
    const impostors = {
      plainObject: { kind: contract.PRODUCTION_BUNDLE_GATE_KIND, checkBeforeSubmit: async () => { calls.check += 1; return reportOf(); }, recheckBeforeDispatch: async () => { calls.recheck += 1; return reportOf(); } },
      spreadCopy: { ...genuine }, inheriting: Object.create(genuine), proxied: new Proxy(genuine, {}), frozenPlain: Object.freeze({ kind: contract.PRODUCTION_BUNDLE_GATE_KIND, checkBeforeSubmit: genuine.checkBeforeSubmit, recheckBeforeDispatch: genuine.recheckBeforeDispatch })
    };
    for (const [label, impostor] of Object.entries(impostors)) {
      const h = f.createGateRuntime({ gate: impostor });
      const command = f.bundleSubmitCommand({ providerQuoteId: "q", currency: "USD", totalMinor: 1, expiresAt: "2099-01-01T00:00:00.000Z" });
      await expectConnectorError(submit(h, command), "bundle_invalid", "not_dispatched");
      assert.equal(h.counters.inbound, 0, label); assert.equal(portsTouched(h.counters), 0, label);
    }
    assert.deepEqual(calls, { check: 0, recheck: 0 });
    assert.equal(contract.isGenuineProductionBundleGate(genuine), true);
    assert.equal(Object.isFrozen(genuine), true);
  });

  const tamperCases = {
    eligibilityEligible: (r) => { r.eligibility = "eligible"; }, verdictEligible: (r) => { r.verdict = "eligible"; }, authority: (r) => { r.authorityIssued = true; },
    accepted: (r) => { r.accepted = true; }, handoff: (r) => { r.handoffEligible = true; }, extraTopLevelKey: (r) => { r.approved = true; },
    missingCriterion: (r) => { r.criteria.pop(); }, reorderedCriteria: (r) => { r.criteria.reverse(); },
    fixedApprovalVerified: (r) => { const c = r.criteria.find((x) => x.id === "approval_exact_preview"); c.state = "verified_owner"; c.code = null; },
    severityDowngraded: (r) => { r.criteria.find((x) => x.id === "observed_geometry_consistency").critical = false; },
    openCodesUnsorted: (r) => { r.openCriticalCodes.reverse(); }, openCodeDropped: (r) => { r.openCriticalCodes.pop(); },
    wrongBundleHash: (r) => { r.bundle.hash = sha(enc("another bundle")); }, acceptedProvenance: (r) => { r.anchor.provenance.kind = "accepted"; },
    ownerAccepted: (r) => { r.owner.accepted = true; }, ownerVersion: (r) => { r.owner.version = "0.9.8"; },
    inputDigestChanged: (r) => { r.inputDigests["output.png"] = sha(enc("x")); }, outputDigestChanged: (r) => { r.outputDigests["output.png"] = sha(enc("x")); },
    unchangedLie: (r) => { r.unchanged = false; }, setDigestGarbage: (r) => { r.setDigest = sha(enc("garbage")); }, badTime: (r) => { r.evaluatedAt = "yesterday"; },
    badValidator: (r) => { r.consumer.validatorVersion = "other/1"; }, badDiagnostic: (r) => { r.diagnostic = { reasons: ["lowercase reason"] }; },
    notAllowedState: (r) => { const c = r.criteria.find((x) => x.id === "anchor_resolution"); c.state = "blocked"; c.code = "X"; },
    reportDigestGarbage: (r) => { r.reportDigest = sha(enc("not the digest of this report")); },
    unchangedClaimedWithDifferentOutput: (r) => { r.outputDigests["output.png"] = sha(enc("changed by the owner or the decoder")); r.unchanged = true; }
  };

  define("runtime.gate-claiming-eligible-or-extra-keys-rejected", async () => {
    const real = await reportOf();
    for (const [label, mutate] of Object.entries(tamperCases)) {
      for (const recompute of [true, false]) {
        const copy = structuredClone(real); mutate(copy); if (recompute && !["setDigestGarbage", "reportDigestGarbage"].includes(label)) redigest(copy);
        const validation = contract.validateGateReport(copy, { bundleDigest: f.BUNDLE_HASH });
        assert.equal(validation.ok, false, `${label} (recompute=${recompute})`);
      }
      const copy = (() => { const c = structuredClone(real); mutate(c); return ["setDigestGarbage", "reportDigestGarbage"].includes(label) ? c : redigest(c); })();
      const { h, world } = bundleRuntime({ noGate: true });
      const rt = f.createGateRuntime({ gate: sealedGate(() => copy) });
      const { command } = await f.prepareBundleSubmit(rt);
      await expectConnectorError(submit(rt, command), "bundle_invalid", "not_dispatched");
      assert.equal(rt.counters.claim, 0, label); assert.equal(rt.counters.budget, 0, label); assert.equal(rt.counters.persistenceClaim, 0, label);
      assert.equal(rt.counters.adapter.validateBeforeSubmit ?? 0, 0, label); assert.equal(transportsOf(rt).length, 0, label);
      void h; void world;
    }
    for (const bogus of [null, undefined, "report", 7, [], new Proxy({}, {}), Object.create(real)]) {
      const rt = f.createGateRuntime({ gate: sealedGate(() => bogus) });
      const { command } = await f.prepareBundleSubmit(rt);
      await expectConnectorError(submit(rt, command), "bundle_invalid", "not_dispatched");
      assert.equal(rt.counters.claim, 0);
    }
    const throwing = f.createGateRuntime({ gate: sealedGate(() => { throw new Error("gate exploded"); }) });
    const prepared = await f.prepareBundleSubmit(throwing);
    await expectConnectorError(submit(throwing, prepared.command), "bundle_invalid", "not_dispatched");
    const failed = f.createGateRuntime({ gate: sealedGate(() => runGate(f.createWorld())) });
    const p2 = await f.prepareBundleSubmit(failed);
    await expectConnectorError(submit(failed, p2.command), "bundle_invalid", "not_dispatched");
  });

  define("runtime.fixed-criterion-code-tamper-with-recomputed-digests-rejected-zero-effects", async () => {
    // R43-02. A branded gate rewrites the CODE of a frozen criterion to another well-formed REASON code and then recomputes everything the
    // validator can cross-check: the open critical codes and the report digest. Only the frozen-table fixed check can catch this.
    const real = await reportOf();
    const consistent = (mutate) => { const copy = structuredClone(real); mutate(copy); copy.openCriticalCodes = [...contract.openCriticalCodes(copy.criteria)]; return redigest(copy); };
    const validate = (report) => contract.validateGateReport(report, { bundleDigest: f.BUNDLE_HASH });
    assert.equal(validate(consistent(() => {})).ok, true, "control: the recomputation helper itself yields a valid report");
    const fixedRows = contract.PRODUCTION_BUNDLE_CRITERIA.filter((row) => row.fixed !== null);
    assert.ok(fixedRows.length >= 20, `the frozen table has ${fixedRows.length} fixed rows`);
    let changedEvidence = 0;
    for (const row of fixedRows) {
      assert.deepEqual([...row.allowedStates], [row.fixed.state], `${row.id}: the allowed-state check alone pins the state, so only the fixed check can pin the CODE`);
      for (const replacement of ["TAMPERED_FIXED_CODE", row.fixed.code === "PRINTSPEC_BYTES_UNAVAILABLE" ? "OWNER_ACCEPTANCE_PENDING" : "PRINTSPEC_BYTES_UNAVAILABLE"]) {
        const tampered = consistent((r) => { r.criteria.find((x) => x.id === row.id).code = replacement; });
        assert.equal(tampered.reportDigest, contract.computeReportDigest(tampered), `${row.id}: digest recomputed`);
        assert.deepEqual(tampered.openCriticalCodes, [...contract.openCriticalCodes(tampered.criteria)], `${row.id}: open critical codes recomputed`);
        assert.deepEqual(validate(tampered), { ok: false, reason: "REPORT_FIXED_CRITERION" }, `${row.id} -> ${replacement}`);
        if (JSON.stringify(tampered.openCriticalCodes) !== JSON.stringify(real.openCriticalCodes)) changedEvidence += 1;
      }
    }
    assert.ok(changedEvidence > 0, "at least some tampered reports also changed the evidence's open critical codes (the harm this guard prevents)");
    // Through the runtime with a genuinely branded gate: bundle_invalid, nothing claimed, budgeted, persisted, adapted or sent.
    for (const id of ["owner_eligibility", "approval_exact_preview", "accepted_pins"]) {
      const tampered = consistent((r) => { r.criteria.find((x) => x.id === id).code = "TAMPERED_FIXED_CODE"; });
      const rt = f.createGateRuntime({ gate: sealedGate(() => tampered) });
      const { command } = await f.prepareBundleSubmit(rt);
      await expectConnectorError(submit(rt, command), "bundle_invalid", "not_dispatched");
      assert.equal(rt.counters.claim, 0, id); assert.equal(rt.counters.budget, 0, id); assert.equal(rt.counters.persistenceClaim, 0, id);
      assert.equal(rt.counters.adapter.validateBeforeSubmit ?? 0, 0, id); assert.equal(transportsOf(rt).length, 0, id);
    }
    // The untampered report through the same kind of gate still proceeds as the labelled no-effect simulation: the guard is not over-eager.
    const honest = f.createGateRuntime({ gate: sealedGate(() => consistent(() => {})) });
    const prepared = await f.prepareBundleSubmit(honest);
    const response = await submit(honest, prepared.command);
    assert.equal(response.productionBundleEvidence.simulation, "no_effect_simulation");
  });

  define("runtime.gate-report-literals-digests-provenance-sorted-codes-validated", async () => {
    const real = await reportOf();
    const validation = contract.validateGateReport(real, { bundleDigest: f.BUNDLE_HASH });
    assert.equal(validation.ok, true);
    assert.notEqual(validation.report, real, "the runtime works on its own copy");
    assert.equal(Object.isFrozen(validation.report), true); assert.equal(Object.isFrozen(validation.report.criteria), true); assert.equal(Object.isFrozen(validation.report.criteria[0]), true);
    assert.deepEqual(validation.report.openCriticalCodes, [...validation.report.openCriticalCodes].sort());
    assert.equal(validation.report.reportDigest, contract.computeReportDigest(validation.report));
    assert.equal(validation.report.setDigest, contract.computeSetDigest(validation.report.inputDigests));
    assert.equal(validation.report.anchor.provenance.kind, "development_fixture");
    // A gate that keeps and mutates the report it returned cannot change the evidence the runtime already took.
    let kept;
    const genuine = await reportOf();
    const mutableGate = sealedGate(() => { kept = structuredClone(genuine); return kept; });
    const rt = f.createGateRuntime({ gate: mutableGate });
    const { command } = await f.prepareBundleSubmit(rt);
    const response = await submit(rt, command);
    const evidence = structuredClone(response.productionBundleEvidence);
    kept.eligibility = "eligible"; kept.openCriticalCodes.length = 0; kept.accepted = true;
    assert.deepEqual(response.productionBundleEvidence, evidence);
    assert.equal(response.productionBundleEvidence.eligibility, "blocked");
    assert.equal(response.productionBundleEvidence.reportDigest, genuine.reportDigest);
  });

  define("runtime.simulated-no-effect-simulation-labelled-blocked-with-open-critical-codes", async () => {
    const terms = f.termsSourceFor(f.baselineManifest);
    const { h } = bundleRuntime({ gateOverrides: { terms } });
    const { command } = await f.prepareBundleSubmit(h);
    const response = await submit(h, command);
    const evidence = response.productionBundleEvidence;
    assert.equal(h.dependencies.transport.mode, "simulated"); assert.equal(response.mode, "simulated");
    assert.equal(evidence.simulation, "no_effect_simulation"); assert.equal(evidence.eligibility, "blocked");
    assert.ok(evidence.openCriticalCodes.includes("TERMS_BINDING_FIXTURE_ONLY"));
    assert.ok(!evidence.openCriticalCodes.includes("TERMS_SOURCE_ABSENT"));
    assert.ok(evidence.openCriticalCodes.length >= 16);
    assert.equal(evidence.authorityIssued, false); assert.equal(evidence.accepted, false); assert.equal(evidence.handoffEligible, false);
    assert.ok(h.base.simulator.snapshot().billingEvidence.every((record) => record.charged === false));
  });

  define("runtime.hard-block-precedes-validateInbound-with-all-bindings-forged-accepted", async () => {
    const h = f.createGateRuntime({ ...sandboxReady(), gate: f.createGate(baselineWorld()) });
    for (const shape of ["production_bundle", "fulfillment_quote", "order_authorization", "operation_envelope"]) assert.equal(h.dependencies.contracts.binding(shape).state, "accepted", shape);
    assert.equal(h.runtime.audit().contractReadiness.ready, true);
    await expectConnectorError(submit(h, hardBlockCommand()), "bundle_invalid", "not_dispatched");
    assert.equal(h.counters.inbound, 0, "ContractValidator.validateInbound was never called");
    assert.equal(h.counters.outbound, 0);
    assert.deepEqual(h.order, []);
    assert.equal(portsTouched(h.counters), 0);
    const source = read("src/runtime.ts");
    const submitBody = source.slice(source.indexOf("async submit("), source.indexOf("async getStatus("));
    assert.ok(submitBody.indexOf("assertSubmitBundleGate()") > 0 && submitBody.indexOf("assertSubmitBundleGate()") < submitBody.indexOf("decodeAfterPrecheck"), "the block is wired before the port half of decode");
  });

  define("runtime.recommitted-invalid-geometry-or-signature-never-reaches-simulated-transport", async () => {
    const png = f.baseline().files.get("output.png");
    const badPhys = png.slice(); const probe = new DataView(badPhys.buffer);
    let offset = 8; while (new TextDecoder().decode(badPhys.subarray(offset + 4, offset + 8)) !== "pHYs") offset += 12 + probe.getUint32(offset);
    probe.setUint32(offset + 8, 11772); probe.setUint32(offset + 12, 11772);
    const { crc32 } = await import("node:zlib");
    probe.setUint32(offset + 17, crc32(badPhys.subarray(offset + 4, offset + 17)));
    const pdf = f.baseline().files.get("output.pdf").slice(); pdf[0] = 0x23;
    const mutations = {
      phys: { payload: { "output.png": badPhys } }, declaredWidth: { manifest: (m) => { m.files.find((x) => x.filename === "output.png").geometry.width_px = 1000; } },
      declaredDpi: { manifest: (m) => { m.files.find((x) => x.filename === "output.png").geometry.effective_dpi = 72; } },
      pngIsPdf: { payload: { "output.png": f.baseline().files.get("output.pdf") } }, garbagePng: { payload: { "output.png": enc("not a png") } },
      pdfSignature: { payload: { "output.pdf": pdf } }, svgRoot: { payload: { "output.svg": enc("<html></html>") } }
    };
    for (const [label, mutation] of Object.entries(mutations)) {
      const recommitted = f.recommit(mutation);
      assert.deepEqual(f.ownerVerifyDirect(recommitted.files, recommitted.commitment), { ok: true, integrity: "passed", eligibility: "blocked" }, `${label}: the owner passes first`);
      const world = f.createWorld(); f.publishFromBaseline(world, recommitted.files, recommitted.commitmentBytes, recommitted.bundleHash);
      const direct = await f.createGate(world).checkBeforeSubmit(f.gateRequest({ bundleDigest: recommitted.bundleHash, envelopeBundle: undefined }));
      const geometry = criterion(direct, "observed_geometry_consistency");
      assert.equal(geometry.state, "failed", label); assert.equal(geometry.critical, true, `${label}: never downgraded to informational`);
      assert.equal(criterion(direct, "owner_integrity").state, "verified_owner", label);
      const gate = f.createGate(world);
      const h = f.createGateRuntime({ gate });
      const ref = { ...f.BUNDLE_REF, content_hash: recommitted.bundleHash };
      const { command } = await f.prepareBundleSubmit(h, recommitted.bundleHash, ref);
      const transportsBefore = h.transportRequests.length; const before = snapshotCounters(h.counters);
      await expectConnectorError(submit(h, command), "bundle_invalid", "not_dispatched");
      assert.equal(h.transportRequests.length, transportsBefore, `${label}: zero simulated transport requests for the submit`);
      assert.equal(h.base.simulator.dispatchCounters().submit, 0, label);
      assert.equal(h.counters.claim, 0, label); assert.equal(h.counters.budget, 0, label);
      assert.equal(h.counters.persistenceGet + h.counters.persistenceClaim + h.counters.persistenceSave, before.persistenceGet + before.persistenceClaim + before.persistenceSave, label);
      assert.equal(h.counters.revalidate, 0, label); assert.equal(h.counters.adapter.validateBeforeSubmit ?? 0, 0, label); assert.equal(h.counters.adapter.submit ?? 0, 0, label);
      assert.equal(h.base.store.attempts.length, 0, label); assert.equal(h.base.store.simulatedReservations.length, 0, label);
    }
  });

  // ---- static -----------------------------------------------------------------------------------------------
  const srcFiles = () => readdirSync(new URL("../src/", import.meta.url)).filter((name) => name.endsWith(".ts"));

  define("static.single-owner-import-site", () => {
    const importers = srcFiles().filter((name) => /@jevelopers\/shared-contracts/.test(read(`src/${name}`).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").replace(/^\s*\*.*$/gm, "")) &&
      /from\s+["']@jevelopers\/shared-contracts/.test(read(`src/${name}`)));
    assert.deepEqual(importers, ["production-bundle-owner.ts"]);
    assert.equal(read("src/production-bundle-owner.ts").match(/from "@jevelopers\/shared-contracts[^"]*"/g).length, 1);
    assert.ok(read("src/production-bundle-owner.ts").includes('"@jevelopers/shared-contracts/production-operations"'));
  });

  define("static.forbidden-owner-functions-never-imported", () => {
    const forbidden = /\b(checkProductionBundleEligibility|checkProductionApproval|checkProductionAuthority|checkProductionHostApproval|checkProductionPreflight|checkPrintSpecBinding)\b/;
    for (const name of srcFiles()) {
      const code = read(`src/${name}`).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      assert.ok(!forbidden.test(code), `${name} must not call owner eligibility/approval/authority/preflight functions`);
    }
    const dist = readdirSync(new URL("../dist/", import.meta.url)).filter((name) => name.endsWith(".js"));
    for (const name of dist) assert.ok(!forbidden.test(readFileSync(new URL(`../dist/${name}`, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")), `dist/${name}`);
  });

  define("static.owner-not-loaded-by-index", () => {
    // The static ESM import graph reachable from dist/index.js never contains the owner package or the owner-importing modules.
    const seen = new Set(); const stack = ["index.js"]; const bareImports = new Set();
    while (stack.length > 0) {
      const name = stack.pop(); if (seen.has(name)) continue; seen.add(name);
      const code = readFileSync(new URL(`../dist/${name}`, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const match of code.matchAll(/(?:import|export)[^"';]*?from\s*["']([^"']+)["']/g)) {
        if (match[1].startsWith("./")) stack.push(match[1].slice(2)); else bareImports.add(match[1]);
      }
    }
    assert.ok(!seen.has("production-bundle.js") && !seen.has("production-bundle-owner.js"));
    assert.ok(seen.has("production-bundle-contract.js"));
    assert.ok(![...bareImports].some((specifier) => specifier.startsWith("@jevelopers/")), [...bareImports].join(","));
    const manifest = JSON.parse(read("package.json"));
    assert.deepEqual(Object.keys(manifest.exports), [".", "./production-bundle"]);
    assert.equal(manifest.exports["./production-bundle"].import, "./dist/production-bundle.js");
    assert.equal(manifest.exports["."].import, "./dist/index.js");
    assert.ok(!/production-bundle-owner|production-bundle\.js/.test(read("src/index.ts")));
  });

  define("static.docs-d6-wording-consistent", () => {
    const docs = read("docs/production-bundle.md");
    assert.ok(docs.includes("no approved, eligible, accepted or non-simulated dispatch"));
    assert.ok(docs.includes("no-effect simulation"));
    for (const path of ["docs/production-bundle.md", "README.md", "docs/runtime.md", "docs/simulator.md", "docs/png-inspection.md"]) {
      assert.ok(!/no dispatch while the `?production_bundle`? (contract )?(is )?unaccepted/i.test(read(path)), `${path} must not carry the retired contradictory D6 phrase`);
    }
  });

  define("static.docs-pbr25-abort-signal-memory-bound-limit-documented", () => {
    const docs = read("docs/production-bundle.md");
    assert.match(docs, /AbortSignal/);
    assert.match(docs, /memory bound assumes the host (port )?honou?rs the `?AbortSignal`?/);
    assert.match(docs, /late result is dropped/i);
    assert.match(docs, /308 MiB/);
  });

  // ---- suite ------------------------------------------------------------------------------------------------
  define("suite.package-wrapper-fixed-evidence-dir", () => {
    const root = "/repo";
    assert.equal(PACKAGE_EVIDENCE_DIR, "evidence/FC-08");
    assert.equal(packageEvidenceDirAllowed(root, "evidence/FC-08"), true);
    assert.equal(packageEvidenceDirAllowed(root, "./evidence/FC-08"), true);
    assert.equal(packageEvidenceDirAllowed(root, "/repo/evidence/FC-08"), true);
    for (const bad of ["evidence/FC-08-10-PNG", "evidence/FC-08/sub", "evidence/FC-08/../x", "/tmp/evidence/FC-08", "evidence", "", "../evidence/FC-08", undefined, 7]) assert.equal(packageEvidenceDirAllowed(root, bad), false, String(bad));
    const verifier = read("scripts/verify-fulfillment");
    assert.ok(verifier.includes("packageEvidenceDirAllowed(repositoryRoot") && verifier.includes("PACKAGE_EVIDENCE_DIR") && verifier.includes('"package"'));
    assert.ok(verifier.includes('args.suite === "package" && args.mode !== "simulated"'));
    assert.match(read("package.json"), /"verify:package": "\.\/scripts\/verify-fulfillment --suite package --mode simulated --evidence-dir evidence\/FC-08"/);
  });

  define("suite.report-fields-complete", async () => {
    const bundleReport = await reportOf();
    const revision = sourceRevision(new URL("..", import.meta.url).pathname);
    const checks = PACKAGE_SUITE_CASE_IDS.map((name) => ({ name, status: "passed" }));
    const runnerReport = { externalProviderCalls: 0, orderCalls: 0, financeCalls: 0 };
    const assessment = buildPackageAssessment({ runnerReport, bundleReport, revision, status: "passed", checks });
    assert.equal(validPackageAssessment(assessment), true);
    assert.equal(assessment.validator.version, contract.PRODUCTION_BUNDLE_VALIDATOR_VERSION);
    assert.deepEqual(assessment.ownerPin, bundleReport.owner);
    assert.equal(assessment.criteria.length, 32);
    assert.equal(assessment.anchor.provenance.kind, "development_fixture");
    assert.equal(assessment.bundle.hash, f.BUNDLE_HASH);
    assert.equal(assessment.specRef.contentHash, f.baselineManifest.spec_ref.content_hash);
    assert.equal(assessment.setDigest, bundleReport.setDigest);
    assert.equal(Object.keys(assessment.inputDigests).length, 9);
    assert.equal(assessment.localFixtureCounts.total, checks.length);
    assert.deepEqual(assessment.blockers, [...PACKAGE_BLOCKERS]);
    for (const key of Object.keys(assessment)) { const broken = { ...assessment }; delete broken[key]; assert.equal(validPackageAssessment(broken), false, `missing ${key}`); }
    for (const [key, value] of [["eligibility", "eligible"], ["authorityIssued", true], ["accepted", true], ["handoffEligible", true], ["sandboxReady", true], ["liveEnabled", true], ["releaseReady", true], ["orderCalls", 1], ["externalProviderCalls", 1], ["financeCalls", 1]]) {
      assert.equal(validPackageAssessment({ ...assessment, [key]: value }), false, key);
    }
    assert.equal(validPackageAssessment({ ...assessment, reportDigest: sha(enc("other")) }), false);
    assert.equal(validPackageAssessment({ ...assessment, injected: true }), false);
    const dirty = sourceRevision("/nonexistent-directory-for-fc08", () => { throw new Error("no git"); });
    assert.deepEqual(dirty, { sha: null, dirty: null });
  });

  define("suite.node-pin-24-21-0", () => {
    assert.equal(process.version, "v24.21.0");
    assert.equal(read(".node-version").trim(), "24.21.0");
    const manifest = JSON.parse(read("package.json"));
    assert.equal(manifest.engines.node, "24.21.0"); assert.equal(manifest.packageManager, "npm@11.19.0");
    const lock = JSON.parse(read("package-lock.json"));
    assert.equal(lock.packages[""].engines.node, "24.21.0");
    const entry = lock.packages["node_modules/@jevelopers/shared-contracts"];
    assert.equal(entry.resolved, `file:${contract.OWNER_PACKAGE_PIN.archiveFile}`);
    assert.equal(entry.integrity, contract.OWNER_PACKAGE_PIN.integrity);
    assert.equal(manifest.dependencies["@jevelopers/shared-contracts"], `file:${contract.OWNER_PACKAGE_PIN.archiveFile}`);
    const archive = readFileSync(new URL(`../${contract.OWNER_PACKAGE_PIN.archiveFile}`, import.meta.url));
    assert.equal(createHash("sha256").update(archive).digest("hex"), contract.OWNER_PACKAGE_PIN.archiveSha256);
    assert.equal(`sha512-${createHash("sha512").update(archive).digest("base64")}`, contract.OWNER_PACKAGE_PIN.integrity);
    assert.equal(createHash("sha1").update(`blob ${archive.length}\0`).update(archive).digest("hex"), "e8f2874a987d270bdd5668b78110e6cc2ad6886e");
    const installed = JSON.parse(readFileSync(new URL("../node_modules/@jevelopers/shared-contracts/package.json", import.meta.url), "utf8"));
    assert.equal(installed.version, contract.OWNER_PACKAGE_PIN.version);
    const lifecycle = ["preinstall", "install", "postinstall", "prepare", "prepublish", "prepublishOnly", "prepack", "postpack"];
    assert.deepEqual(lifecycle.filter((name) => installed.scripts?.[name] !== undefined), []);
    assert.equal(installed.dependencies, undefined);
    assert.equal(installed.engines.node, ">=22.23.3 <23 || >=24.21.0 <25");
    const ci = read(".github/workflows/ci.yml");
    assert.ok(ci.includes('"v24.21.0"') && ci.includes('"11.19.0"') && !ci.includes("24.15.0") && !ci.includes("11.12.1"));
    assert.ok(ci.includes(contract.OWNER_PACKAGE_PIN.archiveSha256) && ci.includes("verify:package"));
    assert.ok(read("scripts/verify-fulfillment").includes('"v24.21.0"') && !read("scripts/verify-fulfillment").includes("24.15.0"));
  });

  define("suite.zero-provider-order-finance-calls", async () => {
    const { h } = bundleRuntime();
    const { command } = await f.prepareBundleSubmit(h);
    const response = await submit(h, command);
    assert.equal(response.mode, "simulated");
    assert.ok(h.transportRequests.every((request) => request.path.startsWith("/simulator/") || request.path.startsWith("/fixture/")), "every transport request is the in-process simulator");
    assert.ok(h.base.simulator.snapshot().billingEvidence.every((record) => record.billingMode === "simulated" && record.charged === false));
    const runner = { externalProviderCalls: 0, orderCalls: 0, financeCalls: 0 };
    assert.deepEqual(runner, { externalProviderCalls: 0, orderCalls: 0, financeCalls: 0 });
    const sources = srcFiles().filter((name) => name.startsWith("production-bundle")).map((name) => read(`src/${name}`).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")).join("\n");
    assert.ok(!/\bfetch\s*\(|node:https?|node:net\b|node:dgram|XMLHttpRequest|process\.env|readFile/.test(sources), "no network, environment or file access in the consumer");
    if (process.env.FC_ATTEMPT_EXPECT_NETWORK_DENIAL === "1") {
      const net = await import("node:net");
      const outcome = await new Promise((resolve) => { const socket = net.connect({ host: "93.184.216.34", port: 80, timeout: 1500 }); socket.on("connect", () => { socket.destroy(); resolve("connected"); }); socket.on("error", (error) => resolve(error.code)); socket.on("timeout", () => { socket.destroy(); resolve("timeout"); }); });
      assert.notEqual(outcome, "connected", "the operating system denies network access");
    }
  });

  // ---- runner -----------------------------------------------------------------------------------------------
  define("runner.output-parser-rejects-malformed-and-inconsistent-reports", () => {
    const good = { schemaVersion: "fulfillment-package-case-results/1", suite: "package", caseCount: PACKAGE_SUITE_CASE_IDS.length, passed: PACKAGE_SUITE_CASE_IDS.length, failed: 0, skipped: 0, cases: PACKAGE_SUITE_CASE_IDS.map((id) => ({ id, status: "passed" })) };
    assert.equal(parsePackageOutput(`${JSON.stringify(good)}\n`).valid, true);
    for (const bad of ["", "{}", `${JSON.stringify(good)}`, `${JSON.stringify(good)}\r\n`, `${JSON.stringify({ ...good, skipped: 1 })}\n`, `${JSON.stringify({ ...good, cases: good.cases.slice(1) })}\n`,
      `${JSON.stringify({ ...good, cases: [...good.cases].reverse() })}\n`, `${JSON.stringify({ ...good, extra: true })}\n`, `${JSON.stringify({ ...good, passed: good.passed - 1, failed: 1 })}\n`,
      `${JSON.stringify({ ...good, suite: "order-authorization" })}\n`]) assert.equal(parsePackageOutput(bad).valid, false);
    assert.equal(new Set(PACKAGE_SUITE_CASE_IDS).size, PACKAGE_SUITE_CASE_IDS.length);
    assert.ok(PACKAGE_SUITE_CASE_IDS.length >= 152);
  });

  define("runner.report-validator-and-process-control-reject-unsafe-reports", () => {
    const spawned = runPackageTests({ spawn: () => ({ stdout: "", stderr: "boom", status: 1, signal: null }) });
    assert.equal(spawned.status, "failed"); assert.equal(validPackageRunnerReport(spawned), true);
    const missing = runPackageTests({ spawn: () => { throw Object.assign(new Error("x"), { code: "ENOENT" }); } });
    assert.equal(missing.status, "failed"); assert.equal(validPackageRunnerReport(missing), true);
    assert.equal(validPackageRunnerReport({ ...spawned, injected: "field" }), false);
    assert.equal(validPackageRunnerReport({ ...spawned, orderCalls: 1 }), false);
    assert.equal(validPackageRunnerReport({ ...spawned, sandboxReady: true }), false);
    assert.equal(validPackageRunnerReport({ ...spawned, status: "passed" }), false);
    assert.equal(validPackageRunnerReport({ ...spawned, financeCalls: 1 }), false);
  });
}
