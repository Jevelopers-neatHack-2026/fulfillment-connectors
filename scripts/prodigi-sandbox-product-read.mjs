#!/usr/bin/env node
/**
 * Owner-gated Prodigi SANDBOX product read: one `GET /v4.0/products/GLOBAL-PHO-4X6`.
 *
 * The default mode is a zero-request PREFLIGHT. It reads no key, no environment
 * variable and no `.env`, contacts no provider and no network, and names every
 * gate that is still missing. It never authorizes anything: a reference that
 * merely exists is not authority.
 *
 *   npm run build
 *   node scripts/prodigi-sandbox-product-read.mjs \
 *     --decision-reference <ref> --owner-permission-reference <ref> \
 *     --account-terms-reference <ref> --request-cost-budget-reference <ref> \
 *     --source-revision <40 hex> --owner-packet-sha256 <64 hex> \
 *     --receipt-path /absolute/path/outside/git/receipt.json
 *
 * `--execute --owner-approved` additionally needs a TRUSTED HOST that verifies
 * the three owner-action references (owner permission, accepted account terms,
 * request-cost budget). This command line has no such host and cannot
 * construct one, so run from here `--execute` always refuses with zero requests
 * and zero credential reads. A host application that owns those authorities
 * embeds `runProductRead(argv, { host, ... })`; the library check inside the
 * client is the same either way.
 *
 * The selection is compiled in (GLOBAL-PHO-4X6, US, Standard, from the owner
 * delegated decision 0003 R1-R3); there is no SKU, URL, host or fallback option.
 * The decision reference is an OPERATOR ATTESTATION of that delegated decision
 * and is nothing more: it is not account proof, accepted terms or a cost
 * approval. The key is read only from PRODIGI_SANDBOX_API_KEY, only after every
 * gate and after the receipt file exists, and never from argv, a whole `.env`
 * (`node --env-file` is refused) or a log. Export just that one variable for the
 * one process.
 */
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const PRODUCT_READ_PREFLIGHT_SCHEMA = "prodigi-sandbox-product-read-preflight/1";
export const PRODUCT_READ_RECEIPT_SCHEMA = "prodigi-sandbox-product-read-receipt/1";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1_048_576;
const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u;
const REVISION_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const RECEIPT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/u;
const NAME_TOKEN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
const VALUE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9 ._:+/()-]{0,63}$/u;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const ERROR_CODES = new Set([
  "sandbox_calls_disabled", "aborted", "decision_unverified", "decision_mismatch", "invalid_input", "credential_unavailable",
  "authentication_failed", "validation_failed", "not_found", "rate_limited", "provider_unavailable", "timeout", "invalid_response",
  "request_budget_exhausted", "grant_unverified"
]);

const OPTIONS = {
  execute: { type: "boolean", default: false },
  "owner-approved": { type: "boolean", default: false },
  "decision-reference": { type: "string" },
  "owner-permission-reference": { type: "string" },
  "account-terms-reference": { type: "string" },
  "request-cost-budget-reference": { type: "string" },
  "source-revision": { type: "string" },
  "owner-packet-sha256": { type: "string" },
  "receipt-path": { type: "string" }
};

const sha256Hex = (text) => createHash("sha256").update(text, "utf8").digest("hex");

// ---------------------------------------------------------------------------
// Receipt location

/** Returns `{ ok: true }` or `{ ok: false, code }`. Reads directory metadata only, never a file's contents. */
export function validateReceiptPath(value, fsApi = fs) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024 || value.includes("\u0000")) return { ok: false, code: "receipt_path_invalid" };
  if (!path.isAbsolute(value)) return { ok: false, code: "receipt_path_not_absolute" };
  if (path.normalize(value) !== value || value.endsWith(path.sep)) return { ok: false, code: "receipt_path_not_normalized" };
  if (!RECEIPT_NAME_PATTERN.test(path.basename(value))) return { ok: false, code: "receipt_name_invalid" };
  const parent = path.dirname(value);
  let real;
  try {
    real = fsApi.realpathSync(parent);
    if (!fsApi.statSync(real).isDirectory()) return { ok: false, code: "receipt_parent_not_directory" };
  } catch {
    return { ok: false, code: "receipt_parent_missing" };
  }
  if (real !== parent) return { ok: false, code: "receipt_path_contains_symlink" };
  if (parent === repositoryRoot || parent.startsWith(repositoryRoot + path.sep)) return { ok: false, code: "receipt_path_inside_repository" };
  for (let directory = parent; ; directory = path.dirname(directory)) {
    try {
      fsApi.lstatSync(path.join(directory, ".git"));
      return { ok: false, code: "receipt_path_inside_git_worktree" };
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") return { ok: false, code: "receipt_path_unverifiable" };
    }
    if (path.dirname(directory) === directory) break;
  }
  try {
    if (fsApi.readdirSync(parent).some((name) => name.startsWith(".env"))) return { ok: false, code: "receipt_parent_env_adjacent" };
  } catch {
    return { ok: false, code: "receipt_path_unverifiable" };
  }
  try {
    fsApi.lstatSync(value);
    return { ok: false, code: "receipt_path_exists" };
  } catch (error) {
    if (error?.code !== "ENOENT") return { ok: false, code: "receipt_path_unverifiable" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Receipt

const RECEIPT_KEYS = ["schema", "sourceRevision", "ownerPacketSha256", "refs", "request", "outcome", "decoded", "trustedHostGrant", "attestations", "recordedAt"];
const keysOf = (value) => (value !== null && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort().join(",") : "");
const sameKeys = (value, expected) => keysOf(value) === [...expected].sort().join(",");

/** Returns the list of problems with a receipt; empty means it holds only the allowed, safe fields. */
export function validateProductReadReceipt(receipt, { forbiddenText = [] } = {}) {
  const problems = [];
  if (!sameKeys(receipt, RECEIPT_KEYS)) return ["receipt_keys"];
  if (receipt.schema !== PRODUCT_READ_RECEIPT_SCHEMA) problems.push("schema");
  if (!REVISION_PATTERN.test(receipt.sourceRevision)) problems.push("sourceRevision");
  if (!SHA256_PATTERN.test(receipt.ownerPacketSha256)) problems.push("ownerPacketSha256");
  if (!sameKeys(receipt.refs, ["decision", "ownerPermission", "accountTerms", "requestCostBudget"]) ||
      Object.values(receipt.refs).some((ref) => typeof ref !== "string" || !REFERENCE_PATTERN.test(ref))) problems.push("refs");
  const request = receipt.request;
  if (!sameKeys(request, ["method", "origin", "path", "attempts", "dispatched", "refused", "retries", "redirect", "timeoutMs", "maxProviderRequests"]) ||
      request.method !== "GET" || request.origin !== "https://api.sandbox.prodigi.com" || request.path !== "/v4.0/products/GLOBAL-PHO-4X6" ||
      request.retries !== 0 || request.redirect !== "error" || request.timeoutMs !== TIMEOUT_MS || request.maxProviderRequests !== 1 ||
      ![request.attempts, request.dispatched, request.refused].every((n) => Number.isSafeInteger(n) && n >= 0 && n <= 8) || request.dispatched > 1) problems.push("request");
  const outcome = receipt.outcome;
  const outcomeKeys = ["status", "httpStatus", "errorCode", "sideEffectState", "elapsedMs", "responseBytes"];
  if (!sameKeys(outcome, outcomeKeys) || !["ok", "failed"].includes(outcome.status) ||
      (outcome.httpStatus !== null && !(Number.isSafeInteger(outcome.httpStatus) && outcome.httpStatus >= 100 && outcome.httpStatus <= 599)) ||
      (outcome.errorCode !== null && !ERROR_CODES.has(outcome.errorCode)) ||
      (outcome.sideEffectState !== null && !["not_dispatched", "possible", "confirmed", "unknown"].includes(outcome.sideEffectState)) ||
      !Number.isSafeInteger(outcome.elapsedMs) || outcome.elapsedMs < 0 ||
      (outcome.responseBytes !== null && !(Number.isSafeInteger(outcome.responseBytes) && outcome.responseBytes >= 0)) ||
      (outcome.status === "ok") !== (outcome.errorCode === null)) problems.push("outcome");
  const decoded = receipt.decoded;
  if (outcome?.status === "failed" ? decoded !== null : !validDecoded(decoded)) problems.push("decoded");
  const grant = receipt.trustedHostGrant;
  if (!sameKeys(grant, ["verified", "expiresAt"]) || typeof grant.verified !== "boolean" || (grant.expiresAt !== null && !ISO_PATTERN.test(grant.expiresAt ?? ""))) problems.push("trustedHostGrant");
  const expected = {
    decisionVerifier: "operator_attestation_only", keyPresence: "name_only_never_proof", accountAccess: "NOT_ASSERTED_ONLY_OBSERVED_BY_THIS_ONE_READ",
    accountTerms: "NOT_VERIFIED_BY_THIS_RECEIPT", builtArtifact: "NOT_VERIFIED_AGAINST_SOURCE", requestCost: "UNKNOWN", authorityIssued: false, quoteAuthority: false, orderAuthority: false,
    bundleEligible: false, trimOrTierApproval: false, customerApproval: false
  };
  if (!sameKeys(receipt.attestations, Object.keys(expected)) || Object.entries(expected).some(([key, value]) => receipt.attestations[key] !== value)) problems.push("attestations");
  if (typeof receipt.recordedAt !== "string" || !ISO_PATTERN.test(receipt.recordedAt)) problems.push("recordedAt");
  const text = JSON.stringify(receipt);
  // The only absolute URL text allowed is the fixed sandbox origin recorded once.
  if ((text.match(/:\/\//gu) ?? []).length !== 1) problems.push("unexpected_url_text");
  if (forbiddenText.some((value) => typeof value === "string" && value.length > 0 && text.includes(value))) problems.push("forbidden_text");
  return problems;
}

function validDecoded(decoded) {
  if (!sameKeys(decoded, ["sku", "decodedSha256", "productDimensions", "attributeNames", "finishAttributeValues", "variantCount", "variantsShippingToUS", "shipsToIncludesUS", "printAreas", "defaultPrintAreaRecommendedPixelSizes"])) return false;
  const count = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000;
  const size = decoded.productDimensions;
  return decoded.sku === "GLOBAL-PHO-4X6" && SHA256_PATTERN.test(decoded.decodedSha256) &&
    sameKeys(size, ["width", "height", "units"]) && Number.isFinite(size.width) && Number.isFinite(size.height) && VALUE_TOKEN.test(size.units) &&
    Array.isArray(decoded.attributeNames) && decoded.attributeNames.length <= 64 && decoded.attributeNames.every((name) => NAME_TOKEN.test(name)) &&
    Array.isArray(decoded.finishAttributeValues) && decoded.finishAttributeValues.length <= 64 && decoded.finishAttributeValues.every((value) => VALUE_TOKEN.test(value)) &&
    count(decoded.variantCount) && count(decoded.variantsShippingToUS) && typeof decoded.shipsToIncludesUS === "boolean" &&
    Array.isArray(decoded.printAreas) && decoded.printAreas.length <= 64 && decoded.printAreas.every((area) => sameKeys(area, ["name", "required"]) && NAME_TOKEN.test(area.name) && typeof area.required === "boolean") &&
    Array.isArray(decoded.defaultPrintAreaRecommendedPixelSizes) && decoded.defaultPrintAreaRecommendedPixelSizes.length <= 16 &&
    decoded.defaultPrintAreaRecommendedPixelSizes.every((entry) => sameKeys(entry, ["horizontal", "vertical"]) && Number.isFinite(entry.horizontal) && Number.isFinite(entry.vertical));
}

/** Provider-supplied names and values reach the receipt only when they are plain tokens; anything else is dropped to a count. */
function safeObservation(observation) {
  const names = observation.attributeNames.filter((name) => NAME_TOKEN.test(name));
  const finishes = observation.finishAttributeValues.filter((value) => VALUE_TOKEN.test(value));
  return {
    sku: observation.sku,
    decodedSha256: observation.decodedSha256,
    productDimensions: { width: observation.productDimensions.width, height: observation.productDimensions.height, units: VALUE_TOKEN.test(observation.productDimensions.units) ? observation.productDimensions.units : "unsafe" },
    attributeNames: names,
    finishAttributeValues: finishes,
    variantCount: observation.variantCount,
    variantsShippingToUS: observation.variantsShippingToUS,
    shipsToIncludesUS: observation.shipsToIncludesUS,
    printAreas: observation.printAreas.filter((area) => NAME_TOKEN.test(area.name)).map((area) => ({ name: area.name, required: area.required })),
    defaultPrintAreaRecommendedPixelSizes: observation.defaultPrintAreaRecommendedPixelSizes.map((entry) => ({ horizontal: entry.horizontal, vertical: entry.vertical }))
  };
}

// ---------------------------------------------------------------------------
// Preflight

function defaultGit() {
  const run = (args) => spawnSync("/usr/bin/git", ["-C", repositoryRoot, ...args], {
    encoding: "utf8", timeout: 15_000, env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }
  });
  const head = run(["rev-parse", "HEAD"]);
  const status = run(["status", "--porcelain"]);
  if (head.status !== 0 || status.status !== 0) return undefined;
  return { head: head.stdout.trim(), clean: status.stdout.trim() === "" };
}

const gate = (id, state, note) => ({ id, state, note });
const OK_STATES = new Set(["satisfied", "attested_only"]);

function referenceGate(id, value, note) {
  if (value === undefined) return gate(id, "missing", "not supplied");
  if (typeof value !== "string" || !REFERENCE_PATTERN.test(value)) return gate(id, "invalid", "not a well-formed opaque reference");
  return gate(id, "unverified", note);
}

function requestPlan() {
  return {
    method: "GET",
    origin: "https://api.sandbox.prodigi.com",
    path: "/v4.0/products/GLOBAL-PHO-4X6",
    url: "https://api.sandbox.prodigi.com/v4.0/products/GLOBAL-PHO-4X6",
    body: null,
    headersSent: ["X-API-Key (value never recorded)", "Accept: application/json"],
    maxProviderRequests: 1,
    retries: 0,
    redirect: "error",
    timeoutMs: TIMEOUT_MS,
    hardDeadlineEvenIfPortIgnoresAbort: true,
    maxResponseBytes: MAX_RESPONSE_BYTES,
    quote: false,
    orders: false,
    live: false
  };
}

async function evaluatePreflight(values, deps, libraryPresent) {
  const execArgv = deps.execArgv ?? process.execArgv;
  const gates = [];
  gates.push(gate("compiled_selection", "satisfied", "GLOBAL-PHO-4X6 / US / Standard, compiled in; no SKU, URL or host option exists"));
  gates.push(execArgv.some((argument) => argument.startsWith("--env-file"))
    ? gate("no_whole_env_file_loading", "invalid", "node --env-file loaded a whole .env into this process; export only PRODIGI_SANDBOX_API_KEY instead")
    : gate("no_whole_env_file_loading", "satisfied", "no --env-file"));
  gates.push(libraryPresent ? gate("package_build_present", "satisfied", "dist/index.js loads") : gate("package_build_present", "missing", "run npm run build"));

  const revision = values["source-revision"];
  if (revision === undefined) gates.push(gate("source_revision_immutable", "missing", "--source-revision <40 hex> of the reviewed merged main commit"));
  else if (!REVISION_PATTERN.test(revision)) gates.push(gate("source_revision_immutable", "invalid", "not a 40-hex commit"));
  else {
    const git = (deps.git ?? defaultGit)();
    if (git === undefined) gates.push(gate("source_revision_immutable", "unverified", "git state could not be read"));
    else if (git.head !== revision) gates.push(gate("source_revision_immutable", "invalid", "supplied revision is not the checked-out HEAD"));
    else if (git.clean !== true) gates.push(gate("source_revision_immutable", "invalid", "working tree is not clean"));
    else gates.push(gate("source_revision_immutable", "satisfied", "HEAD equals the supplied revision and the tree is clean; this does not verify the built dist/ or the compiled tuple (see unverifiedAssertions)"));
  }
  const packetHash = values["owner-packet-sha256"];
  gates.push(packetHash === undefined ? gate("owner_packet_sha256", "missing", "--owner-packet-sha256 of the packet the owner reviewed")
    : SHA256_PATTERN.test(packetHash) ? gate("owner_packet_sha256", "satisfied", "recorded in the receipt; not itself an approval")
      : gate("owner_packet_sha256", "invalid", "not a 64-hex digest"));

  const decision = referenceGate("decision_reference", values["decision-reference"], "");
  gates.push(decision.state === "unverified"
    ? gate("decision_reference", "attested_only", "operator attestation of the owner-delegated decision (0003 R1-R3); not account proof, terms or cost")
    : decision);
  const permission = referenceGate("owner_permission_reference", values["owner-permission-reference"], "supplied; a reference that exists is not authority");
  const terms = referenceGate("account_terms_reference", values["account-terms-reference"], "supplied; a reference that exists is not authority");
  const budget = referenceGate("request_cost_budget_reference", values["request-cost-budget-reference"], "supplied; request cost stays UNKNOWN, never zero");
  const receiptPath = values["receipt-path"];
  const location = receiptPath === undefined ? { ok: false, code: "missing" } : validateReceiptPath(receiptPath, deps.fs ?? fs);
  gates.push(receiptPath === undefined ? gate("receipt_path_outside_git", "missing", "--receipt-path /absolute/path/outside/every/git/worktree.json")
    : location.ok ? gate("receipt_path_outside_git", "satisfied", "absolute, normalized, no symlink, outside git, not .env-adjacent, does not exist; created exclusively (wx) only on execute")
      : gate("receipt_path_outside_git", "invalid", location.code));

  // The trusted host is the only thing that can turn a reference into authority.
  let grantExpiry = null;
  const references = [permission, terms, budget];
  const host = deps.host;
  if (host === undefined || host === null || typeof host.verifyProductReadGrant !== "function") {
    gates.push(gate("trusted_host_grant_verifier", "unavailable", "no trusted host supplies verifyProductReadGrant; this command line has none"));
  } else {
    gates.push(gate("trusted_host_grant_verifier", "satisfied", "a trusted host interface is present"));
    if (references.every((entry) => entry.state === "unverified") && location.ok) {
      const result = await verifyWithHost(host, buildGrantRequest(values));
      grantExpiry = result;
      const state = result === null ? "invalid" : "satisfied";
      const note = result === null ? "the trusted host did not verify the references" : "the trusted host verified the references";
      for (const entry of references) {
        entry.state = state;
        entry.note = note;
      }
    }
  }
  gates.push(...references);
  return { gates, grantExpiry, location };
}

function buildGrantRequest(values) {
  return Object.freeze({
    operation: "productDetails",
    providerId: "prodigi",
    apiVersion: "v4.0",
    credentialClass: "sandbox",
    decisionReference: values["decision-reference"],
    sku: "GLOBAL-PHO-4X6",
    destinationCountryCode: "US",
    shippingMethod: "Standard",
    method: "GET",
    url: "https://api.sandbox.prodigi.com/v4.0/products/GLOBAL-PHO-4X6",
    maxProviderRequests: 1,
    maxRetries: 0,
    ownerPermissionReference: values["owner-permission-reference"],
    accountTermsReference: values["account-terms-reference"],
    requestCostBudgetReference: values["request-cost-budget-reference"],
    receiptBinding: `sha256:${sha256Hex(values["receipt-path"])}`
  });
}

/** Returns the grant's expiry when the host verified this exact request, else null. Never throws. */
async function verifyWithHost(host, request) {
  try {
    const grant = await host.verifyProductReadGrant(request);
    if (grant === null || typeof grant !== "object") return null;
    for (const [key, value] of Object.entries(request)) if (grant[key] !== value) return null;
    if (grant.ownerPermissionVerified !== true || grant.accountTermsAccepted !== true || grant.requestCostBudgetApproved !== true || grant.singleUse !== true) return null;
    const expiry = typeof grant.expiresAt === "string" ? Date.parse(grant.expiresAt) : Number.NaN;
    return Number.isFinite(expiry) ? new Date(expiry).toISOString() : null;
  } catch {
    return null;
  }
}

/** What this command line does NOT establish, kept separate from the gates because no code path here can satisfy them. */
function unverifiedAssertions() {
  return [
    { id: "built_artifact_matches_source", state: "unverified", note: "dist/ is not compared with src/; the source-revision gate proves only that HEAD equals the supplied commit and the tree is clean" },
    { id: "compiled_tuple_verified_by_authority", state: "not_verified_operator_attestation_only", note: "GLOBAL-PHO-4X6 / US / Standard is compiled in from the owner-delegated decision; nothing here verifies it against a real authority, and HEAD does not verify it" },
    { id: "account_access", state: "not_asserted", note: "the key's presence or this read's success is not account proof; the public statement that sandbox orders are not charged says nothing about request cost or account permission" },
    { id: "request_cost", state: "UNKNOWN", note: "never assumed zero" },
    { id: "customer_authority", state: "none", note: "no customer approval, order, quote or bundle authority is created or implied" }
  ];
}

/** The interface a trusted host must implement; this command line cannot construct one. */
function trustedHostInterface() {
  return {
    method: "verifyProductReadGrant(request)",
    request: Object.keys(buildGrantRequest({ "decision-reference": "<ref>", "owner-permission-reference": "<ref>", "account-terms-reference": "<ref>", "request-cost-budget-reference": "<ref>", "receipt-path": "<path>" })),
    mustReturn: "the request echoed with ownerPermissionVerified, accountTermsAccepted, requestCostBudgetApproved and singleUse all true and an unexpired expiresAt",
    mustResolveWith: ["the owner's permission naming this one request", "the sandbox account terms the owner actually accepted", "the per-request cost budget"],
    notAuthority: ["a reference that merely exists", "an operator attestation boolean", "the presence of an API key"]
  };
}

function counters(extra = {}) {
  return { externalProviderCalls: 0, credentialReads: 0, networkRequests: 0, ...extra };
}

function preflightReport(mode, values, evaluation) {
  const execute = mode === "execute";
  const missing = evaluation.gates.filter((entry) => !OK_STATES.has(entry.state)).map((entry) => entry.id);
  if (execute && values["owner-approved"] !== true) missing.push("owner_approved_flag");
  return {
    schema: PRODUCT_READ_PREFLIGHT_SCHEMA,
    mode,
    execution: "NOT_EXECUTED",
    status: missing.length === 0 ? "PREFLIGHT_GATES_SATISFIED_NOT_EXECUTED" : "PREFLIGHT_REFUSED_GATES_MISSING",
    authorizesExecution: false,
    compiledSelection: { sku: "GLOBAL-PHO-4X6", destinationCountryCode: "US", shippingMethod: "Standard" },
    requestPlan: requestPlan(),
    gates: evaluation.gates,
    missingGates: missing,
    unverifiedAssertions: unverifiedAssertions(),
    trustedHostInterface: trustedHostInterface(),
    ...counters(),
    requestCost: "UNKNOWN",
    limits: [
      "Zero requests: no provider, network, key or environment access happened.",
      "A satisfied gate is not authority; only a trusted host's verification of the owner-action references is, and its absence blocks execution.",
      "A future successful read would prove only that the decoder accepted one provider response for this SKU at that moment: not account proof, terms, cost, a quote, an order, bundle eligibility, trim or customer-tier approval."
    ]
  };
}

// ---------------------------------------------------------------------------
// Run

function refusal(report, extra = {}) {
  return { exitCode: 2, output: { ...report, ...extra } };
}

/**
 * Parses `argv`, always evaluates the preflight, and executes the one read only
 * with `--execute --owner-approved` after every gate holds.
 *
 * `deps` (all optional): `host` (the trusted owner-action verifier), `env`
 * (read lazily, only for the single key, and only after the receipt exists),
 * `fetch`, `fs`, `git`, `execArgv`. Defaults are the real process.
 */
export async function runProductRead(argv, deps = {}) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: false }));
  } catch {
    return { exitCode: 2, output: { schema: PRODUCT_READ_PREFLIGHT_SCHEMA, execution: "NOT_EXECUTED", status: "REFUSED_UNKNOWN_OR_MALFORMED_OPTION", authorizesExecution: false, ...counters() } };
  }
  let library;
  try {
    library = await import("../dist/index.js");
  } catch {
    library = undefined;
  }
  const mode = values.execute === true ? "execute" : "preflight";
  const evaluation = await evaluatePreflight(values, deps, library !== undefined);
  const report = preflightReport(mode, values, evaluation);
  if (mode === "preflight") return { exitCode: report.missingGates.length === 0 ? 0 : 2, output: report };
  if (report.missingGates.length > 0) return refusal({ ...report, status: "REFUSED_GATES_MISSING" });
  return executeRead(values, deps, library, evaluation, report);
}

async function executeRead(values, deps, library, evaluation, report) {
  const fsApi = deps.fs ?? fs;
  const receiptPath = values["receipt-path"];
  // 1. The receipt location is claimed exclusively BEFORE the key is read or any request exists.
  let fd;
  try {
    fd = fsApi.openSync(receiptPath, "wx", 0o600);
    const info = fsApi.fstatSync(fd);
    const link = fsApi.lstatSync(receiptPath);
    if (!info.isFile() || info.nlink !== 1 || !link.isFile() || link.isSymbolicLink() || fsApi.realpathSync(receiptPath) !== receiptPath) throw new Error("unsafe receipt");
  } catch (error) {
    if (fd !== undefined) try { fsApi.closeSync(fd); } catch { /* the unsafe file stays for the owner to inspect */ }
    return refusal({ ...report, status: "REFUSED_RECEIPT_NOT_EXCLUSIVE", missingGates: ["receipt_path_outside_git"], receiptError: typeof error?.code === "string" ? error.code : "unsafe_receipt" });
  }
  const startedAt = new Date().toISOString();
  const base = {
    schema: PRODUCT_READ_RECEIPT_SCHEMA,
    sourceRevision: values["source-revision"],
    ownerPacketSha256: values["owner-packet-sha256"],
    refs: {
      decision: values["decision-reference"],
      ownerPermission: values["owner-permission-reference"],
      accountTerms: values["account-terms-reference"],
      requestCostBudget: values["request-cost-budget-reference"]
    }
  };
  const writeReceipt = (content) => {
    const text = `${JSON.stringify(content, null, 2)}\n`;
    fsApi.ftruncateSync(fd, 0);
    fsApi.writeSync(fd, text, 0);
    fsApi.fsyncSync(fd);
  };
  // A crash after this point leaves an in-flight record, not a clean slate: the request may have been dispatched.
  writeReceipt({ ...base, status: "in_flight_dispatch_unknown", recordedAt: startedAt });

  let lastKey = "";
  let keyReads = 0;
  const narrowEnv = Object.create(null);
  Object.defineProperty(narrowEnv, "PRODIGI_SANDBOX_API_KEY", {
    enumerable: true,
    get: () => {
      keyReads += 1;
      const value = (deps.env ?? process.env).PRODIGI_SANDBOX_API_KEY;
      if (typeof value === "string") lastKey = value;
      return value;
    }
  });
  const transport = library.createOneShotProdigiProductReadPort(library.createProdigiProductReadFetchPort(deps.fetch ?? globalThis.fetch));
  const selection = library.PRODIGI_SANDBOX_PRODUCT_READ_SELECTION;
  const decisionReference = values["decision-reference"];
  const client = new library.ProdigiSandboxClient({
    http: transport.port,
    secrets: library.createEnvServerSecretSource({ bindings: [library.PRODIGI_SANDBOX_SECRET_BINDING], env: narrowEnv }),
    decision: { decisionReference, ...selection },
    decisionVerifier: {
      // Attests only the compiled, owner-delegated tuple. It does NOT confirm account access.
      async verify(request) {
        if (request.sku !== selection.sku || request.destinationCountryCode !== selection.destinationCountryCode ||
            request.shippingMethod !== selection.shippingMethod || request.decisionReference !== decisionReference) return undefined;
        return { ...request, productAndDestinationApproved: true, sandboxAccountAccessConfirmed: false };
      }
    },
    productReadGrantVerifier: { verify: (request) => deps.host.verifyProductReadGrant(request) },
    sandboxCallsEnabled: true,
    timeoutMs: TIMEOUT_MS
  });
  const begin = performance.now();
  let observation = null;
  let failure = null;
  try {
    const details = await client.getProductDetails({
      ownerPermissionReference: values["owner-permission-reference"],
      accountTermsReference: values["account-terms-reference"],
      requestCostBudgetReference: values["request-cost-budget-reference"],
      receiptBinding: `sha256:${sha256Hex(receiptPath)}`
    });
    observation = safeObservation(library.projectProductReadObservation(details));
  } catch (error) {
    failure = {
      errorCode: ERROR_CODES.has(error?.code) ? error.code : "unexpected_failure",
      sideEffectState: ["not_dispatched", "possible", "confirmed", "unknown"].includes(error?.sideEffectState) ? error.sideEffectState : null,
      httpStatus: Number.isSafeInteger(error?.httpStatus) ? error.httpStatus : null
    };
  }
  const elapsedMs = Math.max(0, Math.round(performance.now() - begin));
  const snapshot = transport.snapshot();
  // The request count comes from the transport that carried it, never from the client's error classification.
  const receipt = {
    ...base,
    request: {
      method: "GET", origin: "https://api.sandbox.prodigi.com", path: "/v4.0/products/GLOBAL-PHO-4X6",
      attempts: snapshot.attempts, dispatched: snapshot.dispatched, refused: snapshot.refused,
      retries: 0, redirect: "error", timeoutMs: TIMEOUT_MS, maxProviderRequests: 1
    },
    outcome: {
      status: failure === null ? "ok" : "failed",
      httpStatus: failure === null ? snapshot.responseStatus : (failure.httpStatus ?? snapshot.responseStatus),
      errorCode: failure === null ? null : failure.errorCode,
      sideEffectState: failure === null ? null : failure.sideEffectState,
      elapsedMs,
      responseBytes: snapshot.responseBytes
    },
    decoded: observation,
    // Verified by the trusted host at the gate stage; the client verifies again just before the key is read.
    trustedHostGrant: { verified: true, expiresAt: evaluation.grantExpiry },
    attestations: {
      decisionVerifier: "operator_attestation_only", keyPresence: "name_only_never_proof", accountAccess: "NOT_ASSERTED_ONLY_OBSERVED_BY_THIS_ONE_READ",
      accountTerms: "NOT_VERIFIED_BY_THIS_RECEIPT", builtArtifact: "NOT_VERIFIED_AGAINST_SOURCE", requestCost: "UNKNOWN", authorityIssued: false, quoteAuthority: false, orderAuthority: false,
      bundleEligible: false, trimOrTierApproval: false, customerApproval: false
    },
    recordedAt: new Date().toISOString()
  };
  const problems = validateProductReadReceipt(receipt, { forbiddenText: [lastKey] });
  let written = false;
  try {
    if (problems.length > 0) {
      writeReceipt({ ...base, status: "receipt_rejected_unsafe_after_dispatch_attempt", dispatched: snapshot.dispatched, recordedAt: receipt.recordedAt });
    } else {
      writeReceipt(receipt);
      written = true;
    }
  } catch {
    written = false;
  } finally {
    try { fsApi.closeSync(fd); } catch { /* nothing to recover */ }
  }
  const ok = failure === null && problems.length === 0 && written;
  return {
    exitCode: ok ? 0 : 1,
    output: {
      schema: PRODUCT_READ_RECEIPT_SCHEMA,
      execution: "EXECUTED",
      status: ok ? "ok" : "failed",
      receiptWritten: written,
      receiptProblems: problems,
      ...counters({ externalProviderCalls: snapshot.dispatched, credentialReads: keyReads, networkRequests: snapshot.dispatched }),
      receipt: problems.length === 0 ? receipt : null
    }
  };
}

// Compare real paths: Node resolves symlinks for the entry module, so a symlinked invocation path must still run
// (a CLI that silently does nothing and exits 0 would read as success).
function isMainModule() {
  if (process.argv[1] === undefined) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const result = await runProductRead(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result.output, null, 2)}\n`);
  process.exitCode = result.exitCode;
}
