import {
  evaluateCatalogSelection,
  normalizeCatalogSnapshot,
  type CatalogSnapshot
} from "./catalog.js";
import type { ContractValidator, TrustedScope } from "./types.js";

/** Private FC-04 development output. It is not shared-contracts FulfillmentQuote. */
export const PRIVATE_QUOTE_FORMAT = "connector-development-quote/1" as const;

export type QuoteErrorCode =
  | "missing_input"
  | "invalid_input"
  | "unsupported"
  | "stale_quote"
  | "rate_limit"
  | "timeout"
  | "provider_failure"
  | "provider_response_invalid"
  | "contract_missing"
  | "contract_rejected"
  | "persistence_unavailable"
  | "scope_mismatch"
  | "unsupported_schema_major";

const SAFE_MESSAGES: Readonly<Record<QuoteErrorCode, string>> = {
  missing_input: "Required quote inputs are missing.",
  invalid_input: "The quote input did not pass validation.",
  unsupported: "The selected product or option is unsupported.",
  stale_quote: "The selection or quote is stale and needs a fresh quote.",
  rate_limit: "The local quote rate limit prevented this operation.",
  timeout: "The quote operation exceeded its configured time limit.",
  provider_failure: "The quotation provider failed.",
  provider_response_invalid: "The quotation response did not pass validation.",
  contract_missing: "A quote contract binding is required.",
  contract_rejected: "The injected quote contract boundary rejected the result.",
  persistence_unavailable: "The quote snapshot could not be persisted safely.",
  scope_mismatch: "The quote contract receipt did not match the trusted scope.",
  unsupported_schema_major: "The quote contract schema major version is unsupported."
};

const QUOTE_ERROR_CODES = new Set<QuoteErrorCode>(Object.keys(SAFE_MESSAGES) as QuoteErrorCode[]);
const INTERNAL_QUOTE_ERRORS = new WeakSet<object>();

export class QuoteExecutionError extends Error {
  readonly operation = "quote" as const;
  readonly code: QuoteErrorCode;
  readonly safeMessage: string;

  constructor(code: QuoteErrorCode) {
    const safeCode = QUOTE_ERROR_CODES.has(code) ? code : "invalid_input";
    super(SAFE_MESSAGES[safeCode]);
    this.code = safeCode;
    Object.defineProperty(this, "name", { value: "QuoteExecutionError", enumerable: false, configurable: false, writable: false });
    this.safeMessage = SAFE_MESSAGES[safeCode];
    Object.freeze(this);
  }

  toJSON(): { operation: "quote"; code: QuoteErrorCode; safeMessage: string } {
    return { operation: this.operation, code: this.code, safeMessage: this.safeMessage };
  }
}

function internalQuoteError(code: QuoteErrorCode): QuoteExecutionError {
  const error = new QuoteExecutionError(code);
  INTERNAL_QUOTE_ERRORS.add(error);
  return error;
}

function internalQuoteErrorCode(value: unknown): QuoteErrorCode | undefined {
  if ((typeof value !== "object" && typeof value !== "function") || value === null || !INTERNAL_QUOTE_ERRORS.has(value as object)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, "code");
    return descriptor !== undefined && "value" in descriptor && QUOTE_ERROR_CODES.has(descriptor.value as QuoteErrorCode)
      ? descriptor.value as QuoteErrorCode
      : undefined;
  } catch {
    return undefined;
  }
}

export type QuoteUnknownReason =
  | "not_disclosed"
  | "not_provided"
  | "not_supported"
  | "provider_unspecified"
  | "outside_scope";

export type ProviderAmountInput =
  | { readonly state: "known"; readonly decimal: string }
  | { readonly state: "unknown"; readonly reasonCode: QuoteUnknownReason };

export interface QuoteProviderRequest {
  readonly providerId: string;
  readonly apiVersion: string;
  readonly catalogVersion: string;
  readonly catalogSnapshotIdentity: string;
  readonly catalogContentIdentity: string;
  readonly sku: string;
  readonly variantId: string;
  readonly specIdentity: string;
  readonly selectionDigest: string;
  readonly quantity: number;
  readonly options: readonly string[];
  readonly materials: readonly string[];
  readonly destination: {
    readonly reference: string;
    readonly digest: string;
    readonly countryCode: string;
    readonly regionCode?: string;
  };
  readonly shippingMethod: string;
  readonly personalization: null | {
    readonly mode: string;
    readonly fieldCount: number;
  };
  readonly requestDigest: string;
}

export interface QuoteProviderCallContext {
  readonly operation: "quote";
  readonly signal: AbortSignal;
}

/** This port deliberately has one operation and no submission or payment API. */
export interface BoundedQuotePort {
  quote(request: QuoteProviderRequest, context: QuoteProviderCallContext): Promise<unknown>;
}

export interface QuoteClock {
  now(): number;
}

export interface QuoteExecutionPolicy {
  readonly timeoutMs: number;
  readonly maximumQuotesPerWindow: number;
  readonly rateWindowMs: number;
  readonly localMaximumValidityMs: number;
}

export interface QuoteDependencies {
  readonly quotePort: BoundedQuotePort;
  readonly contracts: ContractValidator;
  readonly clock: QuoteClock;
  readonly trustedScope: TrustedScope;
  readonly policy?: Partial<QuoteExecutionPolicy>;
  readonly quoteStore?: QuoteSnapshotPersistence;
}

/** Local private snapshot storage, not a shared schema or purchase authority. */
export interface QuoteSnapshotPersistence {
  save(quote: PrivateQuoteSnapshot, trustedScope: TrustedScope): Promise<void>;
}

export type ExactMoney = {
  readonly currency: string;
  readonly scale: number;
  readonly decimal: string;
  readonly minorUnits: string;
};

export type QuotedAmount =
  | { readonly state: "known"; readonly value: ExactMoney }
  | { readonly state: "unknown"; readonly reasonCode: QuoteUnknownReason };

export type QuoteLeadTime =
  | { readonly state: "known"; readonly minimumDays: number; readonly maximumDays: number; readonly confidence: "estimate" }
  | { readonly state: "unknown"; readonly reasonCode: QuoteUnknownReason };

export interface PrivateQuoteBinding {
  readonly tenantId: string;
  readonly projectId: string;
  readonly providerId: string;
  readonly apiVersion: string;
  readonly catalogVersion: string;
  readonly catalogSnapshotIdentity: string;
  readonly catalogContentIdentity: string;
  readonly sku: string;
  readonly variantId: string;
  readonly specIdentity: string;
  readonly selectionDigest: string;
  readonly quantity: number;
  readonly options: readonly string[];
  readonly materials: readonly string[];
  readonly destination: {
    readonly reference: string;
    readonly digest: string;
    readonly countryCode: string;
    readonly regionCode?: string;
  };
  readonly shippingMethod: string;
  readonly requestDigest: string;
}

export interface PrivateQuoteSnapshot {
  readonly localFormat: typeof PRIVATE_QUOTE_FORMAT;
  readonly quoteId: string;
  readonly termsFingerprint: string;
  readonly status: "complete" | "incomplete";
  readonly binding: PrivateQuoteBinding;
  readonly catalogEvidenceMode: CatalogSnapshot["source"]["evidenceMode"];
  readonly providerQuoteReference: string;
  readonly createdAt: string;
  readonly expiry: {
    readonly provider: { readonly state: "known"; readonly validUntil: string } | { readonly state: "unknown"; readonly reasonCode: QuoteUnknownReason };
    readonly localPolicy: { readonly version: "quote-local-policy/1"; readonly validUntil: string };
    readonly effectiveValidUntil: string;
    readonly effectiveSource: "provider" | "local_policy" | "provider_and_local_policy";
  };
  readonly currency: string;
  readonly currencyScale: number;
  readonly breakdown: {
    readonly production: QuotedAmount;
    readonly shipping: QuotedAmount;
    readonly tax: QuotedAmount;
    readonly fee: QuotedAmount;
    readonly total: QuotedAmount;
    readonly taxBasis: "included" | "excluded" | "unknown";
    readonly reconciliation:
      | { readonly state: "reconciled"; readonly expectedTotal: ExactMoney }
      | { readonly state: "incomplete"; readonly missing: readonly string[] };
  };
  readonly leadTime: QuoteLeadTime;
  readonly warnings: readonly string[];
  readonly providerNotes: readonly string[];
  readonly financialEffect: "quote_only";
}

export interface PrivateQuoteResponse {
  readonly quote: PrivateQuoteSnapshot;
  readonly sharedPayload: unknown;
  readonly contractBinding: {
    readonly state: "development_fixture" | "accepted";
    readonly schemaVersion: string;
    readonly sourceRevision?: string;
    readonly fixtureDigest: string;
  };
}

export type QuoteCurrentReason =
  | "quote_integrity_invalid"
  | "quote_expired"
  | "quote_incomplete"
  | "trusted_scope_changed"
  | "catalog_changed"
  | "catalog_stale"
  | "selection_changed"
  | "destination_changed"
  | "request_changed"
  | "selection_ineligible";

export type QuoteRequiredAction =
  | "refresh_catalog"
  | "revalidate_selection"
  | "requote"
  | "obtain_external_authorization"
  | "renew_external_authorization";

export interface QuoteCurrentEvaluation {
  readonly status: "current" | "stale" | "incomplete" | "invalid";
  readonly reasons: readonly QuoteCurrentReason[];
  readonly requiredActions: readonly QuoteRequiredAction[];
  readonly quoteMayBePresentedForExternalReview: boolean;
}

const SAFE_TREE_MAX_NODES = 20_000;
const SAFE_TREE_MAX_DEPTH = 20;
const SAFE_STRING_MAX = 4_096;
const SAFE_TOTAL_BYTES = 1_000_000;
const MAX_QUANTITY = 1_000_000;
const MAX_AMOUNT_INTEGER_DIGITS = 14;
const MAX_AMOUNT_SCALE = 6;
const UNKNOWN_REASONS = new Set<QuoteUnknownReason>([
  "not_disclosed", "not_provided", "not_supported", "provider_unspecified", "outside_scope"
]);
const OPAQUE_REFERENCE = /^[A-Za-z][A-Za-z0-9._+-]{0,31}:[A-Za-z0-9][A-Za-z0-9._:/#-]{0,223}$/u;
const PIN_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/#@+-]{0,255}$/u;
const PIN_HASH = /^(?:sha256:)?[a-f0-9]{40,64}$/u;
const PIN_SECRET_LABEL = /\b(?:token|secret|password|credential|api[_ -]?key)\b\s*[:=]/iu;
const SCHEMA_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/u;
const FORBIDDEN_KEY = /(?:address|email|phone|street|recipient|customer|contact|postal.?code|zip.?code|password|secret|token|credential|api.?key|signed.?url)/iu;
const EMAIL_OR_URL = /(?:https?:\/\/|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b)/iu;
const PHONE_LIKE = /(?:^|\D)\+?\d[\d\s().-]{8,}\d(?:\D|$)/u;
const OPAQUE_QUOTE_ID = /^quote:sha256:[a-f0-9]{64}$/u;
const OPAQUE_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const EXACT_MONEY = /^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/u;
const EXACT_MINOR_UNITS = /^(?:0|[1-9]\d{0,19})$/u;
const FINANCIAL_FIELD = /(?:amount|decimal|minorunits?|money|price|cost|total|subtotal|production|shipping|tax|fee)/u;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const QUOTE_TIMESTAMP_FIELDS = new Set(["createdat", "validuntil", "effectivevaliduntil", "localvaliduntil", "issuedat", "expiresat"]);
const ADDRESS_LIKE = /\b\d{1,6}\s+[A-Za-z0-9.' -]{2,64}\s(?:street|st|road|rd|avenue|ave|boulevard|blvd|lane|ln|drive|dr)\b/iu;
const SECRET_LIKE = /(?:\bbearer\s+[A-Za-z0-9._~-]{8,}|\bsk-[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]+PRIVATE KEY-----)/iu;

function invalid(code: QuoteErrorCode = "invalid_input"): never {
  throw internalQuoteError(code);
}

function safeTree(value: unknown, depth = 0, seen = new WeakSet<object>(), budget = { nodes: 0, bytes: 0 }): unknown {
  budget.nodes += 1;
  if (budget.nodes > SAFE_TREE_MAX_NODES || depth > SAFE_TREE_MAX_DEPTH) return invalid();
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > SAFE_STRING_MAX || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)) return invalid();
    budget.bytes += new TextEncoder().encode(value).byteLength;
    if (budget.bytes > SAFE_TOTAL_BYTES) return invalid();
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) return invalid();
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value) || value.length > 2_000) return invalid();
    seen.add(value);
    const copy: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) return invalid();
      copy.push(safeTree(descriptor.value, depth + 1, seen, budget));
    }
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length") continue;
      if (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length) return invalid();
    }
    seen.delete(value);
    return Object.freeze(copy);
  }
  if (typeof value !== "object") return invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  if (seen.has(value)) return invalid();
  seen.add(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length > 1_000) return invalid();
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== "string" || key.length === 0 || key.length > 128) return invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) return invalid();
    Object.defineProperty(copy, key, {
      value: safeTree(descriptor.value, depth + 1, seen, budget),
      enumerable: true,
      configurable: true,
      writable: true
    });
  }
  seen.delete(value);
  return Object.freeze(copy);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) return invalid();
}

function requiredKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (expected.some((key) => !Object.hasOwn(value, key))) return invalid("missing_input");
  exactKeys(value, expected);
}

function ownValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) return invalid("missing_input");
  return descriptor.value;
}

function dependencyValue<T>(value: unknown, key: string): T {
  if (value === null || typeof value !== "object") return invalid("missing_input");
  try {
    return ownValue(value, key) as T;
  } catch {
    return invalid("missing_input");
  }
}

function optionalDependencyValue<T>(value: unknown, key: string): T | undefined {
  if (value === null || typeof value !== "object") return invalid("missing_input");
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) return undefined;
    if (!("value" in descriptor) || descriptor.enumerable !== true) return invalid("missing_input");
    return descriptor.value as T;
  } catch {
    return invalid("missing_input");
  }
}

function captureMethod(target: unknown, key: string): (...args: unknown[]) => unknown {
  try {
    if ((typeof target !== "object" && typeof target !== "function") || target === null) return invalid("missing_input");
    let current: object | null = target as object;
    for (let depth = 0; current !== null && depth < 16; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor !== undefined) {
        if (!("value" in descriptor) || typeof descriptor.value !== "function") return invalid("missing_input");
        const method = descriptor.value as (...args: unknown[]) => unknown;
        return (...args: unknown[]) => Reflect.apply(method, target, args);
      }
      current = Object.getPrototypeOf(current) as object | null;
    }
  } catch {
    return invalid("missing_input");
  }
  return invalid("missing_input");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
}

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableJson(value));
  if (bytes.byteLength > SAFE_TOTAL_BYTES * 4) return invalid();
  try {
    const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return `sha256:${Array.from(new Uint8Array(hash), (part) => part.toString(16).padStart(2, "0")).join("")}`;
  } catch {
    return invalid("provider_failure");
  }
}

function canonicalTimestamp(value: unknown): { readonly text: string; readonly epochMs: number } {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return invalid();
  const epochMs = Date.parse(value);
  if (!Number.isSafeInteger(epochMs) || new Date(epochMs).toISOString() !== value) return invalid();
  return { text: value, epochMs };
}

function safeText(value: unknown, maximum = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.trim() !== value ||
      /[\u0000-\u001F\u007F]/u.test(value) || EMAIL_OR_URL.test(value) || PHONE_LIKE.test(value) ||
      ADDRESS_LIKE.test(value) || SECRET_LIKE.test(value)) return invalid("provider_response_invalid");
  return value;
}

function safeScopeIdentifier(value: unknown): string {
  return safeText(value, 128);
}

function safeReference(value: unknown): string {
  const result = safeText(value, 256);
  if (!OPAQUE_REFERENCE.test(result)) return invalid("provider_response_invalid");
  return result;
}

function safePinMetadata(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || value.trim() !== value ||
      /[\u0000-\u001F\u007F]/u.test(value) || !PIN_IDENTIFIER.test(value)) return invalid("contract_missing");
  if (!PIN_HASH.test(value) && (EMAIL_OR_URL.test(value) || PHONE_LIKE.test(value) || ADDRESS_LIKE.test(value) ||
      SECRET_LIKE.test(value) || PIN_SECRET_LABEL.test(value))) return invalid("contract_missing");
  return value;
}

function safeDigest(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) return invalid("invalid_input");
  return value;
}

function safeCode(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9._:/+-]{0,127}$/u.test(value)) return invalid("provider_response_invalid");
  return value;
}

function safeUnknownReason(value: unknown): QuoteUnknownReason {
  if (typeof value !== "string" || !UNKNOWN_REASONS.has(value as QuoteUnknownReason)) return invalid("provider_response_invalid");
  return value as QuoteUnknownReason;
}

function snapshotScope(value: unknown): TrustedScope {
  const scope = record(safeTree(value));
  exactKeys(scope, ["tenantId", "projectId"]);
  const tenantId = safeScopeIdentifier(scope.tenantId);
  const projectId = safeScopeIdentifier(scope.projectId);
  if (tenantId.length === 0 || projectId.length === 0) return invalid("scope_mismatch");
  return Object.freeze({ tenantId, projectId });
}

function quotePolicy(value: unknown): QuoteExecutionPolicy {
  const defaults: QuoteExecutionPolicy = {
    timeoutMs: 5_000,
    maximumQuotesPerWindow: 10,
    rateWindowMs: 1_000,
    localMaximumValidityMs: 5 * 60_000
  };
  if (value === undefined) return Object.freeze(defaults);
  const input = record(safeTree(value));
  const keys = Object.keys(input);
  if (keys.some((key) => !["timeoutMs", "maximumQuotesPerWindow", "rateWindowMs", "localMaximumValidityMs"].includes(key))) return invalid();
  const result: QuoteExecutionPolicy = {
    timeoutMs: input.timeoutMs === undefined ? defaults.timeoutMs : input.timeoutMs as number,
    maximumQuotesPerWindow: input.maximumQuotesPerWindow === undefined ? defaults.maximumQuotesPerWindow : input.maximumQuotesPerWindow as number,
    rateWindowMs: input.rateWindowMs === undefined ? defaults.rateWindowMs : input.rateWindowMs as number,
    localMaximumValidityMs: input.localMaximumValidityMs === undefined ? defaults.localMaximumValidityMs : input.localMaximumValidityMs as number
  };
  if (!Number.isSafeInteger(result.timeoutMs) || result.timeoutMs < 1 || result.timeoutMs > 30_000 ||
      !Number.isSafeInteger(result.maximumQuotesPerWindow) || result.maximumQuotesPerWindow < 1 || result.maximumQuotesPerWindow > 100 ||
      !Number.isSafeInteger(result.rateWindowMs) || result.rateWindowMs < 100 || result.rateWindowMs > 60_000 ||
      !Number.isSafeInteger(result.localMaximumValidityMs) || result.localMaximumValidityMs < 1_000 || result.localMaximumValidityMs > 86_400_000) return invalid();
  return Object.freeze(result);
}

function readNow(clock: unknown): { readonly text: string; readonly epochMs: number } {
  const nowMethod = captureMethod(clock, "now");
  let result: unknown;
  try {
    result = Reflect.apply(nowMethod, clock, []);
  } catch {
    return invalid("invalid_input");
  }
  if (!Number.isSafeInteger(result) || (result as number) < 0 || (result as number) > 253_402_300_799_999) return invalid("invalid_input");
  return canonicalTimestamp(new Date(result as number).toISOString());
}

interface RateState {
  readonly policySignature: string;
  readonly timestamps: number[];
}

const rateStates = new WeakMap<object, RateState>();

function consumeRateLimit(port: unknown, policy: QuoteExecutionPolicy, now: number): void {
  if ((typeof port !== "object" && typeof port !== "function") || port === null) return invalid("missing_input");
  const signature = `${policy.maximumQuotesPerWindow}/${policy.rateWindowMs}`;
  let state = rateStates.get(port as object);
  if (state === undefined) {
    state = { policySignature: signature, timestamps: [] };
    rateStates.set(port as object, state);
  } else if (state.policySignature !== signature) {
    return invalid();
  }
  const last = state.timestamps[state.timestamps.length - 1];
  if (last !== undefined && now < last) return invalid("invalid_input");
  const cutoff = now - policy.rateWindowMs;
  while (state.timestamps.length > 0 && state.timestamps[0]! <= cutoff) state.timestamps.shift();
  if (state.timestamps.length >= policy.maximumQuotesPerWindow) return invalid("rate_limit");
  state.timestamps.push(now);
}

function parseRequest(value: unknown): Record<string, unknown> {
  const request = record(safeTree(value));
  requiredKeys(request, ["catalogSource", "selection", "quantity", "destinationReference", "destinationDigest"]);
  return request;
}

function safeDestinationReference(value: unknown): string {
  const result = safeText(value, 256);
  if (!OPAQUE_REFERENCE.test(result)) return invalid("invalid_input");
  return result;
}

function amountInput(value: unknown): { readonly state: "known"; readonly decimal: string } | { readonly state: "unknown"; readonly reasonCode: QuoteUnknownReason } {
  const amount = record(value);
  if (amount.state === "known") {
    exactKeys(amount, ["state", "decimal"]);
    if (typeof amount.decimal !== "string") return invalid("provider_response_invalid");
    return { state: "known", decimal: amount.decimal };
  }
  if (amount.state === "unknown") {
    exactKeys(amount, ["state", "reasonCode"]);
    return { state: "unknown", reasonCode: safeUnknownReason(amount.reasonCode) };
  }
  return invalid("provider_response_invalid");
}

function normalizeAmount(value: unknown, currency: string, scale: number): QuotedAmount {
  const input = amountInput(value);
  if (input.state === "unknown") return Object.freeze({ state: "unknown", reasonCode: input.reasonCode });
  const decimal = input.decimal;
  const pattern = new RegExp(`^(?:0|[1-9]\\d{0,${MAX_AMOUNT_INTEGER_DIGITS - 1}})(?:\\.\\d{1,${MAX_AMOUNT_SCALE}})?$`, "u");
  if (!pattern.test(decimal)) return invalid("provider_response_invalid");
  const [whole = "0", fraction = ""] = decimal.split(".");
  if (fraction.length > scale) return invalid("provider_response_invalid");
  const normalizedFraction = fraction.padEnd(scale, "0");
  const normalized = scale === 0 ? whole : `${whole}.${normalizedFraction}`;
  const minorUnits = BigInt(whole) * (10n ** BigInt(scale)) + BigInt(normalizedFraction || "0");
  const moneyValue: ExactMoney = Object.freeze({ currency, scale, decimal: normalized, minorUnits: minorUnits.toString() });
  return Object.freeze({ state: "known", value: moneyValue });
}

function knownMinor(value: QuotedAmount): bigint | undefined {
  return value.state === "known" ? BigInt(value.value.minorUnits) : undefined;
}

function normalizeLeadTime(value: unknown): QuoteLeadTime {
  const input = record(value);
  if (input.state === "unknown") {
    exactKeys(input, ["state", "reasonCode"]);
    return Object.freeze({ state: "unknown", reasonCode: safeUnknownReason(input.reasonCode) });
  }
  if (input.state !== "known") return invalid("provider_response_invalid");
  exactKeys(input, ["state", "minimumDays", "maximumDays"]);
  const minimumDays = input.minimumDays;
  const maximumDays = input.maximumDays;
  if (!Number.isSafeInteger(minimumDays) || !Number.isSafeInteger(maximumDays) ||
      (minimumDays as number) < 0 || (maximumDays as number) < (minimumDays as number) || (maximumDays as number) > 3_650) return invalid("provider_response_invalid");
  return Object.freeze({ state: "known", minimumDays: minimumDays as number, maximumDays: maximumDays as number, confidence: "estimate" });
}

function normalizeTextList(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 32) return invalid("provider_response_invalid");
  const values = value.map((item) => safeText(item, 512));
  return Object.freeze(values);
}

function normalizeProviderExpiry(value: unknown): PrivateQuoteSnapshot["expiry"]["provider"] {
  const input = record(value);
  if (input.state === "unknown") {
    exactKeys(input, ["state", "reasonCode"]);
    return Object.freeze({ state: "unknown", reasonCode: safeUnknownReason(input.reasonCode) });
  }
  if (input.state === "known") {
    exactKeys(input, ["state", "validUntil"]);
    const timestamp = canonicalTimestamp(input.validUntil);
    return Object.freeze({ state: "known", validUntil: timestamp.text });
  }
  return invalid("provider_response_invalid");
}

async function normalizeProviderQuote(value: unknown, createdAt: string, policy: QuoteExecutionPolicy): Promise<{
  readonly providerQuoteReference: string;
  readonly expiry: PrivateQuoteSnapshot["expiry"];
  readonly currency: string;
  readonly currencyScale: number;
  readonly breakdown: PrivateQuoteSnapshot["breakdown"];
  readonly leadTime: QuoteLeadTime;
  readonly warnings: readonly string[];
  readonly providerNotes: readonly string[];
  readonly termsFingerprint: string;
  readonly status: "complete" | "incomplete";
}> {
  let input: Record<string, unknown>;
  try {
    input = record(safeTree(value));
  } catch {
    return invalid("provider_response_invalid");
  }
  exactKeys(input, ["providerQuoteReference", "currency", "currencyScale", "breakdown", "taxBasis", "total", "providerExpiry", "leadTime", "warnings", "providerNotes"]);
  const providerQuoteReference = safeReference(input.providerQuoteReference);
  const currency = input.currency;
  const currencyScale = input.currencyScale;
  if (typeof currency !== "string" || !/^[A-Z]{3}$/u.test(currency) || !Number.isSafeInteger(currencyScale) ||
      (currencyScale as number) < 0 || (currencyScale as number) > MAX_AMOUNT_SCALE) return invalid("provider_response_invalid");
  const scale = currencyScale as number;
  const rawBreakdown = record(input.breakdown);
  exactKeys(rawBreakdown, ["production", "shipping", "tax", "fee"]);
  const production = normalizeAmount(rawBreakdown.production, currency, scale);
  const shipping = normalizeAmount(rawBreakdown.shipping, currency, scale);
  const tax = normalizeAmount(rawBreakdown.tax, currency, scale);
  const fee = normalizeAmount(rawBreakdown.fee, currency, scale);
  const total = normalizeAmount(input.total, currency, scale);
  const taxBasis = input.taxBasis;
  if (taxBasis !== "included" && taxBasis !== "excluded" && taxBasis !== "unknown") return invalid("provider_response_invalid");
  const totalMinor = knownMinor(total);
  const productionMinor = knownMinor(production);
  const shippingMinor = knownMinor(shipping);
  const feeMinor = knownMinor(fee);
  const taxMinor = knownMinor(tax);
  if (taxBasis === "included" && totalMinor !== undefined && taxMinor !== undefined && taxMinor > totalMinor) {
    return invalid("provider_response_invalid");
  }
  const missing: string[] = [];
  if (totalMinor === undefined) missing.push("total");
  if (productionMinor === undefined) missing.push("production");
  if (shippingMinor === undefined) missing.push("shipping");
  if (feeMinor === undefined) missing.push("fee");
  if (taxBasis === "unknown") missing.push("tax_basis");
  if (taxBasis === "excluded" && taxMinor === undefined) missing.push("tax");
  let reconciliation: PrivateQuoteSnapshot["breakdown"]["reconciliation"];
  if (missing.length > 0) {
    reconciliation = Object.freeze({ state: "incomplete", missing: Object.freeze([...new Set(missing)]) });
  } else {
    const expected = productionMinor! + shippingMinor! + feeMinor! + (taxBasis === "excluded" ? taxMinor! : 0n);
    if (expected !== totalMinor) return invalid("provider_response_invalid");
    reconciliation = Object.freeze({
      state: "reconciled",
      expectedTotal: Object.freeze({ currency, scale, decimal: (total as Extract<QuotedAmount, { state: "known" }>).value.decimal, minorUnits: expected.toString() })
    });
  }
  const breakdown = Object.freeze({ production, shipping, tax, fee, total, taxBasis, reconciliation });
  const leadTime = normalizeLeadTime(input.leadTime);
  const warnings = normalizeTextList(input.warnings);
  const providerNotes = normalizeTextList(input.providerNotes);
  const created = canonicalTimestamp(createdAt);
  const providerExpiry = normalizeProviderExpiry(input.providerExpiry);
  if (providerExpiry.state === "known" && Date.parse(providerExpiry.validUntil) <= created.epochMs) return invalid("provider_response_invalid");
  const localExpiryMs = created.epochMs + policy.localMaximumValidityMs;
  if (!Number.isSafeInteger(localExpiryMs) || localExpiryMs > 253_402_300_799_999) return invalid("provider_response_invalid");
  const localValidUntil = new Date(localExpiryMs).toISOString();
  let effectiveValidUntil = localValidUntil;
  let effectiveSource: PrivateQuoteSnapshot["expiry"]["effectiveSource"] = "local_policy";
  if (providerExpiry.state === "known") {
    const providerMs = Date.parse(providerExpiry.validUntil);
    if (providerMs < localExpiryMs) {
      effectiveValidUntil = providerExpiry.validUntil;
      effectiveSource = "provider";
    } else if (providerMs === localExpiryMs) {
      effectiveValidUntil = providerExpiry.validUntil;
      effectiveSource = "provider_and_local_policy";
    }
  }
  const expiry = Object.freeze({
    provider: providerExpiry,
    localPolicy: Object.freeze({ version: "quote-local-policy/1" as const, validUntil: localValidUntil }),
    effectiveValidUntil,
    effectiveSource
  });
  const status: "complete" | "incomplete" =
    production.state === "known" && shipping.state === "known" && tax.state === "known" && fee.state === "known" &&
    total.state === "known" && taxBasis !== "unknown" && reconciliation.state === "reconciled"
      ? "complete"
      : "incomplete";
  const termsFingerprint = await digest({
    providerQuoteReference, currency, currencyScale: scale, breakdown, expiry, leadTime, warnings, providerNotes
  });
  return { providerQuoteReference, expiry, currency, currencyScale: scale, breakdown, leadTime, warnings, providerNotes, termsFingerprint, status };
}

function contractBinding(validator: unknown, scope: TrustedScope): {
  readonly state: "development_fixture" | "accepted";
  readonly schemaVersion: string;
  readonly sourceRevision?: string;
  readonly fixtureDigest: string;
  readonly validateOutbound: (...args: unknown[]) => unknown;
} {
  try {
    const bindingMethod = captureMethod(validator, "binding");
    const validateOutbound = captureMethod(validator, "validateOutbound");
    const rawBinding = Reflect.apply(bindingMethod, validator, ["fulfillment_quote"]);
    const binding = record(safeTree(rawBinding));
    const allowedKeys = ["shape", "ownerRepository", "upstreamIssue", "state", "schemaVersion", "sourceRevision", "fixtureDigest"];
    if (Object.keys(binding).some((key) => !allowedKeys.includes(key))) return invalid("contract_missing");
    const schemaVersion = safePinMetadata(binding.schemaVersion);
    if (binding.shape !== "fulfillment_quote" || binding.ownerRepository !== "shared-contracts" || binding.upstreamIssue !== "#25" ||
        (binding.state !== "development_fixture" && binding.state !== "accepted") || SCHEMA_VERSION.exec(schemaVersion) === null) return invalid("contract_missing");
    const fixtureDigest = safePinMetadata(binding.fixtureDigest);
    let sourceRevision: string | undefined;
    if (binding.state === "accepted") {
      sourceRevision = safePinMetadata(binding.sourceRevision);
    } else if (binding.sourceRevision !== undefined) {
      return invalid("contract_missing");
    }
    return Object.freeze({
      state: binding.state,
      schemaVersion,
      ...(sourceRevision === undefined ? {} : { sourceRevision }),
      fixtureDigest,
      validateOutbound
    });
  } catch {
    return invalid("contract_missing");
  }
}

function validateBoundaryReceipt(value: unknown, binding: ReturnType<typeof contractBinding>, scope: TrustedScope, quote: PrivateQuoteSnapshot): unknown {
  const result = record(safeTree(value));
  if (result.ok !== true) {
    if (result.ok === false) {
      const failure = record(result.failure);
      if (failure.code === "scope_mismatch") return invalid("scope_mismatch");
      if (failure.code === "unsupported_schema_major") return invalid("unsupported_schema_major");
      return invalid("contract_rejected");
    }
    return invalid("contract_rejected");
  }
  exactKeys(result, ["ok", "value", "receipts"]);
  if (!Array.isArray(result.receipts) || result.receipts.length !== 1) return invalid("contract_rejected");
  const receipt = record(result.receipts[0]);
  exactKeys(receipt, ["shape", "schemaVersion", "tenantId", "projectId"]);
  if (receipt.shape !== "fulfillment_quote" || receipt.tenantId !== scope.tenantId || receipt.projectId !== scope.projectId) return invalid("scope_mismatch");
  const receiptSchemaVersion = safePinMetadata(receipt.schemaVersion);
  const receiptVersion = SCHEMA_VERSION.exec(receiptSchemaVersion);
  const bindingVersion = SCHEMA_VERSION.exec(binding.schemaVersion);
  if (receiptVersion === null || bindingVersion === null) return invalid("contract_rejected");
  if (receiptVersion[1] !== bindingVersion[1]) return invalid("unsupported_schema_major");
  if (receiptSchemaVersion !== binding.schemaVersion && binding.state === "accepted") return invalid("contract_rejected");
  const payload = safeTree(result.value);
  ensurePrivacySafe(payload, quoteMoneyScalars(quote), quoteOpaqueIdentifiers(quote));
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return invalid("contract_rejected");
  return payload;
}

function quoteMoneyScalars(quote: PrivateQuoteSnapshot): ReadonlySet<string> {
  const values = new Set<string>();
  const include = (amount: QuotedAmount): void => {
    if (amount.state === "known") {
      values.add(amount.value.decimal);
      values.add(amount.value.minorUnits);
    }
  };
  include(quote.breakdown.production);
  include(quote.breakdown.shipping);
  include(quote.breakdown.tax);
  include(quote.breakdown.fee);
  include(quote.breakdown.total);
  if (quote.breakdown.reconciliation.state === "reconciled") {
    values.add(quote.breakdown.reconciliation.expectedTotal.decimal);
    values.add(quote.breakdown.reconciliation.expectedTotal.minorUnits);
  }
  return values;
}

function quoteOpaqueIdentifiers(quote: PrivateQuoteSnapshot): ReadonlyMap<string, ReadonlySet<string>> {
  const identifiers = new Map<string, Set<string>>();
  const add = (field: string, value: string): void => {
    const fieldName = field.replace(/[^A-Za-z0-9]/gu, "").toLowerCase();
    const values = identifiers.get(fieldName) ?? new Set<string>();
    values.add(value);
    identifiers.set(fieldName, values);
  };
  const binding = quote.binding;
  for (const field of ["tenantId", "projectId", "providerId", "apiVersion", "catalogVersion", "sku", "variantId", "shippingMethod"] as const) {
    add(field, binding[field]);
  }
  for (const value of binding.options) add("options", value);
  for (const value of binding.materials) add("materials", value);
  add("countryCode", binding.destination.countryCode);
  if (binding.destination.regionCode !== undefined) add("regionCode", binding.destination.regionCode);
  return identifiers;
}

function isCanonicalTimestampValue(value: string): boolean {
  if (!CANONICAL_TIMESTAMP.test(value)) return false;
  try {
    const epoch = Date.parse(value);
    return Number.isSafeInteger(epoch) && new Date(epoch).toISOString() === value;
  } catch {
    return false;
  }
}

function isFinancialField(value: string): boolean {
  return FINANCIAL_FIELD.test(value.replace(/[^A-Za-z0-9]/gu, "").toLowerCase());
}

function ensurePrivacySafe(
  value: unknown,
  moneyScalars: ReadonlySet<string>,
  opaqueIdentifiers: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
  depth = 0,
  field = "",
  parentField = ""
): void {
  if (depth > SAFE_TREE_MAX_DEPTH) return invalid("contract_rejected");
  if (typeof value === "string") {
    if (OPAQUE_QUOTE_ID.test(value) || OPAQUE_DIGEST.test(value)) return;
    const fieldName = field.replace(/[^A-Za-z0-9]/gu, "").toLowerCase();
    const parentName = parentField.replace(/[^A-Za-z0-9]/gu, "").toLowerCase();
    if (QUOTE_TIMESTAMP_FIELDS.has(fieldName) && isCanonicalTimestampValue(value)) return;
    const financialScalar = isFinancialField(field) || (fieldName === "value" && isFinancialField(parentField));
    const exactMoney = EXACT_MONEY.test(value) || ((fieldName.includes("minorunit") || parentName.includes("minorunit")) && EXACT_MINOR_UNITS.test(value));
    if (financialScalar && exactMoney && moneyScalars.has(value)) return;
    const validatedOpaqueIdentifier = opaqueIdentifiers.get(fieldName)?.has(value) === true;
    if (EMAIL_OR_URL.test(value) || (!validatedOpaqueIdentifier && PHONE_LIKE.test(value)) || ADDRESS_LIKE.test(value) || SECRET_LIKE.test(value)) return invalid("contract_rejected");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) ensurePrivacySafe(item, moneyScalars, opaqueIdentifiers, depth + 1, field, parentField);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(key)) return invalid("contract_rejected");
      ensurePrivacySafe(child, moneyScalars, opaqueIdentifiers, depth + 1, key, field);
    }
  }
}

async function prepareBoundInput(input: unknown, scopeValue: unknown, now: string): Promise<{
  readonly snapshot: CatalogSnapshot;
  readonly selection: Record<string, unknown>;
  readonly binding: PrivateQuoteBinding;
}> {
  const request = parseRequest(input);
  const quantity = request.quantity;
  if (!Number.isSafeInteger(quantity) || (quantity as number) < 1 || (quantity as number) > MAX_QUANTITY) return invalid("invalid_input");
  const scope = snapshotScope(scopeValue);
  let snapshot: CatalogSnapshot;
  try {
    snapshot = await normalizeCatalogSnapshot(request.catalogSource);
  } catch {
    return invalid("invalid_input");
  }
  const rawSelection = record(safeTree(request.selection));
  if (rawSelection.snapshotIdentity !== snapshot.snapshotIdentity || rawSelection.catalogContentIdentity !== snapshot.catalogContentIdentity) return invalid("stale_quote");
  const evaluated = evaluateCatalogSelection(snapshot, rawSelection, now);
  if (evaluated.status !== "eligible" || evaluated.eligible !== true) {
    if (evaluated.reasons.includes("catalog_stale") || evaluated.reasons.includes("sku_removed") || evaluated.reasons.includes("sku_not_found") || evaluated.reasons.includes("spec_identity_changed")) return invalid("stale_quote");
    if (evaluated.reasons.includes("unsupported_mandatory_constraint") || evaluated.reasons.includes("unknown_mandatory_constraint") ||
        evaluated.details.some((detail) => detail.includes("unsupported") || detail.includes("unknown"))) return invalid("unsupported");
    return invalid("invalid_input");
  }
  const product = snapshot.products.find((entry) => entry.sku === rawSelection.sku && entry.variantId === rawSelection.variantId);
  if (product === undefined || product.availability !== "available" || product.specIdentity !== rawSelection.specIdentity) return invalid("stale_quote");
  const destinationSelection = record(rawSelection.destination);
  const destinationReference = safeDestinationReference(request.destinationReference);
  const destinationDigest = safeDigest(request.destinationDigest);
  const destination = Object.freeze({
    reference: destinationReference,
    digest: destinationDigest,
    countryCode: destinationSelection.countryCode as string,
    ...(destinationSelection.regionCode === undefined ? {} : { regionCode: destinationSelection.regionCode as string })
  });
  const selectionDigest = await digest(rawSelection);
  const bindingCore = {
    tenantId: scope.tenantId,
    projectId: scope.projectId,
    providerId: snapshot.providerId,
    apiVersion: snapshot.apiVersion,
    catalogVersion: snapshot.catalogVersion,
    catalogSnapshotIdentity: snapshot.snapshotIdentity,
    catalogContentIdentity: snapshot.catalogContentIdentity,
    sku: rawSelection.sku as string,
    variantId: rawSelection.variantId as string,
    specIdentity: rawSelection.specIdentity as string,
    selectionDigest,
    quantity: quantity as number,
    options: Object.freeze([...(rawSelection.options as readonly string[])]),
    materials: Object.freeze([...(rawSelection.materials as readonly string[])]),
    destination,
    shippingMethod: rawSelection.shippingMethod as string
  };
  const requestDigest = await digest(bindingCore);
  const binding: PrivateQuoteBinding = Object.freeze({ ...bindingCore, requestDigest });
  return { snapshot, selection: rawSelection, binding };
}

function quoteMethod(port: unknown): (...args: unknown[]) => unknown {
  return captureMethod(port, "quote");
}

function classifyProviderFailure(error: unknown): QuoteErrorCode {
  try {
    if (error !== null && (typeof error === "object" || typeof error === "function")) {
      const status = Object.getOwnPropertyDescriptor(error, "status");
      const code = Object.getOwnPropertyDescriptor(error, "code");
      if (status !== undefined && "value" in status && status.value === 429) return "rate_limit";
      if (code !== undefined && "value" in code && typeof code.value === "string" && ["RATE_LIMIT", "RATE_LIMITED"].includes(code.value.toUpperCase())) return "rate_limit";
    }
  } catch {
    return "provider_failure";
  }
  return "provider_failure";
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

/**
 * Validates a private catalog selection, invokes one bounded quote-only port,
 * normalizes exact decimal amounts, and delegates canonical encoding to the
 * injected shared-contract boundary. No order, payment, or budget operation is reachable here.
 */
export async function executePrivateQuote(input: unknown, dependencies: QuoteDependencies): Promise<PrivateQuoteResponse> {
  try {
    const nowBeforeCall = readNow(dependencyValue(dependencies, "clock"));
    const policy = quotePolicy(optionalDependencyValue(dependencies, "policy"));
    const contracts = dependencyValue<ContractValidator>(dependencies, "contracts");
    const validatorBinding = contractBinding(contracts, snapshotScope(dependencyValue(dependencies, "trustedScope")));
    const scope = snapshotScope(dependencyValue(dependencies, "trustedScope"));
    const quoteStore = optionalDependencyValue<QuoteSnapshotPersistence>(dependencies, "quoteStore");
    let saveQuote: QuoteSnapshotPersistence["save"] | undefined;
    if (quoteStore !== undefined) {
      try {
        saveQuote = dependencyValue<QuoteSnapshotPersistence["save"]>(quoteStore, "save");
        if (typeof saveQuote !== "function") throw new Error();
      } catch { return invalid("persistence_unavailable"); }
    }
    const prepared = await prepareBoundInput(input, scope, nowBeforeCall.text);
    const port = dependencyValue<BoundedQuotePort>(dependencies, "quotePort");
    const method = quoteMethod(port);
    consumeRateLimit(port, policy, nowBeforeCall.epochMs);
    const requestWithoutDigest = {
      providerId: prepared.binding.providerId,
      apiVersion: prepared.binding.apiVersion,
      catalogVersion: prepared.binding.catalogVersion,
      catalogSnapshotIdentity: prepared.binding.catalogSnapshotIdentity,
      catalogContentIdentity: prepared.binding.catalogContentIdentity,
      sku: prepared.binding.sku,
      variantId: prepared.binding.variantId,
      specIdentity: prepared.binding.specIdentity,
      selectionDigest: prepared.binding.selectionDigest,
      quantity: prepared.binding.quantity,
      options: prepared.binding.options,
      materials: prepared.binding.materials,
      destination: prepared.binding.destination,
      shippingMethod: prepared.binding.shippingMethod,
      personalization: prepared.selection.personalization === null ? null : Object.freeze({
        mode: record(prepared.selection.personalization).mode as string,
        fieldCount: (record(prepared.selection.personalization).fields as readonly unknown[]).length
      })
    };
    const providerInput: QuoteProviderRequest = Object.freeze({ ...requestWithoutDigest, requestDigest: prepared.binding.requestDigest });
    const controller = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutMarker = Object.freeze({ timeout: true });
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        controller.abort();
        reject(timeoutMarker);
      }, policy.timeoutMs);
    });
    let rawProviderResult: unknown;
    try {
      rawProviderResult = await Promise.race([
        Promise.resolve(Reflect.apply(method, port, [providerInput, Object.freeze({ operation: "quote" as const, signal: controller.signal })])),
        timeout
      ]);
    } catch (error) {
      if (error === timeoutMarker) throw internalQuoteError("timeout");
      throw internalQuoteError(classifyProviderFailure(error));
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
    const createdAt = readNow(dependencyValue(dependencies, "clock")).text;
    let normalized: Awaited<ReturnType<typeof normalizeProviderQuote>>;
    try {
      normalized = await normalizeProviderQuote(rawProviderResult, createdAt, policy);
    } catch (error) {
      const code = internalQuoteErrorCode(error);
      if (code === "invalid_input" || code === "missing_input") {
        throw internalQuoteError("provider_response_invalid");
      }
      throw error;
    }
    const terms = {
      providerQuoteReference: normalized.providerQuoteReference,
      currency: normalized.currency,
      currencyScale: normalized.currencyScale,
      breakdown: normalized.breakdown,
      expiry: normalized.expiry,
      leadTime: normalized.leadTime,
      warnings: normalized.warnings,
      providerNotes: normalized.providerNotes
    };
    const body = {
      localFormat: PRIVATE_QUOTE_FORMAT,
      termsFingerprint: normalized.termsFingerprint,
      status: normalized.status,
      binding: prepared.binding,
      catalogEvidenceMode: prepared.snapshot.source.evidenceMode,
      providerQuoteReference: normalized.providerQuoteReference,
      createdAt,
      expiry: normalized.expiry,
      currency: normalized.currency,
      currencyScale: normalized.currencyScale,
      breakdown: normalized.breakdown,
      leadTime: normalized.leadTime,
      warnings: normalized.warnings,
      providerNotes: normalized.providerNotes,
      financialEffect: "quote_only" as const
    };
    const termsFingerprint = await digest(terms);
    if (termsFingerprint !== normalized.termsFingerprint) return invalid("provider_response_invalid");
    const quoteId = `quote:${await digest(body)}`;
    const quote = deepFreeze({ ...body, quoteId }) as PrivateQuoteSnapshot;
    const outboundRequest = Object.freeze({
      operation: "quote" as const,
      requiredShapes: Object.freeze(["fulfillment_quote" as const]),
      value: quote,
      trustedScope: scope
    });
    let boundaryResult: unknown;
    try {
      boundaryResult = await Reflect.apply(validatorBinding.validateOutbound, contracts, [outboundRequest]);
    } catch {
      return invalid("contract_rejected");
    }
    let sharedPayload: unknown;
    try {
      sharedPayload = validateBoundaryReceipt(boundaryResult, validatorBinding, scope, quote);
    } catch (error) {
      const code = internalQuoteErrorCode(error);
      return invalid(code === "scope_mismatch" || code === "unsupported_schema_major" ? code : "contract_rejected");
    }
    if (quoteStore !== undefined && saveQuote !== undefined) {
      try { await Reflect.apply(saveQuote, quoteStore, [quote, scope]); }
      catch { return invalid("persistence_unavailable"); }
    }
    return deepFreeze({
      quote,
      sharedPayload,
      contractBinding: {
        state: validatorBinding.state,
        schemaVersion: validatorBinding.schemaVersion,
        ...(validatorBinding.sourceRevision === undefined ? {} : { sourceRevision: validatorBinding.sourceRevision }),
        fixtureDigest: validatorBinding.fixtureDigest
      }
    });
  } catch (error) {
    throw internalQuoteError(internalQuoteErrorCode(error) ?? "invalid_input");
  }
}

function quoteBody(snapshot: Record<string, unknown>): Record<string, unknown> {
  const quoteId = snapshot.quoteId;
  if (typeof quoteId !== "string" || !/^quote:sha256:[a-f0-9]{64}$/u.test(quoteId)) return invalid("provider_response_invalid");
  const body: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(snapshot)) if (key !== "quoteId") Object.defineProperty(body, key, { value, enumerable: true });
  return body;
}

const PRIVATE_QUOTE_KEYS = [
  "localFormat", "quoteId", "termsFingerprint", "status", "binding", "catalogEvidenceMode", "providerQuoteReference",
  "createdAt", "expiry", "currency", "currencyScale", "breakdown", "leadTime", "warnings", "providerNotes", "financialEffect"
] as const;
const PRIVATE_BINDING_KEYS = [
  "tenantId", "projectId", "providerId", "apiVersion", "catalogVersion", "catalogSnapshotIdentity", "catalogContentIdentity",
  "sku", "variantId", "specIdentity", "selectionDigest", "quantity", "options", "materials", "destination", "shippingMethod", "requestDigest"
] as const;
const PRIVATE_CODE = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/u;
const CATALOG_EVIDENCE_MODES = new Set(["synthetic_fixture", "documentation_reference", "account_observation", "unverified_import"]);

function snapshotCode(value: unknown): string {
  if (typeof value !== "string" || !PRIVATE_CODE.test(value)) return invalid();
  return value;
}

function snapshotAmountForProvider(value: unknown): ProviderAmountInput {
  const amount = record(value);
  if (amount.state === "unknown") {
    exactKeys(amount, ["state", "reasonCode"]);
    return { state: "unknown", reasonCode: safeUnknownReason(amount.reasonCode) };
  }
  if (amount.state !== "known") return invalid();
  exactKeys(amount, ["state", "value"]);
  const money = record(amount.value);
  exactKeys(money, ["currency", "scale", "decimal", "minorUnits"]);
  return { state: "known", decimal: money.decimal as string };
}

function snapshotLeadTimeForProvider(value: unknown): unknown {
  const leadTime = record(value);
  if (leadTime.state === "unknown") {
    exactKeys(leadTime, ["state", "reasonCode"]);
    return { state: "unknown", reasonCode: leadTime.reasonCode };
  }
  if (leadTime.state !== "known") return invalid();
  exactKeys(leadTime, ["state", "minimumDays", "maximumDays", "confidence"]);
  if (leadTime.confidence !== "estimate") return invalid();
  return { state: "known", minimumDays: leadTime.minimumDays, maximumDays: leadTime.maximumDays };
}

export async function validatePrivateQuoteSnapshot(value: unknown): Promise<PrivateQuoteSnapshot> {
  const quote = record(safeTree(value));
  exactKeys(quote, PRIVATE_QUOTE_KEYS);
  if (quote.localFormat !== PRIVATE_QUOTE_FORMAT || quote.financialEffect !== "quote_only" ||
      (quote.status !== "complete" && quote.status !== "incomplete") || !CATALOG_EVIDENCE_MODES.has(quote.catalogEvidenceMode as string)) return invalid();
  const createdAt = canonicalTimestamp(quote.createdAt);
  const quoteId = quote.quoteId;
  const termsFingerprint = safeDigest(quote.termsFingerprint);
  const providerQuoteReference = safeReference(quote.providerQuoteReference);
  const currency = quote.currency;
  const currencyScale = quote.currencyScale;
  if (typeof currency !== "string" || !/^[A-Z]{3}$/u.test(currency) || !Number.isSafeInteger(currencyScale) ||
      (currencyScale as number) < 0 || (currencyScale as number) > MAX_AMOUNT_SCALE) return invalid();

  const binding = record(quote.binding);
  exactKeys(binding, PRIVATE_BINDING_KEYS);
  for (const key of ["tenantId", "projectId"] as const) {
    safeScopeIdentifier(binding[key]);
  }
  for (const key of ["providerId", "apiVersion", "catalogVersion", "sku", "variantId", "shippingMethod"] as const) {
    snapshotCode(binding[key]);
  }
  for (const key of ["catalogSnapshotIdentity", "catalogContentIdentity", "specIdentity", "selectionDigest", "requestDigest"] as const) {
    safeDigest(binding[key]);
  }
  if (!Number.isSafeInteger(binding.quantity) || (binding.quantity as number) < 1 || (binding.quantity as number) > MAX_QUANTITY) return invalid();
  for (const key of ["options", "materials"] as const) {
    if (!Array.isArray(binding[key])) return invalid();
    for (const entry of binding[key] as readonly unknown[]) snapshotCode(entry);
  }
  const destination = record(binding.destination);
  const destinationKeys = Object.hasOwn(destination, "regionCode")
    ? ["reference", "digest", "countryCode", "regionCode"]
    : ["reference", "digest", "countryCode"];
  exactKeys(destination, destinationKeys);
  safeDestinationReference(destination.reference);
  safeDigest(destination.digest);
  if (typeof destination.countryCode !== "string" || !/^[A-Z]{2}$/u.test(destination.countryCode)) return invalid();
  if (destination.regionCode !== undefined && (typeof destination.regionCode !== "string" || !/^[A-Z0-9-]{1,16}$/u.test(destination.regionCode))) return invalid();
  const bindingCore: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(binding)) if (key !== "requestDigest") Object.defineProperty(bindingCore, key, { value: entry, enumerable: true });
  if (await digest(bindingCore) !== binding.requestDigest) return invalid();

  const expiry = record(quote.expiry);
  exactKeys(expiry, ["provider", "localPolicy", "effectiveValidUntil", "effectiveSource"]);
  const localPolicy = record(expiry.localPolicy);
  exactKeys(localPolicy, ["version", "validUntil"]);
  if (localPolicy.version !== "quote-local-policy/1") return invalid();
  const localValidUntil = canonicalTimestamp(localPolicy.validUntil);
  const localMaximumValidityMs = localValidUntil.epochMs - createdAt.epochMs;
  if (!Number.isSafeInteger(localMaximumValidityMs)) return invalid();
  const policy = quotePolicy({ localMaximumValidityMs });

  const breakdown = record(quote.breakdown);
  exactKeys(breakdown, ["production", "shipping", "tax", "fee", "total", "taxBasis", "reconciliation"]);
  const providerBreakdown = {
    production: snapshotAmountForProvider(breakdown.production),
    shipping: snapshotAmountForProvider(breakdown.shipping),
    tax: snapshotAmountForProvider(breakdown.tax),
    fee: snapshotAmountForProvider(breakdown.fee)
  };
  const providerExpiry = record(expiry.provider);
  if (providerExpiry.state === "known") exactKeys(providerExpiry, ["state", "validUntil"]);
  else if (providerExpiry.state === "unknown") exactKeys(providerExpiry, ["state", "reasonCode"]);
  else return invalid();
  const response = {
    providerQuoteReference,
    currency,
    currencyScale,
    breakdown: providerBreakdown,
    taxBasis: breakdown.taxBasis,
    total: snapshotAmountForProvider(breakdown.total),
    providerExpiry,
    leadTime: snapshotLeadTimeForProvider(quote.leadTime),
    warnings: quote.warnings,
    providerNotes: quote.providerNotes
  };
  const normalized = await normalizeProviderQuote(response, createdAt.text, policy);
  if (stableJson(normalized.expiry) !== stableJson(expiry) || stableJson(normalized.breakdown) !== stableJson(breakdown) ||
      stableJson(normalized.leadTime) !== stableJson(quote.leadTime) || stableJson(normalized.warnings) !== stableJson(quote.warnings) ||
      stableJson(normalized.providerNotes) !== stableJson(quote.providerNotes) || normalized.providerQuoteReference !== providerQuoteReference ||
      normalized.currency !== currency || normalized.currencyScale !== currencyScale || normalized.termsFingerprint !== termsFingerprint ||
      normalized.status !== quote.status) return invalid();
  if (typeof quoteId !== "string" || `quote:${await digest(quoteBody(quote))}` !== quoteId) return invalid();
  const typedQuote = quote as unknown as PrivateQuoteSnapshot;
  ensurePrivacySafe(quote, quoteMoneyScalars(typedQuote), quoteOpaqueIdentifiers(typedQuote));
  return quote as unknown as PrivateQuoteSnapshot;
}

function baseCurrentEvaluation(status: QuoteCurrentEvaluation["status"], reasons: readonly QuoteCurrentReason[], requiredActions: readonly QuoteRequiredAction[]): QuoteCurrentEvaluation {
  return Object.freeze({
    status,
    reasons: Object.freeze([...reasons]),
    requiredActions: Object.freeze([...new Set(requiredActions)]),
    quoteMayBePresentedForExternalReview: status === "current"
  });
}

/** Rechecks expiry, scope, catalog, selection, destination, quantity, and shipping before downstream use. */
export async function evaluatePrivateQuoteCurrent(
  quoteValue: unknown,
  currentInput: unknown,
  dependencies: Pick<QuoteDependencies, "clock" | "trustedScope">
): Promise<QuoteCurrentEvaluation> {
  try {
    const scope = snapshotScope(dependencyValue(dependencies, "trustedScope"));
    const now = readNow(dependencyValue(dependencies, "clock"));
    let quote: PrivateQuoteSnapshot;
    try {
      quote = await validatePrivateQuoteSnapshot(quoteValue);
    } catch {
      return baseCurrentEvaluation("invalid", ["quote_integrity_invalid"], ["requote", "renew_external_authorization"]);
    }
    const createdAt = canonicalTimestamp(quote.createdAt);
    if (now.epochMs < createdAt.epochMs) {
      return baseCurrentEvaluation("invalid", ["quote_integrity_invalid"], ["requote", "renew_external_authorization"]);
    }
    const expiry = record(quote.expiry);
    const effectiveValidUntil = canonicalTimestamp(expiry.effectiveValidUntil);
    if (effectiveValidUntil.epochMs <= now.epochMs) {
      return baseCurrentEvaluation("stale", ["quote_expired"], ["requote", "renew_external_authorization"]);
    }
    if (quote.status !== "complete") {
      return baseCurrentEvaluation("incomplete", ["quote_incomplete"], ["requote", "renew_external_authorization"]);
    }
    const originalBinding = record(quote.binding);
    if (originalBinding.tenantId !== scope.tenantId || originalBinding.projectId !== scope.projectId) {
      return baseCurrentEvaluation("stale", ["trusted_scope_changed"], ["requote", "renew_external_authorization"]);
    }
    let prepared: Awaited<ReturnType<typeof prepareBoundInput>>;
    try {
      prepared = await prepareBoundInput(currentInput, scope, now.text);
    } catch (error) {
      const code = internalQuoteErrorCode(error);
      if (code === "stale_quote") {
        return baseCurrentEvaluation("stale", ["catalog_stale"], ["refresh_catalog", "revalidate_selection", "requote", "renew_external_authorization"]);
      }
      if (code === "unsupported") {
        return baseCurrentEvaluation("stale", ["selection_ineligible"], ["revalidate_selection", "requote", "renew_external_authorization"]);
      }
      return baseCurrentEvaluation("invalid", ["selection_ineligible"], ["revalidate_selection", "requote", "renew_external_authorization"]);
    }
    const currentBinding = prepared.binding;
    const changed: QuoteCurrentReason[] = [];
    if (originalBinding.catalogSnapshotIdentity !== currentBinding.catalogSnapshotIdentity ||
        originalBinding.catalogContentIdentity !== currentBinding.catalogContentIdentity ||
        originalBinding.catalogVersion !== currentBinding.catalogVersion ||
        originalBinding.providerId !== currentBinding.providerId || originalBinding.apiVersion !== currentBinding.apiVersion) changed.push("catalog_changed");
    if (originalBinding.sku !== currentBinding.sku || originalBinding.variantId !== currentBinding.variantId ||
        originalBinding.specIdentity !== currentBinding.specIdentity || originalBinding.selectionDigest !== currentBinding.selectionDigest ||
        stableJson(originalBinding.options) !== stableJson(currentBinding.options) ||
        stableJson(originalBinding.materials) !== stableJson(currentBinding.materials)) changed.push("selection_changed");
    if (stableJson(originalBinding.destination) !== stableJson(currentBinding.destination)) changed.push("destination_changed");
    if (originalBinding.quantity !== currentBinding.quantity || originalBinding.shippingMethod !== currentBinding.shippingMethod ||
        originalBinding.requestDigest !== currentBinding.requestDigest) changed.push("request_changed");
    if (changed.length > 0) {
      const actions: QuoteRequiredAction[] = [];
      if (changed.includes("catalog_changed")) actions.push("refresh_catalog");
      actions.push("revalidate_selection", "requote", "renew_external_authorization");
      return baseCurrentEvaluation("stale", changed, actions);
    }
    const breakdown = record(quote.breakdown);
    const total = record(breakdown.total);
    const reconciliation = record(breakdown.reconciliation);
    if (total.state !== "known" || reconciliation.state !== "reconciled") {
      return baseCurrentEvaluation("incomplete", ["quote_incomplete"], ["requote", "renew_external_authorization"]);
    }
    return baseCurrentEvaluation("current", [], ["obtain_external_authorization"]);
  } catch {
    return baseCurrentEvaluation("invalid", ["quote_integrity_invalid"], ["requote", "renew_external_authorization"]);
  }
}
