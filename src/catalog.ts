import { CONTRACT_OWNERSHIP } from "./contracts.js";
import type { BoundaryFailure, BoundaryResult, ContractValidator, TrustedScope } from "./types.js";

/**
 * Private connector development shape. This is not a shared-contracts schema,
 * accepted version, provider adapter, or statement of provider support.
 */
export const CATALOG_DEVELOPMENT_FORMAT = "connector-development-catalog/1" as const;
export const CATALOG_SNAPSHOT_FORMAT = "connector-development-catalog-snapshot/1" as const;

export type CatalogEvidenceMode =
  | "synthetic_fixture"
  | "documentation_reference"
  | "account_observation"
  | "unverified_import";

export type CatalogReasonCode =
  | "not_exposed"
  | "not_in_source"
  | "not_confirmed"
  | "outside_scope"
  | "provider_declares_unsupported";

export type CatalogConstraint<T> =
  | { readonly state: "known"; readonly value: T }
  | { readonly state: "unknown"; readonly reasonCode: CatalogReasonCode }
  | { readonly state: "unsupported"; readonly reasonCode: CatalogReasonCode };

export type LengthUnit = "mm" | "cm" | "in";

export interface CatalogDimensionsInput {
  readonly width: string;
  readonly height: string;
  readonly depth: string;
  readonly unit: LengthUnit;
}

export interface CatalogInsetsInput {
  readonly top: string;
  readonly right: string;
  readonly bottom: string;
  readonly left: string;
  readonly unit: LengthUnit;
}

export interface CatalogFileSupportInput {
  readonly types: readonly string[];
  readonly minimumCount: number;
  readonly maximumCount: number;
}

export interface CatalogColorSupportInput {
  readonly spaces: readonly string[];
  readonly profiles: readonly string[];
}

export interface CatalogPersonalizationInput {
  readonly modes: readonly string[];
  readonly maximumFields: number;
  readonly maximumCharactersPerField: number;
}

export interface CatalogDestinationRuleInput {
  readonly countryCode: string;
  readonly regions: CatalogConstraint<readonly string[]>;
}

export interface CatalogShippingRuleInput {
  readonly countryCode: string;
  readonly regionCode: string | null;
  readonly methods: readonly string[];
}

export interface CatalogProductConstraintsInput {
  readonly dimensions: CatalogConstraint<CatalogDimensionsInput>;
  readonly minimumBleed: CatalogConstraint<CatalogInsetsInput>;
  readonly minimumSafeArea: CatalogConstraint<CatalogInsetsInput>;
  readonly minimumResolutionDpi: CatalogConstraint<number>;
  readonly surfaces: CatalogConstraint<readonly string[]>;
  readonly files: CatalogConstraint<CatalogFileSupportInput>;
  readonly color: CatalogConstraint<CatalogColorSupportInput>;
  readonly options: CatalogConstraint<readonly string[]>;
  readonly materials: CatalogConstraint<readonly string[]>;
  readonly personalization: CatalogConstraint<CatalogPersonalizationInput>;
  readonly destinations: CatalogConstraint<readonly CatalogDestinationRuleInput[]>;
  readonly shipping: CatalogConstraint<readonly CatalogShippingRuleInput[]>;
}

export interface ProviderCatalogInput {
  readonly localFormat: typeof CATALOG_DEVELOPMENT_FORMAT;
  readonly providerId: string;
  readonly apiVersion: string;
  readonly catalogVersion: string;
  readonly source: {
    readonly reference: string;
    readonly revision: string;
    readonly retrievedAt: string;
    readonly evidenceMode: CatalogEvidenceMode;
    readonly evidenceReference: string;
  };
  readonly freshness: { readonly maximumAgeSeconds: number };
  readonly products: readonly {
    readonly sku: string;
    readonly variantId: string;
    readonly availability: "available" | "removed";
    readonly constraints: CatalogProductConstraintsInput;
    readonly providerAttributes: Readonly<Record<string, unknown>>;
  }[];
}

export interface CatalogDimensions {
  readonly widthNm: string;
  readonly heightNm: string;
  readonly depthNm: string;
  readonly unit: "nm";
}

export interface CatalogInsets {
  readonly topNm: string;
  readonly rightNm: string;
  readonly bottomNm: string;
  readonly leftNm: string;
  readonly unit: "nm";
}

export interface CatalogFileSupport {
  readonly types: readonly string[];
  readonly minimumCount: number;
  readonly maximumCount: number;
}

export interface CatalogColorSupport {
  readonly spaces: readonly string[];
  readonly profiles: readonly string[];
}

export interface CatalogPersonalization {
  readonly modes: readonly string[];
  readonly maximumFields: number;
  readonly maximumCharactersPerField: number;
}

export interface CatalogDestinationRule {
  readonly countryCode: string;
  readonly regions: CatalogConstraint<readonly string[]>;
}

export interface CatalogShippingRule {
  readonly countryCode: string;
  readonly regionCode: string | null;
  readonly methods: readonly string[];
}

export interface CatalogProductConstraints {
  readonly dimensions: CatalogConstraint<CatalogDimensions>;
  readonly minimumBleed: CatalogConstraint<CatalogInsets>;
  readonly minimumSafeArea: CatalogConstraint<CatalogInsets>;
  readonly minimumResolutionDpi: CatalogConstraint<number>;
  readonly surfaces: CatalogConstraint<readonly string[]>;
  readonly files: CatalogConstraint<CatalogFileSupport>;
  readonly color: CatalogConstraint<CatalogColorSupport>;
  readonly options: CatalogConstraint<readonly string[]>;
  readonly materials: CatalogConstraint<readonly string[]>;
  readonly personalization: CatalogConstraint<CatalogPersonalization>;
  readonly destinations: CatalogConstraint<readonly CatalogDestinationRule[]>;
  readonly shipping: CatalogConstraint<readonly CatalogShippingRule[]>;
}

export interface CatalogProductSnapshot {
  readonly sku: string;
  readonly variantId: string;
  readonly availability: "available" | "removed";
  readonly constraints: CatalogProductConstraints;
  readonly providerAttributes: Readonly<Record<string, unknown>>;
  readonly specIdentity: string;
}

export interface CatalogSnapshot {
  readonly localFormat: typeof CATALOG_SNAPSHOT_FORMAT;
  readonly providerId: string;
  readonly apiVersion: string;
  readonly catalogVersion: string;
  readonly source: ProviderCatalogInput["source"];
  readonly freshness: {
    readonly maximumAgeSeconds: number;
    readonly freshUntil: string;
  };
  readonly catalogContentIdentity: string;
  readonly snapshotIdentity: string;
  readonly products: readonly CatalogProductSnapshot[];
}

export interface CatalogSource {
  /** Read-only capability source. Implementations must not quote or submit. */
  readCatalogSnapshot(): Promise<unknown>;
}

export interface CatalogSelectionInput {
  readonly snapshotIdentity: string;
  readonly catalogContentIdentity: string;
  readonly sku: string;
  readonly variantId: string;
  readonly specIdentity: string;
  readonly dimensions: CatalogDimensionsInput;
  readonly bleed: CatalogInsetsInput;
  readonly safeArea: CatalogInsetsInput;
  readonly effectiveResolutionDpi: number;
  readonly surface: string;
  readonly fileType: string;
  readonly fileCount: number;
  readonly colorSpace: string;
  readonly colorProfile: string;
  readonly options: readonly string[];
  readonly materials: readonly string[];
  readonly personalization: null | {
    readonly mode: string;
    readonly fields: readonly { readonly name: string; readonly characterCount: number }[];
  };
  readonly destination: { readonly countryCode: string; readonly regionCode?: string };
  readonly shippingMethod: string;
}

export type CatalogSelectionStatus = "eligible" | "ineligible" | "revalidation_required";

export type CatalogSelectionReason =
  | "catalog_input_invalid"
  | "catalog_clock_invalid"
  | "catalog_clock_before_retrieval"
  | "catalog_stale"
  | "sku_not_found"
  | "sku_removed"
  | "spec_identity_changed"
  | "snapshot_binding_mismatch"
  | "unknown_mandatory_constraint"
  | "unsupported_mandatory_constraint"
  | "contradictory_catalog_constraints"
  | "selection_incompatible"
  | "selection_input_invalid";

export interface CatalogSelectionResult {
  readonly status: CatalogSelectionStatus;
  readonly eligible: boolean;
  readonly providerId: string;
  readonly snapshotIdentity: string;
  readonly catalogContentIdentity: string;
  readonly sku: string;
  readonly variantId: string;
  readonly specIdentity?: string;
  readonly reasons: readonly CatalogSelectionReason[];
  readonly details: readonly string[];
  readonly requiredActions: readonly ("refresh_catalog" | "revalidate" | "requote" | "reapprove")[];
}

const MAX_CATALOG_PRODUCTS = 200;
const MAX_FRESHNESS_SECONDS = 31_536_000;
const MAX_SAFE_TREE_NODES = 20_000;
const MAX_SAFE_TREE_DEPTH = 16;
const MAX_SAFE_STRING_LENGTH = 4_096;
const MAX_TOTAL_INPUT_BYTES = 1_000_000;
const MAX_PROVIDER_ATTRIBUTE_BYTES = 32_000;
const MAX_NANOMETRES = 2_000_000_000n;
const REASON_CODES = new Set<CatalogReasonCode>([
  "not_exposed", "not_in_source", "not_confirmed", "outside_scope", "provider_declares_unsupported"
]);
const EVIDENCE_MODES = new Set<CatalogEvidenceMode>([
  "synthetic_fixture", "documentation_reference", "account_observation", "unverified_import"
]);
const FORBIDDEN_ATTRIBUTE_KEY = /(?:authorization|credential|secret|token|password|email|phone|address|street|recipient|customer|contact|postal.?code|zip.?code|signed.?url|access.?key|api.?key)/i;
const URL_OR_EMAIL = /(?:https?:\/\/|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b)/i;
const PHONE_LIKE = /(?:^|\D)\+?\d[\d\s().-]{8,}\d(?:\D|$)/u;
const ADDRESS_LIKE = /\b\d{1,6}\s+[A-Za-z0-9.' -]{2,64}\s(?:street|st|road|rd|avenue|ave|boulevard|blvd|lane|ln|drive|dr)\b/i;
const SECRET_LIKE = /(?:\bbearer\s+[A-Za-z0-9._~-]{8,}|\bsk-[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]+PRIVATE KEY-----)/i;
const OPAQUE_REFERENCE = /^[A-Za-z][A-Za-z0-9._+-]{0,31}:[A-Za-z0-9][A-Za-z0-9._:/#-]{0,223}$/;
const SAFE_CODE = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/;
const FILE_TYPE = /^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}\/[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/;
const COUNTRY_CODE = /^[A-Z]{2}$/;
const REGION_CODE = /^[A-Z0-9][A-Z0-9-]{0,15}$/;

type PlainRecord = Record<string, unknown>;
class CatalogInputError extends Error {}

function fail(): never {
  throw new CatalogInputError("invalid catalog input");
}

function ownDataValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) return fail();
  return descriptor.value;
}

function safeTree(value: unknown, depth = 0, seen = new WeakSet<object>(), budget = { nodes: 0, bytes: 0 }): unknown {
  budget.nodes += 1;
  if (budget.nodes > MAX_SAFE_TREE_NODES || depth > MAX_SAFE_TREE_DEPTH) return fail();
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > MAX_SAFE_STRING_LENGTH || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)) return fail();
    budget.bytes += new TextEncoder().encode(value).byteLength;
    if (budget.bytes > MAX_TOTAL_INPUT_BYTES) return fail();
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) return fail();
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value) || value.length > 2_000) return fail();
    seen.add(value);
    const copy: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) copy.push(safeTree(ownDataValue(value, String(index)), depth + 1, seen, budget));
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length") continue;
      if (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length) return fail();
    }
    seen.delete(value);
    return copy;
  }
  if (typeof value !== "object") return fail();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return fail();
  if (seen.has(value)) return fail();
  seen.add(value);
  const copy: PlainRecord = Object.create(null) as PlainRecord;
  const keys = Reflect.ownKeys(value);
  if (keys.length > 1_000) return fail();
  for (const key of keys) {
    if (typeof key !== "string" || key.length === 0 || key.length > 128) return fail();
    const child = safeTree(ownDataValue(value, key), depth + 1, seen, budget);
    Object.defineProperty(copy, key, { value: child, enumerable: true, configurable: true, writable: true });
  }
  seen.delete(value);
  return copy;
}

function record(value: unknown): PlainRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail();
  return value as PlainRecord;
}

function exactKeys(value: PlainRecord, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) if (!Object.prototype.hasOwnProperty.call(value, key)) fail();
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail();
}

function text(value: unknown, maximum = 256): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.trim() !== value) return fail();
  if (/[\u0000-\u001F\u007F]/u.test(value)) return fail();
  return value;
}

function safeCode(value: unknown): string {
  const result = text(value, 128);
  if (!SAFE_CODE.test(result)) return fail();
  return result;
}

function opaqueReference(value: unknown): string {
  const result = text(value, 256);
  if (!OPAQUE_REFERENCE.test(result) || /(?:https?:|\?|=|%)/iu.test(result) || URL_OR_EMAIL.test(result) || PHONE_LIKE.test(result)) return fail();
  return result;
}

function safeInteger(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) return fail();
  return value;
}

function canonicalTimestamp(value: unknown): { readonly text: string; readonly epochMs: number } {
  const timestamp = text(value, 24);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(timestamp)) return fail();
  const epochMs = Date.parse(timestamp);
  if (!Number.isSafeInteger(epochMs) || new Date(epochMs).toISOString() !== timestamp) return fail();
  return { text: timestamp, epochMs };
}

function unit(value: unknown): LengthUnit {
  if (value !== "mm" && value !== "cm" && value !== "in") return fail();
  return value;
}

/** Parse at most 3 fractional digits and convert without floating arithmetic. */
function exactNanometres(value: unknown, selectedUnit: LengthUnit, allowZero: boolean): string {
  const decimal = text(value, 24);
  if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,3})?$/u.test(decimal)) return fail();
  const [wholeText = "0", fractionText = ""] = decimal.split(".");
  const scale = selectedUnit === "mm" ? 1_000_000n : selectedUnit === "cm" ? 10_000_000n : 25_400_000n;
  const denominator = 10n ** BigInt(fractionText.length);
  const fractionalNumerator = fractionText.length === 0 ? 0n : BigInt(fractionText) * scale;
  if (fractionalNumerator % denominator !== 0n) return fail();
  const result = BigInt(wholeText) * scale + fractionalNumerator / denominator;
  if ((!allowZero && result <= 0n) || (allowZero && result < 0n) || result > MAX_NANOMETRES) return fail();
  return result.toString(10);
}

function normalizeDimensions(value: unknown): CatalogDimensions {
  const input = record(value);
  exactKeys(input, ["width", "height", "depth", "unit"]);
  const selectedUnit = unit(input.unit);
  return Object.freeze({
    widthNm: exactNanometres(input.width, selectedUnit, false),
    heightNm: exactNanometres(input.height, selectedUnit, false),
    depthNm: exactNanometres(input.depth, selectedUnit, false),
    unit: "nm"
  });
}

function normalizeInsets(value: unknown): CatalogInsets {
  const input = record(value);
  exactKeys(input, ["top", "right", "bottom", "left", "unit"]);
  const selectedUnit = unit(input.unit);
  return Object.freeze({
    topNm: exactNanometres(input.top, selectedUnit, true),
    rightNm: exactNanometres(input.right, selectedUnit, true),
    bottomNm: exactNanometres(input.bottom, selectedUnit, true),
    leftNm: exactNanometres(input.left, selectedUnit, true),
    unit: "nm"
  });
}

function sortedSet(value: unknown, maximumItems: number, maximumLength: number, pattern: RegExp = SAFE_CODE): readonly string[] {
  if (!Array.isArray(value) || value.length > maximumItems) return fail();
  const values = value.map((item) => {
    const code = text(item, maximumLength);
    if (!pattern.test(code)) return fail();
    return code;
  });
  if (new Set(values).size !== values.length) return fail();
  return Object.freeze(values.sort((left, right) => left < right ? -1 : left > right ? 1 : 0));
}

function normalizeConstraint<T>(value: unknown, normalizeKnown: (known: unknown) => T): CatalogConstraint<T> {
  const input = record(value);
  const state = input.state;
  if (state === "known") {
    exactKeys(input, ["state", "value"]);
    return Object.freeze({ state, value: normalizeKnown(input.value) });
  }
  if (state === "unknown" || state === "unsupported") {
    exactKeys(input, ["state", "reasonCode"]);
    if (typeof input.reasonCode !== "string" || !REASON_CODES.has(input.reasonCode as CatalogReasonCode)) return fail();
    return Object.freeze({ state, reasonCode: input.reasonCode as CatalogReasonCode });
  }
  return fail();
}

function normalizeFiles(value: unknown): CatalogFileSupport {
  const input = record(value);
  exactKeys(input, ["types", "minimumCount", "maximumCount"]);
  const types = sortedSet(input.types, 32, 128, FILE_TYPE);
  const minimumCount = safeInteger(input.minimumCount, 1, 100);
  const maximumCount = safeInteger(input.maximumCount, 1, 100);
  if (types.length === 0 || minimumCount > maximumCount) return fail();
  return Object.freeze({ types, minimumCount, maximumCount });
}

function normalizeColor(value: unknown): CatalogColorSupport {
  const input = record(value);
  exactKeys(input, ["spaces", "profiles"]);
  const spaces = sortedSet(input.spaces, 32, 128);
  const profiles = sortedSet(input.profiles, 64, 256);
  if (spaces.length === 0 || profiles.length === 0) return fail();
  return Object.freeze({ spaces, profiles });
}

function normalizePersonalization(value: unknown): CatalogPersonalization {
  const input = record(value);
  exactKeys(input, ["modes", "maximumFields", "maximumCharactersPerField"]);
  const modes = sortedSet(input.modes, 32, 128);
  const maximumFields = safeInteger(input.maximumFields, 0, 500);
  const maximumCharactersPerField = safeInteger(input.maximumCharactersPerField, 0, 10_000);
  if ((modes.length === 0) !== (maximumFields === 0) || (modes.length === 0) !== (maximumCharactersPerField === 0)) return fail();
  return Object.freeze({ modes, maximumFields, maximumCharactersPerField });
}

function normalizeCountryCode(value: unknown): string {
  if (typeof value !== "string" || !COUNTRY_CODE.test(value)) return fail();
  return value;
}

function normalizeRegionCode(value: unknown): string {
  if (typeof value !== "string" || !REGION_CODE.test(value)) return fail();
  return value;
}

function normalizeDestinationRule(value: unknown): CatalogDestinationRule {
  const input = record(value);
  exactKeys(input, ["countryCode", "regions"]);
  return Object.freeze({
    countryCode: normalizeCountryCode(input.countryCode),
    regions: normalizeConstraint(input.regions, (regions) => sortedSet(regions, 512, 16, REGION_CODE))
  });
}

function normalizeDestinations(value: unknown): readonly CatalogDestinationRule[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) return fail();
  const rules = value.map(normalizeDestinationRule).sort((left, right) => left.countryCode < right.countryCode ? -1 : left.countryCode > right.countryCode ? 1 : 0);
  if (new Set(rules.map((item) => item.countryCode)).size !== rules.length) return fail();
  return Object.freeze(rules);
}

function normalizeShippingRule(value: unknown): CatalogShippingRule {
  const input = record(value);
  exactKeys(input, ["countryCode", "regionCode", "methods"]);
  const regionCode = input.regionCode === null ? null : normalizeRegionCode(input.regionCode);
  const methods = sortedSet(input.methods, 64, 128);
  if (methods.length === 0) return fail();
  return Object.freeze({ countryCode: normalizeCountryCode(input.countryCode), regionCode, methods });
}

function normalizeShipping(value: unknown): readonly CatalogShippingRule[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1_000) return fail();
  const rules = value.map(normalizeShippingRule).sort((left, right) => {
    const a = `${left.countryCode}\u0000${left.regionCode ?? ""}`;
    const b = `${right.countryCode}\u0000${right.regionCode ?? ""}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const ids = rules.map((item) => `${item.countryCode}\u0000${item.regionCode ?? ""}`);
  if (new Set(ids).size !== ids.length) return fail();
  return Object.freeze(rules);
}

function safeProviderAttributes(value: unknown): Readonly<Record<string, unknown>> {
  const attributes = record(value);
  if (Object.keys(attributes).length > 64) return fail();
  for (const key of Object.keys(attributes)) {
    if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u.test(key) || FORBIDDEN_ATTRIBUTE_KEY.test(key)) return fail();
  }
  const serialized = stableJson(attributes);
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > MAX_PROVIDER_ATTRIBUTE_BYTES) return fail();
  const scan = (entry: unknown): void => {
    if (typeof entry === "string" && (URL_OR_EMAIL.test(entry) || PHONE_LIKE.test(entry) || ADDRESS_LIKE.test(entry) || SECRET_LIKE.test(entry))) fail();
    if (Array.isArray(entry)) for (const child of entry) scan(child);
    else if (entry !== null && typeof entry === "object") {
      for (const [key, child] of Object.entries(entry)) {
        if (FORBIDDEN_ATTRIBUTE_KEY.test(key)) fail();
        scan(child);
      }
    }
  };
  scan(attributes);
  return deepFreeze(attributes);
}

function normalizeConstraints(value: unknown): CatalogProductConstraints {
  const input = record(value);
  const keys = [
    "dimensions", "minimumBleed", "minimumSafeArea", "minimumResolutionDpi", "surfaces", "files", "color",
    "options", "materials", "personalization", "destinations", "shipping"
  ];
  exactKeys(input, keys);
  const normalized: CatalogProductConstraints = {
    dimensions: normalizeConstraint(input.dimensions, normalizeDimensions),
    minimumBleed: normalizeConstraint(input.minimumBleed, normalizeInsets),
    minimumSafeArea: normalizeConstraint(input.minimumSafeArea, normalizeInsets),
    minimumResolutionDpi: normalizeConstraint(input.minimumResolutionDpi, (dpi) => safeInteger(dpi, 1, 100_000)),
    surfaces: normalizeConstraint(input.surfaces, (items) => sortedSet(items, 32, 128)),
    files: normalizeConstraint(input.files, normalizeFiles),
    color: normalizeConstraint(input.color, normalizeColor),
    options: normalizeConstraint(input.options, (items) => sortedSet(items, 128, 128)),
    materials: normalizeConstraint(input.materials, (items) => sortedSet(items, 128, 128)),
    personalization: normalizeConstraint(input.personalization, normalizePersonalization),
    destinations: normalizeConstraint(input.destinations, normalizeDestinations),
    shipping: normalizeConstraint(input.shipping, normalizeShipping)
  };
  assertNoContradictions(normalized);
  return deepFreeze(normalized);
}

function compareBigInt(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function assertNoContradictions(constraints: CatalogProductConstraints): void {
  if (constraints.surfaces.state === "known" && constraints.surfaces.value.length === 0) fail();
  if (constraints.materials.state === "known" && constraints.materials.value.length === 0) fail();
  if (constraints.files.state === "known" && constraints.files.value.types.length === 0) fail();
  if (constraints.color.state === "known" && (constraints.color.value.spaces.length === 0 || constraints.color.value.profiles.length === 0)) fail();
  if (constraints.dimensions.state === "known" && constraints.minimumSafeArea.state === "known") {
    const { widthNm, heightNm } = constraints.dimensions.value;
    const safe = constraints.minimumSafeArea.value;
    if (BigInt(safe.leftNm) + BigInt(safe.rightNm) >= BigInt(widthNm) || BigInt(safe.topNm) + BigInt(safe.bottomNm) >= BigInt(heightNm)) fail();
  }
  if (constraints.destinations.state === "known") {
    const countries = new Set(constraints.destinations.value.map((rule) => rule.countryCode));
    if (countries.size === 0) fail();
    if (constraints.shipping.state === "known" && constraints.shipping.value.some((rule) => !countries.has(rule.countryCode))) fail();
  }
}

function normalizeProduct(value: unknown): Omit<CatalogProductSnapshot, "specIdentity"> {
  const input = record(value);
  exactKeys(input, ["sku", "variantId", "availability", "constraints", "providerAttributes"]);
  if (input.availability !== "available" && input.availability !== "removed") return fail();
  const normalized = {
    sku: safeCode(input.sku),
    variantId: safeCode(input.variantId),
    availability: input.availability,
    constraints: normalizeConstraints(input.constraints),
    providerAttributes: safeProviderAttributes(input.providerAttributes)
  } as const;
  return deepFreeze(normalized);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  const recordValue = value as PlainRecord;
  const keys = Object.keys(recordValue).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(recordValue[key])}`).join(",")}}`;
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableJson(value));
  if (bytes.byteLength > MAX_TOTAL_INPUT_BYTES * 4) return fail();
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (item) => item.toString(16).padStart(2, "0")).join("")}`;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value as object)) return value;
  seen.add(value as object);
  for (const child of Object.values(value as PlainRecord)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function frozenOwnedCopy<T>(value: T): T {
  return deepFreeze(safeTree(value) as T);
}

function normalizeSource(value: unknown): ProviderCatalogInput["source"] {
  const input = record(value);
  exactKeys(input, ["reference", "revision", "retrievedAt", "evidenceMode", "evidenceReference"]);
  if (typeof input.evidenceMode !== "string" || !EVIDENCE_MODES.has(input.evidenceMode as CatalogEvidenceMode)) return fail();
  const retrieved = canonicalTimestamp(input.retrievedAt);
  return Object.freeze({
    reference: opaqueReference(input.reference),
    revision: opaqueReference(input.revision),
    retrievedAt: retrieved.text,
    evidenceMode: input.evidenceMode as CatalogEvidenceMode,
    evidenceReference: opaqueReference(input.evidenceReference)
  });
}

/** Pure offline normalizer for one provider-supplied private catalog snapshot. */
export async function normalizeCatalogSnapshot(input: unknown): Promise<CatalogSnapshot> {
  try {
    const copied = safeTree(input);
    if (new TextEncoder().encode(stableJson(copied)).byteLength > MAX_TOTAL_INPUT_BYTES) return fail();
    const root = record(copied);
    exactKeys(root, ["localFormat", "providerId", "apiVersion", "catalogVersion", "source", "freshness", "products"]);
    if (root.localFormat !== CATALOG_DEVELOPMENT_FORMAT) return fail();
    const providerId = safeCode(root.providerId);
    const apiVersion = safeCode(root.apiVersion);
    const catalogVersion = safeCode(root.catalogVersion);
    const source = normalizeSource(root.source);
    const freshnessInput = record(root.freshness);
    exactKeys(freshnessInput, ["maximumAgeSeconds"]);
    const maximumAgeSeconds = safeInteger(freshnessInput.maximumAgeSeconds, 1, MAX_FRESHNESS_SECONDS);
    const sourceTime = canonicalTimestamp(source.retrievedAt);
    const freshUntilEpochMs = sourceTime.epochMs + maximumAgeSeconds * 1_000;
    if (!Number.isSafeInteger(freshUntilEpochMs) || freshUntilEpochMs > 253_402_300_799_999) return fail();
    const freshUntil = new Date(freshUntilEpochMs).toISOString();
    if (!Array.isArray(root.products) || root.products.length === 0 || root.products.length > MAX_CATALOG_PRODUCTS) return fail();
    const unversionedProducts = root.products.map(normalizeProduct).sort((left, right) => {
      const a = `${left.sku}\u0000${left.variantId}`;
      const b = `${right.sku}\u0000${right.variantId}`;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    const productIds = unversionedProducts.map((product) => `${product.sku}\u0000${product.variantId}`);
    if (new Set(productIds).size !== productIds.length) return fail();
    const products: CatalogProductSnapshot[] = [];
    for (const product of unversionedProducts) {
      const identity = await sha256({
        providerId,
        apiVersion,
        sku: product.sku,
        variantId: product.variantId,
        availability: product.availability,
        constraints: product.constraints,
        providerAttributes: product.providerAttributes
      });
      products.push(deepFreeze({ ...product, specIdentity: identity }));
    }
    const catalogContentIdentity = await sha256({
      providerId,
      apiVersion,
      catalogVersion,
      source: { reference: source.reference, revision: source.revision },
      products
    });
    const snapshotIdentity = await sha256({
      catalogContentIdentity,
      source,
      freshness: { maximumAgeSeconds, freshUntil }
    });
    const result: CatalogSnapshot = {
      localFormat: CATALOG_SNAPSHOT_FORMAT,
      providerId,
      apiVersion,
      catalogVersion,
      source,
      freshness: Object.freeze({ maximumAgeSeconds, freshUntil }),
      catalogContentIdentity,
      snapshotIdentity,
      products: Object.freeze(products)
    };
    return deepFreeze(result);
  } catch {
    throw new TypeError("Catalog snapshot is invalid or outside the supported private development shape.");
  }
}

/** Calls exactly one injected read-only source operation, then normalizes its copy. */
export async function discoverCatalogSnapshot(source: CatalogSource): Promise<CatalogSnapshot> {
  return (await captureCatalogSnapshot(source)).snapshot;
}

/** Private development capture: both projections must use this single owned input, never reread the source. */
export async function captureCatalogSnapshot(source: CatalogSource): Promise<{
  readonly input: ProviderCatalogInput;
  readonly snapshot: CatalogSnapshot;
}> {
  if (source === null || typeof source !== "object") {
    throw new TypeError("A read-only catalog source is required.");
  }
  let readCatalogSnapshot: CatalogSource["readCatalogSnapshot"];
  try {
    readCatalogSnapshot = source.readCatalogSnapshot;
  } catch {
    throw new TypeError("Catalog source could not supply a supported private development capture.");
  }
  if (typeof readCatalogSnapshot !== "function") {
    throw new TypeError("A read-only catalog source is required.");
  }
  let input: unknown;
  try {
    input = frozenOwnedCopy(await Reflect.apply(readCatalogSnapshot, source, []));
  } catch {
    throw new TypeError("Catalog source could not supply a supported private development capture.");
  }
  const snapshot = await normalizeCatalogSnapshot(input);
  return Object.freeze({ input: input as ProviderCatalogInput, snapshot });
}

type NormalizedCatalogSelection = Omit<CatalogSelectionInput, "dimensions" | "bleed" | "safeArea"> & {
  readonly dimensions: CatalogDimensions;
  readonly bleed: CatalogInsets;
  readonly safeArea: CatalogInsets;
};

function normalizeSelection(input: unknown): NormalizedCatalogSelection {
  const value = record(safeTree(input));
  exactKeys(value, [
    "snapshotIdentity", "catalogContentIdentity", "sku", "variantId", "specIdentity", "dimensions", "bleed", "safeArea",
    "effectiveResolutionDpi", "surface", "fileType", "fileCount", "colorSpace", "colorProfile", "options", "materials",
    "personalization", "destination", "shippingMethod"
  ]);
  const dimensionInput = record(value.dimensions);
  const bleedInput = record(value.bleed);
  const safeAreaInput = record(value.safeArea);
  const destinationInput = record(value.destination);
  exactKeys(destinationInput, ["countryCode"], ["regionCode"]);
  const personalizationInput = value.personalization === null ? null : record(value.personalization);
  let personalization: NormalizedCatalogSelection["personalization"] = null;
  if (personalizationInput !== null) {
    exactKeys(personalizationInput, ["mode", "fields"]);
    if (!Array.isArray(personalizationInput.fields) || personalizationInput.fields.length > 500) return fail();
    const fields = personalizationInput.fields.map((entry) => {
      const field = record(entry);
      exactKeys(field, ["name", "characterCount"]);
      const name = safeCode(field.name);
      if (FORBIDDEN_ATTRIBUTE_KEY.test(name)) return fail();
      return Object.freeze({ name, characterCount: safeInteger(field.characterCount, 0, 10_000) });
    });
    if (new Set(fields.map((field) => field.name)).size !== fields.length) return fail();
    personalization = Object.freeze({ mode: safeCode(personalizationInput.mode), fields: Object.freeze(fields) });
  }
  const snapshotIdentity = text(value.snapshotIdentity, 80);
  const catalogContentIdentity = text(value.catalogContentIdentity, 80);
  const specIdentity = text(value.specIdentity, 80);
  const identityPattern = /^sha256:[a-f0-9]{64}$/u;
  if (!identityPattern.test(snapshotIdentity) || !identityPattern.test(catalogContentIdentity) || !identityPattern.test(specIdentity)) return fail();
  return deepFreeze({
    snapshotIdentity,
    catalogContentIdentity,
    sku: safeCode(value.sku),
    variantId: safeCode(value.variantId),
    specIdentity,
    dimensions: normalizeDimensions(dimensionInput),
    bleed: normalizeInsets(bleedInput),
    safeArea: normalizeInsets(safeAreaInput),
    effectiveResolutionDpi: safeInteger(value.effectiveResolutionDpi, 1, 100_000),
    surface: safeCode(value.surface),
    fileType: (() => { const fileType = text(value.fileType, 128); if (!FILE_TYPE.test(fileType)) return fail(); return fileType; })(),
    fileCount: safeInteger(value.fileCount, 1, 100),
    colorSpace: safeCode(value.colorSpace),
    colorProfile: safeCode(value.colorProfile),
    options: sortedSet(value.options, 128, 128),
    materials: sortedSet(value.materials, 128, 128),
    personalization,
    destination: Object.freeze({
      countryCode: normalizeCountryCode(destinationInput.countryCode),
      ...(destinationInput.regionCode === undefined ? {} : { regionCode: normalizeRegionCode(destinationInput.regionCode) })
    }),
    shippingMethod: safeCode(value.shippingMethod)
  });
}

function requiredState<T>(value: CatalogConstraint<T>, name: string, reasons: CatalogSelectionReason[], details: string[]): T | undefined {
  if (value.state === "known") return value.value;
  reasons.push(value.state === "unknown" ? "unknown_mandatory_constraint" : "unsupported_mandatory_constraint");
  details.push(`${name}:${value.state}`);
  return undefined;
}

function contains<T>(values: readonly T[], value: T): boolean {
  return values.includes(value);
}

function routeForDestination(
  constraints: CatalogProductConstraints,
  countryCode: string,
  regionCode: string | undefined,
  reasons: CatalogSelectionReason[],
  details: string[]
): { readonly country: CatalogDestinationRule; readonly shipping: CatalogShippingRule } | undefined {
  const destinations = requiredState(constraints.destinations, "destinations", reasons, details);
  const shipping = requiredState(constraints.shipping, "shipping", reasons, details);
  if (destinations === undefined || shipping === undefined) return undefined;
  const country = destinations.find((rule) => rule.countryCode === countryCode);
  if (country === undefined) {
    reasons.push("selection_incompatible");
    details.push("destination_country_unsupported");
    return undefined;
  }
  if (country.regions.state === "unknown") {
    reasons.push("unknown_mandatory_constraint");
    details.push("destination_regions:unknown");
    return undefined;
  }
  if (country.regions.state === "unsupported" && regionCode !== undefined) {
    reasons.push("selection_incompatible");
    details.push("destination_region_unsupported");
    return undefined;
  }
  if (country.regions.state === "known" && country.regions.value.length > 0) {
    if (regionCode === undefined) {
      reasons.push("selection_incompatible");
      details.push("destination_region_required");
      return undefined;
    }
    if (!contains(country.regions.value, regionCode)) {
      reasons.push("selection_incompatible");
      details.push("destination_region_unsupported");
      return undefined;
    }
  }
  const exactRegion = regionCode === undefined ? undefined : shipping.find((rule) => rule.countryCode === countryCode && rule.regionCode === regionCode);
  const general = shipping.find((rule) => rule.countryCode === countryCode && rule.regionCode === null);
  const selectedShipping = exactRegion ?? general;
  if (selectedShipping === undefined) {
    reasons.push("selection_incompatible");
    details.push("shipping_route_unsupported");
    return undefined;
  }
  return { country, shipping: selectedShipping };
}

function addIncompatible(details: string[], code: string): void {
  details.push(code);
}

/**
 * Checks a previously bound selection against a fresh normalized snapshot.
 * A spec identity change, stale capture, removed SKU, or binding mismatch
 * requires revalidation, re-quote, and new approval before use.
 */
export function evaluateCatalogSelection(
  snapshot: CatalogSnapshot,
  input: unknown,
  now: string
): CatalogSelectionResult {
  const fullReapproval = Object.freeze(["revalidate", "requote", "reapprove"] as const);
  const refreshAndReapproval = Object.freeze(["refresh_catalog", "revalidate", "requote", "reapprove"] as const);
  let selection: NormalizedCatalogSelection;
  try {
    selection = normalizeSelection(input);
  } catch {
    return Object.freeze({
      status: "ineligible", eligible: false, providerId: snapshot.providerId,
      snapshotIdentity: snapshot.snapshotIdentity, catalogContentIdentity: snapshot.catalogContentIdentity,
      sku: "unknown", variantId: "unknown", reasons: Object.freeze(["selection_input_invalid"] as CatalogSelectionReason[]),
      details: Object.freeze([]), requiredActions: fullReapproval
    });
  }
  const base = {
    providerId: snapshot.providerId,
    snapshotIdentity: snapshot.snapshotIdentity,
    catalogContentIdentity: snapshot.catalogContentIdentity,
    sku: selection.sku,
    variantId: selection.variantId
  };
  let nowTimestamp: { readonly text: string; readonly epochMs: number };
  try {
    nowTimestamp = canonicalTimestamp(now);
  } catch {
    return Object.freeze({ ...base, status: "ineligible", eligible: false,
      reasons: Object.freeze(["catalog_clock_invalid"] as CatalogSelectionReason[]), details: Object.freeze([]), requiredActions: refreshAndReapproval });
  }
  const sourceTimestamp = canonicalTimestamp(snapshot.source.retrievedAt);
  const freshUntilTimestamp = canonicalTimestamp(snapshot.freshness.freshUntil);
  if (nowTimestamp.epochMs < sourceTimestamp.epochMs) {
    return Object.freeze({ ...base, status: "ineligible", eligible: false,
      reasons: Object.freeze(["catalog_clock_before_retrieval"] as CatalogSelectionReason[]), details: Object.freeze([]), requiredActions: refreshAndReapproval });
  }
  if (nowTimestamp.epochMs > freshUntilTimestamp.epochMs) {
    return Object.freeze({ ...base, status: "revalidation_required", eligible: false,
      reasons: Object.freeze(["catalog_stale"] as CatalogSelectionReason[]), details: Object.freeze([]), requiredActions: refreshAndReapproval });
  }
  if (selection.snapshotIdentity === snapshot.snapshotIdentity && selection.catalogContentIdentity !== snapshot.catalogContentIdentity) {
    return Object.freeze({ ...base, status: "revalidation_required", eligible: false,
      reasons: Object.freeze(["snapshot_binding_mismatch"] as CatalogSelectionReason[]), details: Object.freeze([]), requiredActions: fullReapproval });
  }
  const product = snapshot.products.find((entry) => entry.sku === selection.sku && entry.variantId === selection.variantId);
  if (product === undefined || product.availability === "removed") {
    return Object.freeze({ ...base, status: "revalidation_required", eligible: false,
      reasons: Object.freeze([product === undefined ? "sku_not_found" : "sku_removed"] as CatalogSelectionReason[]), details: Object.freeze([]), requiredActions: refreshAndReapproval });
  }
  if (selection.snapshotIdentity.length === 0 || selection.catalogContentIdentity.length === 0 || selection.specIdentity.length === 0) {
    return Object.freeze({ ...base, status: "revalidation_required", eligible: false,
      reasons: Object.freeze(["snapshot_binding_mismatch"] as CatalogSelectionReason[]), details: Object.freeze([]), requiredActions: fullReapproval });
  }
  if (selection.specIdentity !== product.specIdentity) {
    return Object.freeze({ ...base, status: "revalidation_required", eligible: false,
      reasons: Object.freeze(["spec_identity_changed"] as CatalogSelectionReason[]), details: Object.freeze([]), requiredActions: fullReapproval });
  }
  const reasons: CatalogSelectionReason[] = [];
  const details: string[] = [];
  const dimensions = requiredState(product.constraints.dimensions, "dimensions", reasons, details);
  const minimumBleed = requiredState(product.constraints.minimumBleed, "minimum_bleed", reasons, details);
  const minimumSafeArea = requiredState(product.constraints.minimumSafeArea, "minimum_safe_area", reasons, details);
  const minimumDpi = requiredState(product.constraints.minimumResolutionDpi, "minimum_resolution", reasons, details);
  const surfaces = requiredState(product.constraints.surfaces, "surfaces", reasons, details);
  const files = requiredState(product.constraints.files, "files", reasons, details);
  const color = requiredState(product.constraints.color, "color", reasons, details);
  const availableOptions = requiredState(product.constraints.options, "options", reasons, details);
  const availableMaterials = requiredState(product.constraints.materials, "materials", reasons, details);
  const personalization = product.constraints.personalization;
  if (personalization.state === "unknown") {
    reasons.push("unknown_mandatory_constraint");
    details.push("personalization:unknown");
  }
  if (personalization.state === "unsupported" && selection.personalization !== null) {
    addIncompatible(details, "personalization_unsupported");
  }
  if (dimensions !== undefined && stableJson(dimensions) !== stableJson(selection.dimensions)) addIncompatible(details, "dimensions_mismatch");
  if (minimumBleed !== undefined) {
    for (const side of ["topNm", "rightNm", "bottomNm", "leftNm"] as const) {
      if (compareBigInt(selection.bleed[side], minimumBleed[side]) < 0) addIncompatible(details, `bleed_below_minimum_${side.replace("Nm", "")}`);
    }
  }
  if (minimumSafeArea !== undefined) {
    for (const side of ["topNm", "rightNm", "bottomNm", "leftNm"] as const) {
      if (compareBigInt(selection.safeArea[side], minimumSafeArea[side]) < 0) addIncompatible(details, `safe_area_below_minimum_${side.replace("Nm", "")}`);
    }
  }
  if (dimensions !== undefined) {
    if (BigInt(selection.safeArea.leftNm) + BigInt(selection.safeArea.rightNm) >= BigInt(dimensions.widthNm)) {
      addIncompatible(details, "safe_area_no_horizontal_content");
    }
    if (BigInt(selection.safeArea.topNm) + BigInt(selection.safeArea.bottomNm) >= BigInt(dimensions.heightNm)) {
      addIncompatible(details, "safe_area_no_vertical_content");
    }
  }
  if (minimumDpi !== undefined && selection.effectiveResolutionDpi < minimumDpi) addIncompatible(details, "resolution_below_minimum");
  if (surfaces !== undefined && !contains(surfaces, selection.surface)) addIncompatible(details, "surface_unsupported");
  if (files !== undefined && (!contains(files.types, selection.fileType) || selection.fileCount < files.minimumCount || selection.fileCount > files.maximumCount)) {
    addIncompatible(details, "format_or_file_count_unsupported");
  }
  if (color !== undefined && (!contains(color.spaces, selection.colorSpace) || !contains(color.profiles, selection.colorProfile))) addIncompatible(details, "color_or_profile_unsupported");
  if (availableOptions !== undefined && selection.options.some((option) => !contains(availableOptions, option))) addIncompatible(details, "option_unsupported");
  if (availableMaterials !== undefined && selection.materials.some((material) => !contains(availableMaterials, material))) addIncompatible(details, "material_unsupported");
  if (availableMaterials !== undefined && selection.materials.length === 0) addIncompatible(details, "material_selection_missing");
  if (personalization.state === "known" && selection.personalization !== null) {
    const selected = selection.personalization;
    const supported = personalization.value;
    if (!contains(supported.modes, selected.mode) || selected.fields.length > supported.maximumFields ||
      selected.fields.some((field) => field.characterCount > supported.maximumCharactersPerField)) {
      addIncompatible(details, "personalization_limit_unsupported");
    }
  }
  routeForDestination(product.constraints, selection.destination.countryCode, selection.destination.regionCode, reasons, details);
  const shippingState = product.constraints.shipping;
  if (shippingState.state === "known") {
    const exact = selection.destination.regionCode === undefined ? undefined : shippingState.value.find((item) => item.countryCode === selection.destination.countryCode && item.regionCode === selection.destination.regionCode);
    const general = shippingState.value.find((item) => item.countryCode === selection.destination.countryCode && item.regionCode === null);
    const shipping = exact ?? general;
    if (shipping !== undefined && !contains(shipping.methods, selection.shippingMethod)) addIncompatible(details, "shipping_method_unsupported");
  }
  const dedupedReasons = [...new Set(reasons)];
  const incompatible = details.some((entry) => !entry.includes(":unknown"));
  if (dedupedReasons.length > 0) {
    return Object.freeze({ ...base, specIdentity: product.specIdentity, status: "ineligible", eligible: false,
      reasons: Object.freeze(dedupedReasons), details: Object.freeze([...new Set(details)]), requiredActions: fullReapproval });
  }
  if (incompatible) {
    return Object.freeze({ ...base, specIdentity: product.specIdentity, status: "ineligible", eligible: false,
      reasons: Object.freeze(["selection_incompatible"] as CatalogSelectionReason[]), details: Object.freeze([...new Set(details)]), requiredActions: fullReapproval });
  }
  const bindingChanged = selection.snapshotIdentity !== snapshot.snapshotIdentity || selection.catalogContentIdentity !== snapshot.catalogContentIdentity;
  return Object.freeze({ ...base, specIdentity: product.specIdentity, status: "eligible", eligible: true,
    reasons: Object.freeze([]), details: Object.freeze(bindingChanged ? ["validated_against_current_fresh_snapshot"] : []), requiredActions: Object.freeze([]) });
}

/**
 * Pass the private development snapshot to the existing injected canonical
 * boundary. A development fixture validator remains only a fixture; this
 * helper makes no accepted-schema or cross-repository conformance claim.
 */
export async function validateCatalogSnapshotBoundary(
  snapshot: CatalogSnapshot,
  validator: ContractValidator,
  trustedScope: TrustedScope
): Promise<BoundaryResult<unknown>> {
  const failure = (code: BoundaryFailure["code"]): BoundaryResult<unknown> =>
    Object.freeze({ ok: false as const, failure: Object.freeze({ code }) });
  const validFailureCodes = new Set<BoundaryFailure["code"]>([
    "invalid_input", "contract_missing", "unsupported_schema_major", "scope_mismatch"
  ]);
  const schemaVersionPattern = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/u;
  let tenantId: string;
  let projectId: string;
  try {
    const scope = record(safeTree(trustedScope));
    exactKeys(scope, ["tenantId", "projectId"]);
    tenantId = safeCode(scope.tenantId);
    projectId = safeCode(scope.projectId);
  } catch {
    return failure("invalid_input");
  }
  let bindingVersion: RegExpExecArray;
  try {
    const binding = record(safeTree(validator.binding("capability")));
    exactKeys(binding, ["shape", "ownerRepository", "upstreamIssue", "state"], ["schemaVersion", "sourceRevision", "fixtureDigest"]);
    if (binding.shape !== "capability" || binding.ownerRepository !== CONTRACT_OWNERSHIP.capability.ownerRepository ||
      binding.upstreamIssue !== CONTRACT_OWNERSHIP.capability.upstreamIssue) return failure("contract_missing");
    const schemaVersion = text(binding.schemaVersion, 128);
    const match = schemaVersionPattern.exec(schemaVersion);
    if (match === null) return failure("contract_missing");
    bindingVersion = match;
    if (binding.state === "development_fixture") {
      text(binding.fixtureDigest, 256);
    } else if (binding.state === "accepted") {
      text(binding.sourceRevision, 256);
      text(binding.fixtureDigest, 256);
    } else {
      return failure("contract_missing");
    }
  } catch {
    return failure("contract_missing");
  }

  let rawResult: unknown;
  try {
    rawResult = await validator.validateOutbound({
      operation: "discover_capabilities",
      requiredShapes: ["capability"],
      value: frozenOwnedCopy(snapshot),
      trustedScope: Object.freeze({ tenantId, projectId })
    });
  } catch {
    return failure("contract_missing");
  }

  let result: PlainRecord;
  try {
    result = record(safeTree(rawResult));
  } catch {
    return failure("invalid_input");
  }

  if (result.ok === false) {
    let failureRecord: PlainRecord;
    try {
      exactKeys(result, ["ok", "failure"]);
      failureRecord = record(result.failure);
      exactKeys(failureRecord, ["code"]);
    } catch {
      return failure("invalid_input");
    }
    const code = failureRecord.code;
    if (typeof code !== "string" || !validFailureCodes.has(code as BoundaryFailure["code"])) return failure("invalid_input");
    return failure(code as BoundaryFailure["code"]);
  }
  if (result.ok !== true) return failure("invalid_input");

  let receipt: PlainRecord;
  let value: unknown;
  try {
    exactKeys(result, ["ok", "value", "receipts"]);
    value = result.value;
    if (!Array.isArray(result.receipts) || result.receipts.length !== 1) return failure("invalid_input");
    receipt = record(result.receipts[0]);
    exactKeys(receipt, ["shape", "schemaVersion", "tenantId", "projectId"]);
  } catch {
    return failure("invalid_input");
  }

  if (receipt.shape !== "capability") return failure("invalid_input");
  let receiptTenantId: string;
  let receiptProjectId: string;
  let receiptSchemaVersion: string;
  try {
    receiptTenantId = safeCode(receipt.tenantId);
    receiptProjectId = safeCode(receipt.projectId);
    receiptSchemaVersion = text(receipt.schemaVersion, 128);
  } catch {
    return failure("invalid_input");
  }
  if (receiptTenantId !== tenantId || receiptProjectId !== projectId) return failure("scope_mismatch");
  const receiptVersion = schemaVersionPattern.exec(receiptSchemaVersion);
  if (receiptVersion === null || receiptVersion[1] !== bindingVersion[1]) return failure("unsupported_schema_major");

  const ownedValue = deepFreeze(value);
  const ownedReceipt = Object.freeze({
    shape: "capability" as const,
    schemaVersion: receiptSchemaVersion,
    tenantId: receiptTenantId,
    projectId: receiptProjectId
  });
  return Object.freeze({ ok: true as const, value: ownedValue, receipts: Object.freeze([ownedReceipt]) });
}
