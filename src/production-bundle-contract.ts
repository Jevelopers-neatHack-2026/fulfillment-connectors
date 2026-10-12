/**
 * Owner-free contract for the ProductionBundle consumer (FC-08, fulfillment-connectors #10).
 *
 * This module is imported by the runtime and exported from the package root, so it MUST NOT import the owner
 * package (`@jevelopers/shared-contracts`): importing `dist/index.js` never loads the owner validators.
 *
 * What lives here: the host ports, the report shape, the FROZEN critical-criteria table, the module-private gate
 * brand and the runtime-side report validator. The report type can only express integrity observations:
 * `eligibility` is the literal "blocked" and `authorityIssued`, `accepted` and `handoffEligible` are the
 * literal `false`. Nothing here, and nothing a caller supplies, can express approved, eligible or accepted.
 *
 * Criterion severity is a constant table. There is no policy, option, flag or environment variable that
 * selects which criteria are critical.
 */
import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";
import type { ProviderMode, SubmitQuoteTerms, TrustedScope } from "./types.js";

export const PRODUCTION_BUNDLE_REPORT_VERSION = "fulfillment-production-bundle-report/1" as const;
export const PRODUCTION_BUNDLE_VALIDATOR_VERSION = "fulfillment-production-bundle-validator/1" as const;
export const PRODUCTION_BUNDLE_GATE_KIND = "fulfillment-production-bundle-gate/1" as const;
export const TRUSTED_COMMITMENT_DIGEST_KEY = "trusted-commitment.json" as const;

/** Exact owner package pin. Tests re-derive every field from the vendored archive bytes. */
export const OWNER_PACKAGE_PIN = Object.freeze({
  name: "@jevelopers/shared-contracts",
  version: "0.9.7",
  archiveFile: "vendor/shared-contracts/jevelopers-shared-contracts-0.9.7.tgz",
  archiveSha256: "771a9f565ea9df87a4c08e6e6d5ede422d2a5926182a95be082dc8ed7b8c4c43",
  integrity: "sha512-P462b8thg20g5RknBzdDL5mfxpXF+kpodLPCGrTe3kmKXrw9YZ21x3E/PuGEp0aEOGoiBZlq5JB4Pktq+2lBPg==",
  sourceRepository: "Jevelopers-neatHack-2026/shared-contracts",
  sourceRevision: "d432ad5c895a67155affeaa05cd8423c758d95c3",
  accepted: false
} as const);

// ---------------------------------------------------------------------------------------------------------
// Host ports. Both are injected by the host and are independent of each other and of the command envelope.
// ---------------------------------------------------------------------------------------------------------

export interface ProductionBundleAnchorProvenance {
  readonly kind: "development_fixture";
  readonly digest: string;
}

export interface PublicationRequest {
  readonly trustedScope: TrustedScope;
  /** The owner `bundle_ref.content_hash` the command named. A lookup key only; never an anchor. */
  readonly bundleDigest: string;
  /** Aborted at the deadline. A port that ignores it can keep allocating (documented PBR-25 limit). */
  readonly signal: AbortSignal;
}

export type PublicationResult =
  | {
      readonly status: "published";
      readonly bundleDigest: string;
      /** The independent pin for the trusted outer `ProductionBundleRef` bytes. */
      readonly commitment: { readonly length: number; readonly sha256: string };
      readonly provenance: ProductionBundleAnchorProvenance;
    }
  | { readonly status: "unpublished" };

/** Resolves the trust anchor from `trustedScope + bundleDigest` only, independently of the byte store. */
export interface ProductionBundlePublicationSource {
  resolve(request: PublicationRequest): Promise<PublicationResult>;
}

export interface ByteReadRequest {
  readonly trustedScope: TrustedScope;
  readonly role: "commitment" | "file";
  readonly filename: string;
  /** Content address: the owner `byte_hash` (or the publication pin for the commitment). */
  readonly byteHash: string;
  /** The store must not return more than this many bytes. */
  readonly maxLength: number;
  readonly signal: AbortSignal;
}

export type ByteReadResult =
  | { readonly status: "found"; readonly bytes: Uint8Array }
  | { readonly status: "missing" };

/** Bounded, content-addressed byte reads. Results are treated as untrusted and copied before use. */
export interface ProductionBundleByteSource {
  read(request: ByteReadRequest): Promise<ByteReadResult>;
}

// ---------------------------------------------------------------------------------------------------------
// Criteria: a frozen table.
// ---------------------------------------------------------------------------------------------------------

export type CriterionState =
  | "verified_owner"
  | "verified_local"
  | "declared_not_observed"
  | "not_observed"
  | "unsupported"
  | "blocked"
  | "failed";

export type CriterionId =
  | "anchor_resolution"
  | "byte_custody"
  | "owner_integrity"
  | "observed_geometry_consistency"
  | "owner_eligibility"
  | "approval_exact_preview"
  | "provider_required_files"
  | "surfaces"
  | "provider_dimensions_units"
  | "bleed_safe_trim"
  | "provider_options"
  | "personalization"
  | "materials_color"
  | "minimum_dpi_vs_spec"
  | "capability_identity"
  | "preflight_vs_capability"
  | "quote_contract"
  | "quantity_limit"
  | "destination_shipping"
  | "artifact_access_expiry"
  | "rights_terms"
  | "stale_spec"
  | "row_scope"
  | "accepted_pins"
  | "authorization_terms_binding"
  | "capability_version_binding"
  | "provider_fetched_bytes_immutability"
  | "png_pixels"
  | "png_effective_dpi"
  | "png_phys_metadata"
  | "pdf_svg_signature"
  | "pdf_svg_geometry";

export interface CriterionDefinition {
  readonly id: CriterionId;
  readonly critical: boolean;
  readonly allowedStates: readonly CriterionState[];
  /** Criteria whose state/code are constant: nothing in this repository can verify them with owner 0.9.7. */
  readonly fixed: { readonly state: CriterionState; readonly code: string } | null;
}

const VERIFIED: readonly CriterionState[] = Object.freeze(["verified_owner", "verified_local"]);
const isVerified = (state: CriterionState): boolean => VERIFIED.includes(state);

function dynamic(id: CriterionId, critical: boolean, ...allowedStates: CriterionState[]): CriterionDefinition {
  return Object.freeze({ id, critical, allowedStates: Object.freeze(allowedStates), fixed: null });
}
function fixed(id: CriterionId, critical: boolean, state: CriterionState, code: string): CriterionDefinition {
  return Object.freeze({ id, critical, allowedStates: Object.freeze([state]), fixed: Object.freeze({ state, code }) });
}

/**
 * Order is part of the contract. Every report carries exactly these ids in exactly this order.
 * `critical: true` means: while the criterion is not verified, dispatch beyond a labelled no-effect simulation
 * is impossible. The fixed rows can never be verified by this repository against owner 0.9.7.
 */
export const PRODUCTION_BUNDLE_CRITERIA: readonly CriterionDefinition[] = Object.freeze([
  dynamic("anchor_resolution", true, "verified_local", "failed", "not_observed"),
  dynamic("byte_custody", true, "verified_local", "failed", "not_observed"),
  dynamic("owner_integrity", true, "verified_owner", "failed", "not_observed"),
  dynamic("observed_geometry_consistency", true, "verified_local", "failed", "not_observed"),
  fixed("owner_eligibility", true, "blocked", "OWNER_ACCEPTANCE_PENDING"),
  fixed("approval_exact_preview", true, "blocked", "APPROVAL_PATH_OWNER_BLOCKED"),
  fixed("provider_required_files", true, "blocked", "PRINTSPEC_BYTES_UNAVAILABLE"),
  fixed("surfaces", true, "blocked", "PRINTSPEC_BYTES_UNAVAILABLE"),
  fixed("provider_dimensions_units", true, "blocked", "PRINTSPEC_BYTES_UNAVAILABLE"),
  fixed("bleed_safe_trim", true, "blocked", "PRINTSPEC_BYTES_UNAVAILABLE"),
  fixed("provider_options", true, "blocked", "PRINTSPEC_BYTES_UNAVAILABLE"),
  fixed("personalization", true, "blocked", "PRINTSPEC_BYTES_UNAVAILABLE"),
  fixed("materials_color", true, "blocked", "PRINTSPEC_BYTES_UNAVAILABLE"),
  fixed("minimum_dpi_vs_spec", true, "blocked", "PRINTSPEC_BYTES_UNAVAILABLE"),
  fixed("capability_identity", true, "blocked", "CAPABILITY_SNAPSHOT_UNAVAILABLE"),
  fixed("preflight_vs_capability", true, "blocked", "HOST_TRUST_REFS_ABSENT"),
  fixed("quote_contract", true, "blocked", "QUOTE_CONTRACT_UNACCEPTED"),
  fixed("quantity_limit", true, "unsupported", "PROVIDER_QUANTITY_LIMIT_UNREPRESENTED"),
  fixed("destination_shipping", true, "unsupported", "DESTINATION_UNRESOLVED"),
  fixed("artifact_access_expiry", true, "unsupported", "ARTIFACT_ACCESS_UNREPRESENTED"),
  fixed("rights_terms", true, "unsupported", "RIGHTS_TERMS_UNREPRESENTED"),
  fixed("stale_spec", true, "blocked", "NO_SECOND_SPEC_REVISION"),
  fixed("row_scope", true, "blocked", "ROW_SCOPE_UNPINNED"),
  fixed("accepted_pins", true, "blocked", "ACCEPTED_PINS_ABSENT"),
  dynamic("authorization_terms_binding", true, "blocked", "failed", "not_observed"),
  fixed("capability_version_binding", true, "blocked", "CAPABILITY_VERSION_ENCODING_UNMAPPED"),
  fixed("provider_fetched_bytes_immutability", true, "blocked", "HOST_ACCESS_CONTRACT_ABSENT"),
  dynamic("png_pixels", false, "verified_local", "failed", "not_observed"),
  dynamic("png_effective_dpi", false, "verified_local", "failed", "not_observed"),
  dynamic("png_phys_metadata", false, "verified_local", "failed", "not_observed"),
  dynamic("pdf_svg_signature", false, "verified_local", "failed", "not_observed"),
  fixed("pdf_svg_geometry", false, "declared_not_observed", "PDF_SVG_GEOMETRY_UNOBSERVED")
]);

const CRITERION_BY_ID: ReadonlyMap<string, CriterionDefinition> = new Map(PRODUCTION_BUNDLE_CRITERIA.map((definition) => [definition.id, definition]));

export function criterionDefinition(id: string): CriterionDefinition | undefined {
  return CRITERION_BY_ID.get(id);
}

export interface CriterionResult {
  readonly id: CriterionId;
  readonly state: CriterionState;
  readonly critical: boolean;
  /** null only for verified states */
  readonly code: string | null;
}

/** Sorted, de-duplicated codes of every critical criterion that is not verified (failed ones included). */
export function openCriticalCodes(criteria: readonly CriterionResult[]): readonly string[] {
  const codes = new Set<string>();
  for (const criterion of criteria) {
    if (criterion.critical && !isVerified(criterion.state) && criterion.code !== null) codes.add(criterion.code);
  }
  return Object.freeze([...codes].sort());
}

// ---------------------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------------------

export type ProductionBundleVerdict = "integrity_failed" | "integrity_passed_blocked";
export type TermsBindingDiagnostic = "matched_development_fixture" | "mismatch" | "source_absent" | "source_missing_fields" | "source_failed";

export interface ProductionBundleReport {
  readonly reportVersion: typeof PRODUCTION_BUNDLE_REPORT_VERSION;
  readonly verdict: ProductionBundleVerdict;
  readonly eligibility: "blocked";
  readonly authorityIssued: false;
  readonly accepted: false;
  readonly handoffEligible: false;
  readonly openCriticalCodes: readonly string[];
  readonly criteria: readonly CriterionResult[];
  readonly bundle: { readonly hash: string; readonly id: string; readonly revision: number } | null;
  readonly anchor: { readonly provenance: ProductionBundleAnchorProvenance; readonly commitmentSha256: string } | null;
  readonly owner: {
    readonly package: typeof OWNER_PACKAGE_PIN.name;
    readonly version: typeof OWNER_PACKAGE_PIN.version;
    readonly archiveSha256: typeof OWNER_PACKAGE_PIN.archiveSha256;
    readonly integrity: typeof OWNER_PACKAGE_PIN.integrity;
    readonly accepted: false;
    readonly codes: readonly string[];
  };
  /** Declared by the (owner-verified) manifest and NOT verified against any PrintSpec bytes. */
  readonly specRef:
    | { readonly state: "declared_by_manifest_unverified"; readonly contentHash: string }
    | { readonly state: "blocked"; readonly code: string };
  readonly consumer: { readonly revision: string | null; readonly validatorVersion: typeof PRODUCTION_BUNDLE_VALIDATOR_VERSION };
  readonly evaluatedAt: string;
  readonly inputDigests: Readonly<Record<string, string>>;
  readonly outputDigests: Readonly<Record<string, string>>;
  readonly unchanged: boolean;
  readonly setDigest: string;
  readonly reportDigest: string;
  readonly diagnostic?: {
    readonly reasons?: readonly string[];
    readonly attribution?: { readonly authoritative: false; readonly problems: readonly string[] } | "unattributed";
    readonly termsBinding?: TermsBindingDiagnostic;
  };
}

/** The only evidence the runtime attaches to a response. It can only say "blocked". */
export interface ProductionBundleEvidence {
  readonly simulation: "no_effect_simulation";
  readonly verdict: "integrity_passed_blocked";
  readonly eligibility: "blocked";
  readonly authorityIssued: false;
  readonly accepted: false;
  readonly handoffEligible: false;
  readonly openCriticalCodes: readonly string[];
  readonly bundleDigest: string;
  readonly reportDigest: string;
}

// ---------------------------------------------------------------------------------------------------------
// Gate: immutable, branded, created only by `createProductionBundleGate`.
// ---------------------------------------------------------------------------------------------------------

export interface ProductionBundleGateRequest {
  readonly trustedScope: TrustedScope;
  /** The owner bundle hash named by the command. A lookup key only. */
  readonly bundleDigest: string;
  readonly providerId: string;
  /** Derived by the RUNTIME from its own state, never from the envelope or a caller option. */
  readonly runtimeMode: ProviderMode;
  readonly transportMode: ProviderMode;
  readonly quote: SubmitQuoteTerms;
  /** `command.productionBundle`: untrusted. Only an owner-shaped reference that disagrees with the digest matters. */
  readonly envelopeBundle: unknown;
}

export interface ProductionBundleGate {
  readonly kind: typeof PRODUCTION_BUNDLE_GATE_KIND;
  checkBeforeSubmit(request: ProductionBundleGateRequest): Promise<ProductionBundleReport>;
  recheckBeforeDispatch(request: ProductionBundleGateRequest): Promise<ProductionBundleReport>;
}

const genuineGates = new WeakSet<object>();

/**
 * Registers a gate as genuine and freezes it. Only `createProductionBundleGate` calls this; it is not re-exported
 * from `index.ts` and the package `exports` map blocks deep imports. The brand is a tripwire against unreviewed
 * or accidental gate objects, NOT a defence against a hostile in-process host: the real guarantees are the
 * unconditional non-simulated hard block and the runtime's report validation below.
 */
export function sealGenuineProductionBundleGate<T extends ProductionBundleGate>(gate: T): T {
  Object.freeze(gate);
  genuineGates.add(gate);
  return gate;
}

export function isGenuineProductionBundleGate(candidate: unknown): candidate is ProductionBundleGate {
  return typeof candidate === "object" && candidate !== null && genuineGates.has(candidate) && Object.isFrozen(candidate);
}

// ---------------------------------------------------------------------------------------------------------
// Digests and report validation (used by the runtime before it records anything a gate returned)
// ---------------------------------------------------------------------------------------------------------

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const REASON = /^[A-Z0-9_:.-]{1,96}$/;
const PROBLEM = /^(?:hash-mismatch|missing|extra|length-mismatch):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FILENAME_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const isSha256Digest = (value: unknown): value is string => typeof value === "string" && SHA256.test(value);

/** Deterministic JSON for THIS module's own report/set digests. It is not an owner canonical form. */
export function stableStringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => {
      const item = record[key];
      if (item === undefined) throw new TypeError("undefined member");
      return `${JSON.stringify(key)}:${stableStringify(item)}`;
    }).join(",")}}`;
  }
  throw new TypeError("unsupported value");
}

export const sha256Digest = (bytes: Uint8Array | string): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** Digest of the sorted filename -> sha256 map: the immutable-bytes fingerprint compared at dispatch. */
export function computeSetDigest(digests: Readonly<Record<string, string>>): string {
  const entries = Object.keys(digests).sort().map((name) => [name, digests[name]]);
  return sha256Digest(stableStringify(entries));
}

/** Digest over the report body (every member except `reportDigest`). A material change yields a new digest. */
export function computeReportDigest(report: Omit<ProductionBundleReport, "reportDigest"> | ProductionBundleReport): string {
  const body: Record<string, unknown> = { ...(report as unknown as Record<string, unknown>) };
  delete body["reportDigest"];
  return sha256Digest(stableStringify(body));
}

type Rec = Readonly<Record<string, unknown>>;

function dataRecord(value: unknown, keys: readonly string[], optionalKeys: readonly string[] = []): Rec | null {
  if (value === null || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const own = Reflect.ownKeys(value);
  if (own.length > keys.length + optionalKeys.length) return null;
  const out: Record<string, unknown> = {};
  for (const key of own) {
    if (typeof key !== "string" || (!keys.includes(key) && !optionalKeys.includes(key))) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) return null;
    out[key] = descriptor.value;
  }
  for (const key of keys) if (!Object.hasOwn(out, key)) return null;
  return out;
}

function dataArray(value: unknown, maxLength: number): readonly unknown[] | null {
  if (!Array.isArray(value) || utilTypes.isProxy(value)) return null;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value > maxLength) return null;
  const out: unknown[] = [];
  for (let index = 0; index < (lengthDescriptor.value as number); index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) return null;
    out.push(descriptor.value);
  }
  return out;
}

function digestMap(value: unknown): Readonly<Record<string, string>> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) return null;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return null;
  const own = Reflect.ownKeys(value);
  if (own.length > 101) return null;
  const out: Record<string, string> = {};
  for (const key of own) {
    if (typeof key !== "string" || (!FILENAME_KEY.test(key))) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !isSha256Digest(descriptor.value)) return null;
    out[key] = descriptor.value;
  }
  return Object.freeze(out);
}

export type GateReportValidation =
  | { readonly ok: true; readonly report: ProductionBundleReport }
  | { readonly ok: false; readonly reason: string };

/**
 * The runtime calls this on every report a gate returns BEFORE it records evidence or acts on it. Exact keys,
 * literal flags, the frozen criteria table (ids, order, severity, fixed states and codes), recomputed open
 * critical codes, digest formats, anchor provenance, set/report digests and the command-bound bundle hash are
 * all re-checked. A gate that claims eligibility, adds a key, omits a criterion or lies about a digest fails.
 */
export function validateGateReport(candidate: unknown, expected: { readonly bundleDigest: string }): GateReportValidation {
  const bad = (reason: string): GateReportValidation => ({ ok: false, reason });
  try {
    const top = dataRecord(candidate, [
      "reportVersion", "verdict", "eligibility", "authorityIssued", "accepted", "handoffEligible", "openCriticalCodes", "criteria", "bundle", "anchor",
      "owner", "specRef", "consumer", "evaluatedAt", "inputDigests", "outputDigests", "unchanged", "setDigest", "reportDigest"
    ], ["diagnostic"]);
    if (top === null) return bad("REPORT_SHAPE");
    if (top["reportVersion"] !== PRODUCTION_BUNDLE_REPORT_VERSION) return bad("REPORT_VERSION");
    const verdict = top["verdict"];
    if (verdict !== "integrity_failed" && verdict !== "integrity_passed_blocked") return bad("REPORT_VERDICT");
    if (top["eligibility"] !== "blocked" || top["authorityIssued"] !== false || top["accepted"] !== false || top["handoffEligible"] !== false) return bad("REPORT_LITERALS");

    const criteriaRaw = dataArray(top["criteria"], PRODUCTION_BUNDLE_CRITERIA.length);
    if (criteriaRaw === null || criteriaRaw.length !== PRODUCTION_BUNDLE_CRITERIA.length) return bad("REPORT_CRITERIA_COUNT");
    const criteria: CriterionResult[] = [];
    for (let index = 0; index < criteriaRaw.length; index += 1) {
      const definition = PRODUCTION_BUNDLE_CRITERIA[index]!;
      const item = dataRecord(criteriaRaw[index], ["id", "state", "critical", "code"]);
      if (item === null || item["id"] !== definition.id || item["critical"] !== definition.critical) return bad("REPORT_CRITERION_SHAPE");
      const state = item["state"] as CriterionState;
      if (typeof state !== "string" || !definition.allowedStates.includes(state)) return bad("REPORT_CRITERION_STATE");
      const code = item["code"];
      if (isVerified(state) ? code !== null : (typeof code !== "string" || !REASON.test(code))) return bad("REPORT_CRITERION_CODE");
      if (definition.fixed !== null && (state !== definition.fixed.state || code !== definition.fixed.code)) return bad("REPORT_FIXED_CRITERION");
      criteria.push(Object.freeze({ id: definition.id, state, critical: definition.critical, code: code as string | null }));
    }
    const open = openCriticalCodes(criteria);
    const reportedOpen = dataArray(top["openCriticalCodes"], 64);
    if (reportedOpen === null || reportedOpen.length !== open.length || reportedOpen.some((code, index) => code !== open[index])) return bad("REPORT_OPEN_CODES");
    const failed = criteria.some((criterion) => criterion.state === "failed");

    let bundle: ProductionBundleReport["bundle"] = null;
    if (top["bundle"] !== null) {
      const b = dataRecord(top["bundle"], ["hash", "id", "revision"]);
      if (b === null || !isSha256Digest(b["hash"]) || typeof b["id"] !== "string" || b["id"].length < 1 || b["id"].length > 128 || !Number.isSafeInteger(b["revision"])) return bad("REPORT_BUNDLE");
      bundle = Object.freeze({ hash: b["hash"], id: b["id"], revision: b["revision"] as number });
    }
    let anchor: ProductionBundleReport["anchor"] = null;
    if (top["anchor"] !== null) {
      const a = dataRecord(top["anchor"], ["provenance", "commitmentSha256"]);
      const p = a === null ? null : dataRecord(a["provenance"], ["kind", "digest"]);
      if (a === null || p === null || p["kind"] !== "development_fixture" || !isSha256Digest(p["digest"]) || !isSha256Digest(a["commitmentSha256"])) return bad("REPORT_ANCHOR");
      anchor = Object.freeze({ provenance: Object.freeze({ kind: "development_fixture" as const, digest: p["digest"] }), commitmentSha256: a["commitmentSha256"] });
    }

    const ownerRaw = dataRecord(top["owner"], ["package", "version", "archiveSha256", "integrity", "accepted", "codes"]);
    const ownerCodes = ownerRaw === null ? null : dataArray(ownerRaw["codes"], 32);
    if (ownerRaw === null || ownerCodes === null || ownerRaw["package"] !== OWNER_PACKAGE_PIN.name || ownerRaw["version"] !== OWNER_PACKAGE_PIN.version ||
        ownerRaw["archiveSha256"] !== OWNER_PACKAGE_PIN.archiveSha256 || ownerRaw["integrity"] !== OWNER_PACKAGE_PIN.integrity || ownerRaw["accepted"] !== false ||
        ownerCodes.some((code) => typeof code !== "string" || !REASON.test(code))) return bad("REPORT_OWNER");

    let specRef: ProductionBundleReport["specRef"];
    const specDeclared = dataRecord(top["specRef"], ["state", "contentHash"]);
    if (specDeclared !== null) {
      if (specDeclared["state"] !== "declared_by_manifest_unverified" || !isSha256Digest(specDeclared["contentHash"])) return bad("REPORT_SPEC_REF");
      specRef = Object.freeze({ state: "declared_by_manifest_unverified" as const, contentHash: specDeclared["contentHash"] });
    } else {
      const specBlocked = dataRecord(top["specRef"], ["state", "code"]);
      if (specBlocked === null || specBlocked["state"] !== "blocked" || typeof specBlocked["code"] !== "string" || !REASON.test(specBlocked["code"])) return bad("REPORT_SPEC_REF");
      specRef = Object.freeze({ state: "blocked" as const, code: specBlocked["code"] });
    }

    const consumer = dataRecord(top["consumer"], ["revision", "validatorVersion"]);
    if (consumer === null || consumer["validatorVersion"] !== PRODUCTION_BUNDLE_VALIDATOR_VERSION ||
        !(consumer["revision"] === null || (typeof consumer["revision"] === "string" && /^[0-9a-f]{7,64}$/.test(consumer["revision"])))) return bad("REPORT_CONSUMER");
    if (typeof top["evaluatedAt"] !== "string" || !UTC_TIME.test(top["evaluatedAt"])) return bad("REPORT_TIME");

    const inputDigests = digestMap(top["inputDigests"]);
    const outputDigests = digestMap(top["outputDigests"]);
    if (inputDigests === null || outputDigests === null || typeof top["unchanged"] !== "boolean") return bad("REPORT_DIGESTS");
    if (!isSha256Digest(top["setDigest"]) || top["setDigest"] !== computeSetDigest(inputDigests)) return bad("REPORT_SET_DIGEST");
    const unchangedActual = stableStringify(inputDigests) === stableStringify(outputDigests);
    if (top["unchanged"] !== unchangedActual) return bad("REPORT_UNCHANGED");

    let diagnostic: ProductionBundleReport["diagnostic"];
    if (Object.hasOwn(top, "diagnostic")) {
      const d = dataRecord(top["diagnostic"], [], ["reasons", "attribution", "termsBinding"]);
      if (d === null) return bad("REPORT_DIAGNOSTIC");
      const out: { reasons?: readonly string[]; attribution?: { readonly authoritative: false; readonly problems: readonly string[] } | "unattributed"; termsBinding?: TermsBindingDiagnostic } = {};
      if (Object.hasOwn(d, "reasons")) {
        const reasons = dataArray(d["reasons"], 64);
        if (reasons === null || reasons.some((reason) => typeof reason !== "string" || !REASON.test(reason))) return bad("REPORT_DIAGNOSTIC");
        out.reasons = Object.freeze(reasons as string[]);
      }
      if (Object.hasOwn(d, "attribution")) {
        const attribution = d["attribution"];
        if (attribution === "unattributed") out.attribution = "unattributed";
        else {
          const a = dataRecord(attribution, ["authoritative", "problems"]);
          const problems = a === null ? null : dataArray(a["problems"], 128);
          if (a === null || problems === null || a["authoritative"] !== false || problems.some((problem) => typeof problem !== "string" || !PROBLEM.test(problem))) return bad("REPORT_DIAGNOSTIC");
          out.attribution = Object.freeze({ authoritative: false as const, problems: Object.freeze(problems as string[]) });
        }
      }
      if (Object.hasOwn(d, "termsBinding")) {
        const t = d["termsBinding"];
        if (t !== "matched_development_fixture" && t !== "mismatch" && t !== "source_absent" && t !== "source_missing_fields" && t !== "source_failed") return bad("REPORT_DIAGNOSTIC");
        out.termsBinding = t;
      }
      diagnostic = Object.freeze(out);
    }

    if (verdict === "integrity_passed_blocked") {
      // A passing verdict is only coherent with verified integrity criteria, no failed criterion and the command-bound hash.
      const byId = new Map(criteria.map((criterion) => [criterion.id, criterion]));
      if (failed || bundle === null || anchor === null || bundle.hash !== expected.bundleDigest ||
          !isVerified(byId.get("anchor_resolution")!.state) || !isVerified(byId.get("byte_custody")!.state) ||
          byId.get("owner_integrity")!.state !== "verified_owner" || !isVerified(byId.get("observed_geometry_consistency")!.state) ||
          ownerCodes.length !== 0 || !unchangedActual) return bad("REPORT_PASS_INCOHERENT");
    } else if (!failed && criteria.every((criterion) => !criterion.critical || criterion.state !== "not_observed")) {
      // A failed verdict must name at least one failed or unobserved critical integrity criterion.
      return bad("REPORT_FAIL_INCOHERENT");
    }

    const report: ProductionBundleReport = Object.freeze({
      reportVersion: PRODUCTION_BUNDLE_REPORT_VERSION,
      verdict,
      eligibility: "blocked" as const,
      authorityIssued: false as const,
      accepted: false as const,
      handoffEligible: false as const,
      openCriticalCodes: open,
      criteria: Object.freeze(criteria),
      bundle,
      anchor,
      owner: Object.freeze({
        package: OWNER_PACKAGE_PIN.name,
        version: OWNER_PACKAGE_PIN.version,
        archiveSha256: OWNER_PACKAGE_PIN.archiveSha256,
        integrity: OWNER_PACKAGE_PIN.integrity,
        accepted: false as const,
        codes: Object.freeze(ownerCodes as string[])
      }),
      specRef,
      consumer: Object.freeze({ revision: consumer["revision"] as string | null, validatorVersion: PRODUCTION_BUNDLE_VALIDATOR_VERSION }),
      evaluatedAt: top["evaluatedAt"],
      inputDigests,
      outputDigests,
      unchanged: unchangedActual,
      setDigest: top["setDigest"],
      reportDigest: top["reportDigest"] as string,
      ...(diagnostic === undefined ? {} : { diagnostic })
    });
    if (!isSha256Digest(top["reportDigest"]) || top["reportDigest"] !== computeReportDigest(report)) return bad("REPORT_DIGEST");
    return { ok: true, report };
  } catch {
    return bad("REPORT_VALIDATION_THREW");
  }
}

/**
 * A report that fails AFTER an earlier pass means the bundle bytes no longer verify (`bundle_changed`) when the owner
 * rejected them or a file is missing/wrong-length; any other failure (store error, deadline, anchor problem, snapshot
 * rejection) is operational and fails closed as `bundle_invalid`.
 */
export function classifyRecheckFailure(report: ProductionBundleReport): "bundle_changed" | "bundle_invalid" {
  const custody = report.criteria.find((criterion) => criterion.id === "byte_custody");
  const integrity = report.criteria.find((criterion) => criterion.id === "owner_integrity");
  if (integrity?.state === "failed") return "bundle_changed";
  if (custody?.state === "failed" && (custody.code === "BYTE_MISSING" || custody.code === "BYTE_LENGTH_MISMATCH")) return "bundle_changed";
  return "bundle_invalid";
}

export function evidenceFromReport(report: ProductionBundleReport): ProductionBundleEvidence {
  return Object.freeze({
    simulation: "no_effect_simulation" as const,
    verdict: "integrity_passed_blocked" as const,
    eligibility: "blocked" as const,
    authorityIssued: false as const,
    accepted: false as const,
    handoffEligible: false as const,
    openCriticalCodes: report.openCriticalCodes,
    bundleDigest: report.bundle === null ? "" : report.bundle.hash,
    reportDigest: report.reportDigest
  });
}
