import { createHash } from "node:crypto";
import {
  evaluateProviderPolicy,
  PRODIGI_SANDBOX_ADAPTER_ID,
  PRODIGI_SANDBOX_BASE_URL,
  PRODIGI_SANDBOX_OPERATION_ENDPOINTS,
  PRODIGI_SANDBOX_PRODUCT_READ_PATH,
  PRODIGI_SANDBOX_PRODUCT_READ_SELECTION,
  type SandboxDecisionVerifier,
  type SandboxOperation
} from "./provider-matrix.js";
import { withServerSecret, type ServerSecretSource } from "./security.js";
import { PRODIGI_SANDBOX_SECRET_BINDING } from "./prodigi-secrets.js";
import { decodeProdigiProductDetails, prodigiProductDetailsPath, type ProdigiProductDetails } from "./prodigi-product-details.js";
import type { BoundedQuotePort, QuoteProviderCallContext, QuoteProviderRequest, QuoteUnknownReason } from "./quotes.js";
import type { StatusResult } from "./types.js";

/**
 * Prodigi Print API v4 sandbox adapter.
 *
 * Maps the connector's private quote request and a private order-create input
 * to the documented v4 `POST /v4.0/quotes`, `POST /v4.0/Orders` and
 * `GET /v4.0/orders/{id}` requests, and projects the documented responses into
 * bounded, PII-free observations. All network access goes through an injected
 * HTTP port; the module never constructs a live URL and refuses to send unless
 * sandbox calls are explicitly enabled, the owner sandbox decision verifies,
 * and a sandbox-class credential resolves through the secret-reference port.
 */

export const PRODIGI_SANDBOX_ORIGIN = "https://api.sandbox.prodigi.com" as const;

/** The one URL the sandbox product read may request. */
export const PRODIGI_SANDBOX_PRODUCT_READ_URL = `${PRODIGI_SANDBOX_ORIGIN}${PRODIGI_SANDBOX_PRODUCT_READ_PATH}` as const;

export type ProdigiShippingMethod = "Budget" | "Standard" | "StandardPlus" | "Express" | "Overnight";
/** Create-quote spelling: the quote reference lists these lowercase values. */
export type ProdigiQuoteShippingMethod = "budget" | "standard" | "standardplus" | "express" | "overnight";
export type ProdigiSizing = "fillPrintArea" | "fitPrintArea" | "stretchToPrintArea";

export interface ProdigiHttpRequest {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal: AbortSignal;
}

export interface ProdigiHttpResponse {
  readonly status: number;
  readonly bodyText: string;
  /**
   * Native bytes the port actually received, counted while streaming and before
   * any decoding. Optional; when present, the product read refuses a value over
   * 1 MiB before it parses anything.
   */
  readonly bodyBytes?: number;
}

/** Transport port. Tests inject recorded fixtures; production may use `createFetchProdigiHttpPort`. */
export interface ProdigiHttpPort {
  send(request: ProdigiHttpRequest): Promise<ProdigiHttpResponse>;
}

export interface ProdigiSandboxDecision {
  readonly decisionReference: string;
  readonly sku: string;
  readonly destinationCountryCode: string;
  readonly shippingMethod: ProdigiShippingMethod;
}

export interface ProdigiSandboxClientOptions {
  readonly http: ProdigiHttpPort;
  readonly secrets: ServerSecretSource;
  readonly decision: ProdigiSandboxDecision;
  readonly decisionVerifier: SandboxDecisionVerifier;
  /** Must be exactly `true`. Defaults off so constructing a client sends nothing. */
  readonly sandboxCallsEnabled?: boolean;
  /** Secret reference name; defaults to `prodigi/sandbox/api-key`. Never a raw key. */
  readonly secretReference?: string;
  readonly timeoutMs?: number;
  /**
   * Trusted-host port that resolves the owner-action references of the one
   * sandbox product read. Required by `getProductDetails`; absent means every
   * product read fails closed with `grant_unverified` before any key is read.
   */
  readonly productReadGrantVerifier?: SandboxProductReadGrantVerifier;
  /** Clock for grant expiry. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Opaque references naming the single trusted owner-action approval of one
 * product read. They are identifiers, never credentials, and a reference that
 * merely exists is not authority: only the trusted host's verification is.
 */
export interface ProdigiProductReadReferences {
  /** Explicit owner permission naming this one request. */
  readonly ownerPermissionReference: string;
  /** The actually accepted sandbox account terms. */
  readonly accountTermsReference: string;
  /** The per-request cost budget. Request cost is unknown, never assumed zero. */
  readonly requestCostBudgetReference: string;
  /** `sha256:<64 hex>` of the exclusive receipt location this one request is bound to. */
  readonly receiptBinding: string;
}

export interface SandboxProductReadGrantRequest extends ProdigiProductReadReferences {
  readonly operation: "productDetails";
  readonly providerId: "prodigi";
  readonly apiVersion: "v4.0";
  readonly credentialClass: "sandbox";
  readonly decisionReference: string;
  readonly sku: string;
  readonly destinationCountryCode: string;
  readonly shippingMethod: string;
  readonly method: "GET";
  readonly url: string;
  readonly maxProviderRequests: 1;
  readonly maxRetries: 0;
}

/** What a trusted host returns after resolving every reference with its owning authority. */
export interface VerifiedSandboxProductReadGrant extends SandboxProductReadGrantRequest {
  readonly ownerPermissionVerified: true;
  readonly accountTermsAccepted: true;
  readonly requestCostBudgetApproved: true;
  readonly singleUse: true;
  /** ISO-8601 UTC time after which the grant is void. */
  readonly expiresAt: string;
}

export interface SandboxProductReadGrantVerifier {
  /**
   * Resolve the references with their owning authorities and return the request
   * echoed with the verified flags, or `undefined`. Must have no external side
   * effect: it can run in a preflight and again just before the request.
   */
  verify(request: SandboxProductReadGrantRequest): Promise<VerifiedSandboxProductReadGrant | undefined>;
}

export type ProdigiSandboxErrorCode =
  | "sandbox_calls_disabled"
  | "aborted"
  | "decision_unverified"
  | "decision_mismatch"
  | "invalid_input"
  | "credential_unavailable"
  | "authentication_failed"
  | "validation_failed"
  | "not_found"
  | "rate_limited"
  | "provider_unavailable"
  | "timeout"
  | "invalid_response"
  | "request_budget_exhausted"
  | "grant_unverified";

/** Whether the provider may have applied the request. Order creation uses `unknown` when uncertain. */
export type ProdigiSideEffectState = "not_dispatched" | "possible" | "confirmed" | "unknown";

const ERROR_MESSAGES: Readonly<Record<ProdigiSandboxErrorCode, string>> = {
  sandbox_calls_disabled: "Prodigi sandbox calls are disabled.",
  aborted: "The Prodigi request was aborted before it was sent.",
  decision_unverified: "The owner sandbox decision could not be verified.",
  decision_mismatch: "The request does not match the verified sandbox decision.",
  invalid_input: "The Prodigi request input did not pass validation.",
  credential_unavailable: "The Prodigi sandbox credential is unavailable.",
  authentication_failed: "Prodigi rejected the sandbox credential.",
  validation_failed: "Prodigi rejected the request as invalid.",
  not_found: "Prodigi did not find the requested entity.",
  rate_limited: "Prodigi rate-limited the request.",
  provider_unavailable: "Prodigi was unavailable or returned an unexpected status.",
  timeout: "The Prodigi request timed out.",
  invalid_response: "The Prodigi response is invalid or unsupported.",
  request_budget_exhausted: "The one permitted Prodigi product read was already used.",
  grant_unverified: "The trusted owner-action grant for the Prodigi product read could not be verified."
};

export class ProdigiSandboxError extends Error {
  readonly code: ProdigiSandboxErrorCode;
  readonly sideEffectState: ProdigiSideEffectState;
  readonly httpStatus: number | null;
  constructor(code: ProdigiSandboxErrorCode, sideEffectState: ProdigiSideEffectState, httpStatus: number | null = null) {
    super(ERROR_MESSAGES[code]);
    this.name = "ProdigiSandboxError";
    this.code = code;
    this.sideEffectState = sideEffectState;
    this.httpStatus = httpStatus;
  }
}

// ---------------------------------------------------------------------------
// Input validation helpers

const SKU_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const COUNTRY_PATTERN = /^[A-Z]{2}$/u;
const CURRENCY_SCALES: Readonly<Record<string, number>> = Object.freeze({ USD: 2, GBP: 2, EUR: 2, CAD: 2, AUD: 2 });
const ATTRIBUTE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,63}$/u;
const PRINT_AREA_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
const ORDER_ID_PATTERN = /^ord_[A-Za-z0-9]{1,64}$/u;
const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u;
const MD5_PATTERN = /^[a-f0-9]{32}$/u;
const AMOUNT_PATTERN = /^(0|[1-9][0-9]{0,14})(\.[0-9]{1,6})?$/u;
const ISSUE_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9._]{0,127}$/u;
const MAX_RESPONSE_CHARS = 1_048_576;
const MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60_000;
/** The product read has its own, shorter hard deadline. */
const PRODUCT_READ_DEFAULT_TIMEOUT_MS = 15_000;
const PRODUCT_READ_MAX_TIMEOUT_MS = 30_000;
const SHA256_BINDING_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const GRANT_EXPIRY_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/u;

const SHIPPING_METHODS: Readonly<Record<string, ProdigiShippingMethod>> = Object.freeze({
  budget: "Budget",
  standard: "Standard",
  standardplus: "StandardPlus",
  express: "Express",
  overnight: "Overnight"
});

function invalidInput(): never {
  throw new ProdigiSandboxError("invalid_input", "not_dispatched");
}

function invalidResponse(sideEffectState: ProdigiSideEffectState, httpStatus: number | null): never {
  throw new ProdigiSandboxError("invalid_response", sideEffectState, httpStatus);
}

/**
 * Case-insensitive mapping of a configured shipping choice to the documented
 * create-order enum (`Budget`, `Standard`, `StandardPlus`, `Express`, `Overnight`).
 */
export function toProdigiShippingMethod(value: unknown): ProdigiShippingMethod {
  if (typeof value !== "string") return invalidInput();
  const key = value.toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(SHIPPING_METHODS, key)) return invalidInput();
  return SHIPPING_METHODS[key] as ProdigiShippingMethod;
}

function boundedText(value: unknown, max: number, optional: false): string;
function boundedText(value: unknown, max: number, optional: true): string | undefined;
function boundedText(value: unknown, max: number, optional: boolean): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > max || value.trim() !== value ||
      /[\u0000-\u001F\u007F]/u.test(value)) return invalidInput();
  return value;
}

function attributesOf(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalidInput();
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 16) return invalidInput();
  const result: Record<string, string> = {};
  for (const [key, attribute] of entries) {
    if (!ATTRIBUTE_KEY_PATTERN.test(key)) return invalidInput();
    result[key] = boundedText(attribute, 64, false);
  }
  return Object.freeze(result);
}

function httpsAssetUrl(value: unknown): string {
  const text = boundedText(value, 2048, false);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return invalidInput();
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.hash !== "") return invalidInput();
  return text;
}

/**
 * The create-quote reference documents `shippingMethod` as `budget`,
 * `standard`, `standardplus`, `express` or `overnight`, while create-order uses
 * PascalCase. Each endpoint gets its own documented spelling.
 */
function toQuoteShippingMethod(method: ProdigiShippingMethod): ProdigiQuoteShippingMethod {
  return method.toLowerCase() as ProdigiQuoteShippingMethod;
}

// ---------------------------------------------------------------------------
// Request mapping (pure; exported for tests and review)

export interface ProdigiQuoteMappingConfig {
  /** Prodigi attributes approved for the selected SKU (from the print specification). */
  readonly attributes?: Readonly<Record<string, string>>;
  readonly printArea?: string;
  readonly currencyCode: string;
}

/** Maps the connector's private `QuoteProviderRequest` to a v4 create-quote body. */
export function mapQuoteRequest(request: QuoteProviderRequest, config: ProdigiQuoteMappingConfig): Readonly<Record<string, unknown>> {
  if (request === null || typeof request !== "object") return invalidInput();
  if (request.providerId !== "prodigi") return invalidInput();
  if (typeof request.sku !== "string" || !SKU_PATTERN.test(request.sku)) return invalidInput();
  if (!Number.isSafeInteger(request.quantity) || request.quantity < 1 || request.quantity > 1000) return invalidInput();
  const countryCode = request.destination?.countryCode;
  if (typeof countryCode !== "string" || !COUNTRY_PATTERN.test(countryCode)) return invalidInput();
  if (request.personalization !== null) return invalidInput();
  const currencyCode = config.currencyCode;
  if (typeof currencyCode !== "string" || CURRENCY_SCALES[currencyCode] === undefined) return invalidInput();
  const printArea = config.printArea ?? "default";
  if (!PRINT_AREA_PATTERN.test(printArea)) return invalidInput();
  return Object.freeze({
    shippingMethod: toQuoteShippingMethod(toProdigiShippingMethod(request.shippingMethod)),
    destinationCountryCode: countryCode,
    currencyCode,
    items: [{
      sku: request.sku,
      copies: request.quantity,
      attributes: attributesOf(config.attributes),
      assets: [{ printArea }]
    }]
  });
}

export interface ProdigiOrderRecipientInput {
  readonly name: string;
  readonly email?: string;
  readonly phoneNumber?: string;
  readonly address: {
    readonly line1: string;
    readonly line2?: string;
    readonly postalOrZipCode: string;
    readonly countryCode: string;
    readonly townOrCity: string;
    readonly stateOrCounty?: string;
  };
}

export interface ProdigiOrderItemInput {
  readonly merchantReference?: string;
  readonly sku: string;
  readonly copies: number;
  readonly sizing: ProdigiSizing;
  readonly attributes?: Readonly<Record<string, string>>;
  readonly assets: readonly { readonly printArea: string; readonly url: string; readonly md5Hash?: string }[];
}

/**
 * Private, connector-local order-create input. The recipient is expected to be
 * resolved server-side from an encrypted scoped reference immediately before
 * the call; it is sent to Prodigi and never returned, logged or persisted here.
 */
export interface ProdigiOrderCreateInput {
  readonly merchantReference: string;
  readonly idempotencyKey: string;
  readonly shippingMethod: string;
  readonly recipient: ProdigiOrderRecipientInput;
  readonly items: readonly ProdigiOrderItemInput[];
}

/** Maps the private order-create input to a v4 create-order body. No callback URL or metadata is sent. */
export function mapOrderRequest(input: ProdigiOrderCreateInput): Readonly<Record<string, unknown>> {
  if (input === null || typeof input !== "object") return invalidInput();
  const merchantReference = boundedText(input.merchantReference, 100, false);
  const idempotencyKey = boundedText(input.idempotencyKey, 100, false);
  if (!REFERENCE_PATTERN.test(merchantReference) || !REFERENCE_PATTERN.test(idempotencyKey)) return invalidInput();
  const recipient = input.recipient;
  if (recipient === null || typeof recipient !== "object") return invalidInput();
  const address = recipient.address;
  if (address === null || typeof address !== "object") return invalidInput();
  if (typeof address.countryCode !== "string" || !COUNTRY_PATTERN.test(address.countryCode)) return invalidInput();
  const mappedAddress: Record<string, string> = {
    line1: boundedText(address.line1, 256, false),
    postalOrZipCode: boundedText(address.postalOrZipCode, 32, false),
    countryCode: address.countryCode,
    townOrCity: boundedText(address.townOrCity, 128, false)
  };
  const line2 = boundedText(address.line2, 256, true);
  if (line2 !== undefined) mappedAddress.line2 = line2;
  const stateOrCounty = boundedText(address.stateOrCounty, 128, true);
  if (stateOrCounty !== undefined) mappedAddress.stateOrCounty = stateOrCounty;
  const mappedRecipient: Record<string, unknown> = { name: boundedText(recipient.name, 256, false), address: mappedAddress };
  const email = boundedText(recipient.email, 254, true);
  if (email !== undefined) mappedRecipient.email = email;
  const phoneNumber = boundedText(recipient.phoneNumber, 32, true);
  if (phoneNumber !== undefined) mappedRecipient.phoneNumber = phoneNumber;

  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 10) return invalidInput();
  const items = input.items.map((item) => {
    if (item === null || typeof item !== "object") return invalidInput();
    if (typeof item.sku !== "string" || !SKU_PATTERN.test(item.sku)) return invalidInput();
    if (!Number.isSafeInteger(item.copies) || item.copies < 1 || item.copies > 1000) return invalidInput();
    if (item.sizing !== "fillPrintArea" && item.sizing !== "fitPrintArea" && item.sizing !== "stretchToPrintArea") return invalidInput();
    if (!Array.isArray(item.assets) || item.assets.length < 1 || item.assets.length > 8) return invalidInput();
    const assets = (item.assets as readonly unknown[]).map((raw) => {
      const asset = raw as ProdigiOrderItemInput["assets"][number];
      if (asset === null || typeof asset !== "object" || typeof asset.printArea !== "string" || !PRINT_AREA_PATTERN.test(asset.printArea)) {
        return invalidInput();
      }
      const mapped: Record<string, string> = { printArea: asset.printArea, url: httpsAssetUrl(asset.url) };
      if (asset.md5Hash !== undefined) {
        if (typeof asset.md5Hash !== "string" || !MD5_PATTERN.test(asset.md5Hash)) return invalidInput();
        mapped.md5Hash = asset.md5Hash;
      }
      return mapped;
    });
    const mapped: Record<string, unknown> = { sku: item.sku, copies: item.copies, sizing: item.sizing, attributes: attributesOf(item.attributes), assets };
    const itemReference = boundedText(item.merchantReference, 100, true);
    if (itemReference !== undefined) {
      if (!REFERENCE_PATTERN.test(itemReference)) return invalidInput();
      mapped.merchantReference = itemReference;
    }
    return mapped;
  });

  return Object.freeze({
    merchantReference,
    idempotencyKey,
    shippingMethod: toProdigiShippingMethod(input.shippingMethod),
    recipient: mappedRecipient,
    items
  });
}

// ---------------------------------------------------------------------------
// Response projection

type JsonRecord = Readonly<Record<string, unknown>>;

function record(value: unknown, sideEffect: ProdigiSideEffectState, status: number): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalidResponse(sideEffect, status);
  return value as JsonRecord;
}

function outcomeOf(body: JsonRecord): string {
  return typeof body.outcome === "string" ? body.outcome.toLowerCase() : "";
}

function issueCodes(value: unknown, sideEffect: ProdigiSideEffectState, status: number): readonly string[] {
  if (value === undefined || value === null) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 64) return invalidResponse(sideEffect, status);
  const codes: string[] = [];
  for (const issue of value) {
    const code = record(issue, sideEffect, status).errorCode;
    if (typeof code !== "string" || !ISSUE_CODE_PATTERN.test(code)) return invalidResponse(sideEffect, status);
    if (!codes.includes(code)) codes.push(code);
  }
  return Object.freeze(codes.slice(0, 16));
}

interface Money {
  readonly decimal: string;
  readonly minor: bigint;
}

function money(value: unknown, currency: string, scale: number, status: number): Money | undefined {
  if (value === undefined || value === null) return undefined;
  const cost = record(value, "not_dispatched", status);
  if (cost.currency !== currency || typeof cost.amount !== "string" || !AMOUNT_PATTERN.test(cost.amount)) {
    return invalidResponse("not_dispatched", status);
  }
  const [whole = "0", fraction = ""] = cost.amount.split(".");
  if (fraction.length > scale) return invalidResponse("not_dispatched", status);
  const minor = BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, "0") || "0");
  return { decimal: cost.amount, minor };
}

/** Provider quote shape consumed by `executePrivateQuote` (see quotes.ts). */
export interface ProdigiProviderQuote {
  readonly providerQuoteReference: string;
  readonly currency: string;
  readonly currencyScale: number;
  readonly breakdown: {
    readonly production: ProviderAmount;
    readonly shipping: ProviderAmount;
    readonly tax: ProviderAmount;
    readonly fee: ProviderAmount;
  };
  readonly taxBasis: "included" | "excluded" | "unknown";
  readonly total: ProviderAmount;
  readonly providerExpiry: { readonly state: "unknown"; readonly reasonCode: QuoteUnknownReason };
  readonly leadTime: { readonly state: "unknown"; readonly reasonCode: QuoteUnknownReason };
  readonly warnings: readonly string[];
  readonly providerNotes: readonly string[];
}

type ProviderAmount = { readonly state: "known"; readonly decimal: string } | { readonly state: "unknown"; readonly reasonCode: QuoteUnknownReason };

function known(value: Money | undefined): ProviderAmount {
  return value === undefined ? { state: "unknown", reasonCode: "not_provided" } : { state: "known", decimal: value.decimal };
}

/**
 * Projects a v4 create-quote response for one requested shipping method.
 *
 * - `production` = `costSummary.items`, `shipping` = `costSummary.shipping`.
 * - `fee` = `costSummary.branding`; this adapter never requests branded inserts,
 *   so an absent branding cost is an explicit known zero.
 * - `tax` = `costSummary.totalTax`, `total` = `costSummary.totalCost`; absent
 *   values stay unknown, never zero.
 * - The docs say `totalCost` includes tax but not whether line amounts already
 *   include it, so the tax basis is taken from exact reconciliation only:
 *   lines + tax = total gives `excluded`, lines = total with tax > 0 gives
 *   `included`, anything else is `unknown`.
 * - Prodigi documents no quote identifier or expiry; the reference is a local
 *   digest and expiry and lead time are reported as undisclosed.
 */
export function projectQuoteResponse(
  body: unknown,
  expected: { readonly shippingMethod: ProdigiShippingMethod; readonly currencyCode: string; readonly requestDigest: string },
  httpStatus = 200
): ProdigiProviderQuote {
  const scale = CURRENCY_SCALES[expected.currencyCode];
  if (scale === undefined) return invalidInput();
  const envelope = record(body, "not_dispatched", httpStatus);
  const outcome = outcomeOf(envelope);
  if (outcome !== "created" && outcome !== "createdwithissues") return invalidResponse("not_dispatched", httpStatus);
  const quotes = envelope.quotes;
  if (!Array.isArray(quotes) || quotes.length === 0 || quotes.length > 8) return invalidResponse("not_dispatched", httpStatus);
  const matching = quotes.filter((quote) => {
    const method = record(quote, "not_dispatched", httpStatus).shipmentMethod;
    return typeof method === "string" && method.toLowerCase() === expected.shippingMethod.toLowerCase();
  });
  if (matching.length !== 1) return invalidResponse("not_dispatched", httpStatus);
  const quote = record(matching[0], "not_dispatched", httpStatus);
  const summary = record(quote.costSummary, "not_dispatched", httpStatus);
  const currency = expected.currencyCode;
  const items = money(summary.items, currency, scale, httpStatus);
  const shipping = money(summary.shipping, currency, scale, httpStatus);
  if (items === undefined || shipping === undefined) return invalidResponse("not_dispatched", httpStatus);
  const fee = money(summary.branding, currency, scale, httpStatus) ?? { decimal: "0", minor: 0n };
  const tax = money(summary.totalTax, currency, scale, httpStatus);
  const total = money(summary.totalCost, currency, scale, httpStatus);

  let taxBasis: ProdigiProviderQuote["taxBasis"] = "unknown";
  if (tax !== undefined && total !== undefined) {
    const lines = items.minor + shipping.minor + fee.minor;
    if (lines + tax.minor === total.minor) taxBasis = "excluded";
    else if (lines === total.minor && tax.minor > 0n && tax.minor <= total.minor) taxBasis = "included";
  }

  const warnings = [
    ...issueCodes(envelope.issues, "not_dispatched", httpStatus),
    ...issueCodes(quote.issues, "not_dispatched", httpStatus)
  ].filter((code, index, all) => all.indexOf(code) === index).slice(0, 16);

  const digest = createHash("sha256")
    .update(JSON.stringify([expected.requestDigest, expected.shippingMethod, currency, items.decimal, shipping.decimal,
      fee.decimal, tax?.decimal ?? null, total?.decimal ?? null]))
    .digest("hex");

  return Object.freeze({
    providerQuoteReference: `prodigi-quote:sha256-${digest}`,
    currency,
    currencyScale: scale,
    breakdown: Object.freeze({ production: known(items), shipping: known(shipping), tax: known(tax), fee: known(fee) }),
    taxBasis,
    total: known(total),
    providerExpiry: Object.freeze({ state: "unknown" as const, reasonCode: "not_disclosed" as const }),
    leadTime: Object.freeze({ state: "unknown" as const, reasonCode: "not_disclosed" as const }),
    warnings: Object.freeze(warnings),
    providerNotes: Object.freeze([])
  });
}

export type ProdigiOrderStage = "InProgress" | "Complete" | "Cancelled";
export type ProdigiStepState = "NotStarted" | "InProgress" | "Complete" | "Error";

/**
 * PII-free order observation. Recipient, asset URLs, tracking numbers and URLs,
 * charges and metadata are dropped. A tracking number can reveal the delivery
 * town and signer, so only its presence is kept.
 */
export interface ProdigiOrderObservation {
  readonly outcome: string;
  readonly orderId: string;
  readonly created: string;
  readonly lastUpdated: string | null;
  readonly stage: ProdigiOrderStage;
  readonly details: Readonly<Record<"downloadAssets" | "printReadyAssetsPrepared" | "allocateProductionLocation" | "inProduction" | "shipping", ProdigiStepState>>;
  readonly issueCodes: readonly string[];
  readonly shipments: readonly {
    readonly id: string;
    readonly status: string;
    /** Display-only; `null` when absent or not plain text. */
    readonly carrier: string | null;
    readonly hasTrackingNumber: boolean;
    readonly dispatchDate: string | null;
  }[];
  readonly normalizedState: StatusResult["normalizedState"];
}

const STAGES: Readonly<Record<string, ProdigiOrderStage>> = Object.freeze({ inprogress: "InProgress", complete: "Complete", cancelled: "Cancelled" });
const STEP_STATES: Readonly<Record<string, ProdigiStepState>> = Object.freeze({
  notstarted: "NotStarted", inprogress: "InProgress", complete: "Complete", error: "Error"
});
const DETAIL_KEYS = ["downloadAssets", "printReadyAssetsPrepared", "allocateProductionLocation", "inProduction", "shipping"] as const;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?(Z|[+-]\d{2}:\d{2})?$/u;
const SHORT_TEXT = /^[A-Za-z0-9][A-Za-z0-9 ._:/#-]{0,127}$/u;
const CARRIER_TEXT = /^[A-Za-z0-9][A-Za-z0-9 ._:/#()&,'+-]{0,127}$/u;

function lookup<T>(table: Readonly<Record<string, T>>, value: unknown): T | undefined {
  if (typeof value !== "string") return undefined;
  const key = value.toLowerCase();
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

function optionalShort(value: unknown, sideEffect: ProdigiSideEffectState, status: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !SHORT_TEXT.test(value)) return invalidResponse(sideEffect, status);
  return value;
}

/** Display-only optional text degrades to `null` instead of failing the whole read. */
function lenientText(value: unknown, pattern: RegExp): string | null {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

/**
 * Status mapping. `Complete` means shipping notifications were sent for all
 * items, not delivery, so it maps to `shipped`. Any step in `Error` maps to
 * `unknown` because the docs do not say whether such errors are terminal.
 */
function normalizeOrderState(stage: ProdigiOrderStage, details: ProdigiOrderObservation["details"]): StatusResult["normalizedState"] {
  if (stage === "Cancelled") return "cancelled";
  if (stage === "Complete") return "shipped";
  if (DETAIL_KEYS.some((key) => details[key] === "Error")) return "unknown";
  if (details.shipping !== "NotStarted") return "in_production";
  if (details.inProduction !== "NotStarted") return "in_production";
  return "accepted";
}

export function projectOrderResponse(
  body: unknown,
  allowedOutcomes: readonly string[],
  sideEffect: ProdigiSideEffectState,
  httpStatus = 200
): ProdigiOrderObservation {
  const envelope = record(body, sideEffect, httpStatus);
  const outcome = outcomeOf(envelope);
  if (!allowedOutcomes.includes(outcome)) return invalidResponse(sideEffect, httpStatus);
  const order = record(envelope.order, sideEffect, httpStatus);
  if (typeof order.id !== "string" || !ORDER_ID_PATTERN.test(order.id)) return invalidResponse(sideEffect, httpStatus);
  if (typeof order.created !== "string" || !TIMESTAMP_PATTERN.test(order.created)) return invalidResponse(sideEffect, httpStatus);
  const lastUpdated = order.lastUpdated === undefined || order.lastUpdated === null ? null : order.lastUpdated;
  if (lastUpdated !== null && (typeof lastUpdated !== "string" || !TIMESTAMP_PATTERN.test(lastUpdated))) return invalidResponse(sideEffect, httpStatus);
  const status = record(order.status, sideEffect, httpStatus);
  const stage = lookup(STAGES, status.stage);
  if (stage === undefined) return invalidResponse(sideEffect, httpStatus);
  const rawDetails = record(status.details, sideEffect, httpStatus);
  const details = {} as Record<(typeof DETAIL_KEYS)[number], ProdigiStepState>;
  for (const key of DETAIL_KEYS) {
    const state = lookup(STEP_STATES, rawDetails[key]);
    if (state === undefined) return invalidResponse(sideEffect, httpStatus);
    details[key] = state;
  }
  const rawShipments = order.shipments ?? [];
  if (!Array.isArray(rawShipments) || rawShipments.length > 64) return invalidResponse(sideEffect, httpStatus);
  const shipments = rawShipments.map((raw) => {
    const shipment = record(raw, sideEffect, httpStatus);
    const id = optionalShort(shipment.id, sideEffect, httpStatus);
    const shipmentStatus = optionalShort(shipment.status, sideEffect, httpStatus);
    if (id === null || shipmentStatus === null) return invalidResponse(sideEffect, httpStatus);
    const carrierRecord = shipment.carrier;
    const carrier = carrierRecord !== null && typeof carrierRecord === "object" && !Array.isArray(carrierRecord)
      ? lenientText((carrierRecord as JsonRecord).name, CARRIER_TEXT)
      : lenientText(carrierRecord, CARRIER_TEXT);
    const tracking = shipment.tracking;
    const trackingNumber = tracking !== null && typeof tracking === "object" && !Array.isArray(tracking)
      ? (tracking as JsonRecord).number
      : undefined;
    const hasTrackingNumber = typeof trackingNumber === "string" && trackingNumber.trim() !== "";
    const dispatchDate = shipment.dispatchDate;
    if (dispatchDate !== undefined && dispatchDate !== null && (typeof dispatchDate !== "string" || !TIMESTAMP_PATTERN.test(dispatchDate))) {
      return invalidResponse(sideEffect, httpStatus);
    }
    return Object.freeze({ id, status: shipmentStatus, carrier, hasTrackingNumber, dispatchDate: (dispatchDate as string | undefined) ?? null });
  });
  const frozenDetails = Object.freeze(details);
  return Object.freeze({
    outcome,
    orderId: order.id,
    created: order.created,
    lastUpdated: lastUpdated as string | null,
    stage,
    details: frozenDetails,
    issueCodes: issueCodes(status.issues, sideEffect, httpStatus),
    shipments: Object.freeze(shipments),
    normalizedState: normalizeOrderState(stage, frozenDetails)
  });
}

// ---------------------------------------------------------------------------
// Client

type OperationKey = SandboxOperation;

interface SendOutcome {
  readonly ok: boolean;
  readonly status: number;
  readonly body?: unknown;
  readonly error?: ProdigiSandboxError;
}

function classifyHttpFailure(status: number, operation: OperationKey): ProdigiSandboxError {
  // For order creation, only explicit client errors prove the order was not created.
  const ambiguous: ProdigiSideEffectState = operation === "submit" ? "unknown" : "not_dispatched";
  // The product read always reached the provider when a status came back, so it
  // never reports `not_dispatched` after the request left the port.
  const answered: ProdigiSideEffectState = operation === "productDetails" ? "possible" : "not_dispatched";
  if (status === 401 || status === 403) return new ProdigiSandboxError("authentication_failed", answered, status);
  if (status === 400) return new ProdigiSandboxError("validation_failed", answered, status);
  if (status === 404) return new ProdigiSandboxError("not_found", answered, status);
  if (status === 429) return new ProdigiSandboxError("rate_limited", answered, status);
  return new ProdigiSandboxError("provider_unavailable", operation === "productDetails" ? "possible" : ambiguous, status);
}

export class ProdigiSandboxClient {
  readonly #http: ProdigiHttpPort;
  readonly #secrets: ServerSecretSource;
  readonly #decision: ProdigiSandboxDecision;
  readonly #verifier: SandboxDecisionVerifier;
  readonly #enabled: boolean;
  readonly #secretReference: string;
  readonly #timeoutMs: number;
  readonly #productReadTimeoutMs: number;
  readonly #productReadGrantVerifier: SandboxProductReadGrantVerifier | undefined;
  readonly #now: () => number;
  #productReadClaimed = false;

  constructor(options: ProdigiSandboxClientOptions) {
    if (options === null || typeof options !== "object") throw new ProdigiSandboxError("invalid_input", "not_dispatched");
    if (options.http === null || typeof options.http !== "object" || typeof options.http.send !== "function") throw new ProdigiSandboxError("invalid_input", "not_dispatched");
    if (options.secrets === null || typeof options.secrets !== "object" || typeof options.secrets.load !== "function") throw new ProdigiSandboxError("invalid_input", "not_dispatched");
    const decision = options.decision;
    if (decision === null || typeof decision !== "object" || typeof decision.sku !== "string" || !SKU_PATTERN.test(decision.sku) ||
        typeof decision.destinationCountryCode !== "string" || !COUNTRY_PATTERN.test(decision.destinationCountryCode) ||
        typeof decision.decisionReference !== "string" || decision.decisionReference.trim() === "") {
      throw new ProdigiSandboxError("invalid_input", "not_dispatched");
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw new ProdigiSandboxError("invalid_input", "not_dispatched");
    const secretReference = options.secretReference ?? PRODIGI_SANDBOX_SECRET_BINDING.reference;
    if (typeof secretReference !== "string" || secretReference.length === 0) throw new ProdigiSandboxError("invalid_input", "not_dispatched");
    this.#http = options.http;
    this.#secrets = options.secrets;
    this.#decision = Object.freeze({
      decisionReference: decision.decisionReference,
      sku: decision.sku,
      destinationCountryCode: decision.destinationCountryCode,
      shippingMethod: toProdigiShippingMethod(decision.shippingMethod)
    });
    this.#verifier = options.decisionVerifier;
    this.#enabled = options.sandboxCallsEnabled === true;
    this.#secretReference = secretReference;
    this.#timeoutMs = timeoutMs;
    this.#productReadTimeoutMs = Math.min(options.timeoutMs ?? PRODUCT_READ_DEFAULT_TIMEOUT_MS, PRODUCT_READ_MAX_TIMEOUT_MS);
    const grantVerifier = options.productReadGrantVerifier;
    if (grantVerifier !== undefined && (grantVerifier === null || typeof grantVerifier !== "object")) throw new ProdigiSandboxError("invalid_input", "not_dispatched");
    this.#productReadGrantVerifier = grantVerifier;
    if (options.now !== undefined && typeof options.now !== "function") throw new ProdigiSandboxError("invalid_input", "not_dispatched");
    this.#now = options.now ?? Date.now;
  }

  get decision(): ProdigiSandboxDecision {
    return this.#decision;
  }

  /** Creates a quote for the verified decision. Quotes are non-charging and create no order. */
  async createQuote(
    request: QuoteProviderRequest,
    config: ProdigiQuoteMappingConfig,
    signal?: AbortSignal
  ): Promise<ProdigiProviderQuote> {
    const body = mapQuoteRequest(request, config);
    const shippingMethod = toProdigiShippingMethod(body.shippingMethod);
    this.#assertMatchesDecision(request.sku, request.destination.countryCode, shippingMethod);
    const result = await this.#send("quote", "POST", PRODIGI_SANDBOX_OPERATION_ENDPOINTS.quote.path, body, signal);
    return projectQuoteResponse(result, {
      shippingMethod,
      currencyCode: config.currencyCode,
      requestDigest: request.requestDigest
    });
  }

  /** Creates a sandbox order. Uncertain transport outcomes report `sideEffectState: "unknown"`. */
  async createOrder(input: ProdigiOrderCreateInput, signal?: AbortSignal): Promise<ProdigiOrderObservation> {
    const body = mapOrderRequest(input);
    const items = body.items as readonly { readonly sku: string }[];
    for (const item of items) {
      this.#assertMatchesDecision(item.sku, (body.recipient as { address: { countryCode: string } }).address.countryCode, body.shippingMethod as ProdigiShippingMethod);
    }
    const result = await this.#send("submit", "POST", PRODIGI_SANDBOX_OPERATION_ENDPOINTS.submit.path, body, signal);
    return projectOrderResponse(result, ["created", "onhold", "createdwithissues", "alreadyexists"], "unknown");
  }

  /** Reads one order by Prodigi order ID. */
  async getOrder(orderId: string, signal?: AbortSignal): Promise<ProdigiOrderObservation> {
    if (typeof orderId !== "string" || !ORDER_ID_PATTERN.test(orderId)) return invalidInput();
    const path = PRODIGI_SANDBOX_OPERATION_ENDPOINTS.status.path.replace("{prodigi_order_id}", orderId);
    const result = await this.#send("status", "GET", path, undefined, signal);
    return projectOrderResponse(result, ["ok"], "not_dispatched");
  }

  /**
   * Reads Product Details for the verified decision SKU, which must be the
   * owner-delegated validation selection. There is no SKU, URL or host
   * parameter. The client permits exactly one call: the claim is taken
   * synchronously, before any await, and is never released, so a retry or a
   * concurrent second call fails with `request_budget_exhausted` before any
   * gate, key read or port call. Once the request has left the port every
   * failure reports `sideEffectState: "possible"`, never `not_dispatched`.
   */
  async getProductDetails(references: ProdigiProductReadReferences, signal?: AbortSignal): Promise<ProdigiProductDetails> {
    if (this.#productReadClaimed) throw new ProdigiSandboxError("request_budget_exhausted", "not_dispatched");
    this.#productReadClaimed = true;
    const grantRequest = this.#productReadGrantRequest(references);
    const path = prodigiProductDetailsPath(this.#decision.sku);
    // One hard deadline covers the whole call: the verifiers and the secret source as well as the port. Its abort
    // signal is what stops a continuation that resumes after the deadline from ever dispatching.
    const state: DispatchState = { dispatched: false };
    const deadline = new AbortController();
    const onCallerAbort = (): void => deadline.abort();
    try {
      signal?.addEventListener("abort", onCallerAbort, { once: true });
    } catch {
      throw new ProdigiSandboxError("invalid_input", "not_dispatched");
    }
    let sent: { readonly body: unknown; readonly status: number };
    try {
      sent = await sendWithDeadline(
        () => this.#dispatch("productDetails", "GET", path, undefined, isAborted(signal) ? AbortSignal.abort() : deadline.signal, grantRequest, state),
        this.#productReadTimeoutMs,
        () => deadline.abort()
      ) as { readonly body: unknown; readonly status: number };
    } catch (error) {
      if (error instanceof DeadlineExceeded) throw new ProdigiSandboxError("timeout", state.dispatched ? "possible" : "not_dispatched");
      throw error;
    } finally {
      try {
        signal?.removeEventListener("abort", onCallerAbort);
      } catch {
        // Listener cleanup cannot change the outcome.
      }
    }
    try {
      return decodeProdigiProductDetails(sent.body, this.#decision.sku);
    } catch {
      throw new ProdigiSandboxError("invalid_response", "possible", sent.status);
    }
  }

  #productReadGrantRequest(references: ProdigiProductReadReferences): SandboxProductReadGrantRequest {
    if (references === null || typeof references !== "object") return invalidInput();
    const ownerPermissionReference = boundedText(references.ownerPermissionReference, 100, false);
    const accountTermsReference = boundedText(references.accountTermsReference, 100, false);
    const requestCostBudgetReference = boundedText(references.requestCostBudgetReference, 100, false);
    const receiptBinding = boundedText(references.receiptBinding, 71, false);
    if (!REFERENCE_PATTERN.test(ownerPermissionReference) || !REFERENCE_PATTERN.test(accountTermsReference) ||
        !REFERENCE_PATTERN.test(requestCostBudgetReference) || !SHA256_BINDING_PATTERN.test(receiptBinding)) {
      return invalidInput();
    }
    const decision = this.#decision;
    if (decision.sku !== PRODIGI_SANDBOX_PRODUCT_READ_SELECTION.sku ||
        decision.destinationCountryCode !== PRODIGI_SANDBOX_PRODUCT_READ_SELECTION.destinationCountryCode ||
        decision.shippingMethod !== PRODIGI_SANDBOX_PRODUCT_READ_SELECTION.shippingMethod) {
      throw new ProdigiSandboxError("decision_mismatch", "not_dispatched");
    }
    return Object.freeze({
      operation: "productDetails",
      providerId: "prodigi",
      apiVersion: "v4.0",
      credentialClass: "sandbox",
      decisionReference: decision.decisionReference,
      sku: decision.sku,
      destinationCountryCode: decision.destinationCountryCode,
      shippingMethod: decision.shippingMethod,
      method: "GET",
      url: PRODIGI_SANDBOX_PRODUCT_READ_URL,
      maxProviderRequests: 1,
      maxRetries: 0,
      ownerPermissionReference,
      accountTermsReference,
      requestCostBudgetReference,
      receiptBinding
    });
  }

  /** Throws `grant_unverified` unless the trusted host echoes this exact request with every flag true and an unexpired grant. */
  async #verifyProductReadGrant(request: SandboxProductReadGrantRequest): Promise<void> {
    const fail = (): never => {
      throw new ProdigiSandboxError("grant_unverified", "not_dispatched");
    };
    const verifier = this.#productReadGrantVerifier;
    if (verifier === undefined) return fail();
    let raw: unknown;
    try {
      const verify: unknown = verifier.verify;
      if (typeof verify !== "function") return fail();
      raw = await verify.call(verifier, request);
    } catch {
      return fail();
    }
    const grant = plainDataRecord(raw);
    if (grant === undefined) return fail();
    const requestKeys = Object.keys(request) as (keyof SandboxProductReadGrantRequest)[];
    const allowed = new Set<string>([...requestKeys, "ownerPermissionVerified", "accountTermsAccepted", "requestCostBudgetApproved", "singleUse", "expiresAt"]);
    if (Object.keys(grant).some((key) => !allowed.has(key))) return fail();
    for (const key of requestKeys) if (grant[key] !== request[key]) return fail();
    if (grant.ownerPermissionVerified !== true || grant.accountTermsAccepted !== true ||
        grant.requestCostBudgetApproved !== true || grant.singleUse !== true) return fail();
    const expiresAt = grant.expiresAt;
    if (typeof expiresAt !== "string" || !GRANT_EXPIRY_PATTERN.test(expiresAt)) return fail();
    const expiry = Date.parse(expiresAt);
    let now: number;
    try {
      now = this.#now();
    } catch {
      return fail();
    }
    if (!Number.isFinite(expiry) || !Number.isFinite(now) || expiry <= now) return fail();
  }

  #assertMatchesDecision(sku: string, countryCode: string, shippingMethod: ProdigiShippingMethod): void {
    if (sku !== this.#decision.sku || countryCode !== this.#decision.destinationCountryCode || shippingMethod !== this.#decision.shippingMethod) {
      throw new ProdigiSandboxError("decision_mismatch", "not_dispatched");
    }
  }

  async #send(operation: OperationKey, method: "GET" | "POST", path: string, body: unknown, signal: AbortSignal | undefined): Promise<unknown> {
    return (await this.#dispatch(operation, method, path, body, signal, undefined)).body;
  }

  async #dispatch(
    operation: OperationKey,
    method: "GET" | "POST",
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
    grantRequest: SandboxProductReadGrantRequest | undefined,
    state?: DispatchState
  ): Promise<{ readonly body: unknown; readonly status: number }> {
    if (!this.#enabled) throw new ProdigiSandboxError("sandbox_calls_disabled", "not_dispatched");
    if (isAborted(signal)) throw new ProdigiSandboxError("aborted", "not_dispatched");
    const policy = await evaluateProviderPolicy({
      adapterId: PRODIGI_SANDBOX_ADAPTER_ID,
      mode: "sandbox",
      providerId: "prodigi",
      endpoint: PRODIGI_SANDBOX_BASE_URL,
      operation,
      credentialClass: "sandbox",
      sku: this.#decision.sku,
      destinationCountryCode: this.#decision.destinationCountryCode,
      shippingMethod: this.#decision.shippingMethod,
      decisionReference: this.#decision.decisionReference
    }, this.#verifier);
    // The policy is the source of truth: only `sandbox_call_permitted` with
    // `providerCallPermitted: true` for this exact route may dispatch.
    if (policy.status !== "sandbox_call_permitted" || policy.providerCallPermitted !== true ||
        policy.sandboxRoute?.method !== method || policy.sandboxRoute.path !== PRODIGI_SANDBOX_OPERATION_ENDPOINTS[operation].path) {
      throw new ProdigiSandboxError("decision_unverified", "not_dispatched");
    }
    // Paths come only from the fixed endpoint table; the origin is the fixed sandbox host.
    if (!path.startsWith("/v4.0/")) throw new ProdigiSandboxError("invalid_input", "not_dispatched");
    const productRead = operation === "productDetails";
    if (productRead) {
      // One concrete path only, and the trusted owner-action grant is resolved
      // before the credential is ever loaded.
      if (path !== PRODIGI_SANDBOX_PRODUCT_READ_PATH || grantRequest === undefined) throw new ProdigiSandboxError("invalid_input", "not_dispatched");
      await this.#verifyProductReadGrant(grantRequest);
    } else if (grantRequest !== undefined) {
      throw new ProdigiSandboxError("invalid_input", "not_dispatched");
    }
    const url = `${PRODIGI_SANDBOX_ORIGIN}${path}`;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const http = this.#http;
    const timeoutMs = productRead ? this.#productReadTimeoutMs : this.#timeoutMs;

    const uncertain: ProdigiSideEffectState = uncertainState(operation);
    const dispatch: DispatchState = state ?? { dispatched: false };
    let outcome: SendOutcome;
    try {
      outcome = await withServerSecret<SendOutcome>({
        providerId: "prodigi",
        secretReference: this.#secretReference,
        mode: "sandbox",
        source: this.#secrets,
        use: async ({ secret }) => sendWithSecret(http, operation, method, url, payload, secret, timeoutMs, signal, dispatch, productRead)
      });
    } catch {
      // Once the request was handed to the port, the provider may have applied
      // it: an order may or may not exist, so the outcome is unknown.
      if (dispatch.dispatched) throw new ProdigiSandboxError("provider_unavailable", uncertain);
      throw new ProdigiSandboxError("credential_unavailable", "not_dispatched");
    }
    if (!outcome.ok) throw outcome.error ?? new ProdigiSandboxError("provider_unavailable", uncertain);
    return { body: outcome.body, status: outcome.status };
  }
}

/** The side-effect state once the request has been handed to the port and the outcome is uncertain. */
function uncertainState(operation: OperationKey): ProdigiSideEffectState {
  if (operation === "submit") return "unknown";
  return operation === "productDetails" ? "possible" : "not_dispatched";
}

function plainDataRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) return undefined;
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return undefined;
  }
}

class DeadlineExceeded extends Error {}

/**
 * Settles with the first of the operation's own result and a hard deadline, even
 * if a port or verifier ignores its AbortSignal. The operation's promise always
 * gets a handler, so a late rejection is never unhandled, and the single timer
 * is cleared on every path.
 */
function sendWithDeadline(send: () => Promise<unknown>, timeoutMs: number, onDeadline: () => void): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      onDeadline();
      reject(new DeadlineExceeded());
    }, timeoutMs);
    let attempt: Promise<unknown>;
    try {
      attempt = Promise.resolve(send());
    } catch (error) {
      settled = true;
      clearTimeout(timer);
      reject(error);
      return;
    }
    attempt.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

interface DispatchState {
  dispatched: boolean;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  if (signal === undefined) return false;
  try {
    return signal.aborted === true;
  } catch {
    return true;
  }
}

async function sendWithSecret(
  http: ProdigiHttpPort,
  operation: OperationKey,
  method: "GET" | "POST",
  url: string,
  payload: string | undefined,
  secret: string,
  timeoutMs: number,
  external: AbortSignal | undefined,
  dispatch: DispatchState,
  productRead: boolean
): Promise<SendOutcome> {
  const uncertain: ProdigiSideEffectState = uncertainState(operation);
  // The signal may have aborted while the policy or secret was resolving.
  if (isAborted(external)) return { ok: false, status: 0, error: new ProdigiSandboxError("aborted", "not_dispatched") };
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  try {
    external?.addEventListener("abort", onAbort, { once: true });
  } catch {
    return { ok: false, status: 0, error: new ProdigiSandboxError("invalid_input", "not_dispatched") };
  }
  let timedOut = false;
  // The product read is bounded by the whole-call deadline in `getProductDetails`, which also bounds a port that ignores the signal.
  const timer = productRead ? undefined : setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const headers: Record<string, string> = { "X-API-Key": secret, Accept: "application/json" };
  if (payload !== undefined) headers["Content-Type"] = "application/json";
  let status: number;
  let text: unknown;
  let declaredBytes: unknown;
  try {
    dispatch.dispatched = true;
    const request = Object.freeze({
      method,
      url,
      headers: Object.freeze(headers),
      ...(payload === undefined ? {} : { body: payload }),
      signal: controller.signal
    });
    const response: unknown = await http.send(request);
    // Every response field is read inside the try: a throwing getter after
    // dispatch is an uncertain outcome, never "not dispatched".
    if (response === null || typeof response !== "object") {
      return { ok: false, status: 0, error: new ProdigiSandboxError("invalid_response", uncertain) };
    }
    const rawStatus: unknown = (response as ProdigiHttpResponse).status;
    if (typeof rawStatus !== "number" || !Number.isSafeInteger(rawStatus)) {
      return { ok: false, status: 0, error: new ProdigiSandboxError("invalid_response", uncertain) };
    }
    status = rawStatus;
    if (status < 200 || status > 299) return { ok: false, status, error: classifyHttpFailure(status, operation) };
    text = (response as ProdigiHttpResponse).bodyText;
    if (productRead) declaredBytes = (response as ProdigiHttpResponse).bodyBytes;
  } catch {
    const error = timedOut
      ? new ProdigiSandboxError("timeout", uncertain)
      : new ProdigiSandboxError("provider_unavailable", uncertain);
    return { ok: false, status: 0, error };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    try {
      external?.removeEventListener("abort", onAbort);
    } catch {
      // Listener cleanup failure cannot change the dispatched outcome.
    }
  }
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_RESPONSE_CHARS) {
    return { ok: false, status, error: new ProdigiSandboxError("invalid_response", uncertain, status) };
  }
  if (productRead) {
    // The read answers 200 only. Native byte counts are checked before the text
    // is parsed: the port's own count when it gives one, then the UTF-8 length.
    const bytesOk = declaredBytes === undefined ||
      (typeof declaredBytes === "number" && Number.isSafeInteger(declaredBytes) && declaredBytes >= 0 && declaredBytes <= MAX_RESPONSE_BYTES);
    if (status !== 200 || !bytesOk || Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
      return { ok: false, status, error: new ProdigiSandboxError("invalid_response", uncertain, status) };
    }
  }
  try {
    return { ok: true, status, body: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, status, error: new ProdigiSandboxError("invalid_response", uncertain, status) };
  }
}

/**
 * Adapts the client to the existing `BoundedQuotePort` so `executePrivateQuote`
 * can normalize Prodigi quotes. The port exposes no order or payment method.
 */
export function createProdigiQuotePort(client: ProdigiSandboxClient, config: ProdigiQuoteMappingConfig): BoundedQuotePort {
  return Object.freeze({
    async quote(request: QuoteProviderRequest, context: QuoteProviderCallContext): Promise<unknown> {
      return client.createQuote(request, config, context.signal);
    }
  });
}

/** Map an order observation to the runtime's `StatusResult`. */
export function toStatusResult(observation: ProdigiOrderObservation, observedAt: string): StatusResult {
  return Object.freeze({
    providerRequestId: observation.orderId,
    providerStatus: observation.stage,
    normalizedState: observation.normalizedState,
    observedAt
  });
}

/**
 * Reads at most `MAX_RESPONSE_BYTES` while streaming and cancels the body past
 * the limit. An oversized body becomes `""`, which the client rejects.
 */
async function readBoundedBody(response: Response): Promise<string> {
  const declared = response.headers?.get?.("content-length");
  if (declared !== null && declared !== undefined && /^\d+$/u.test(declared) && Number(declared) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return "";
  }
  const body = response.body;
  if (body === null || body === undefined) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      return "";
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * Fetch-backed HTTP port with redirects disabled and a body bounded while
 * streaming. It is only ever handed URLs under the fixed sandbox origin by the
 * client above.
 */
export function createFetchProdigiHttpPort(fetchImpl: typeof fetch = globalThis.fetch): ProdigiHttpPort {
  return Object.freeze({
    async send(request: ProdigiHttpRequest): Promise<ProdigiHttpResponse> {
      if (!request.url.startsWith(`${PRODIGI_SANDBOX_ORIGIN}/`)) throw new Error("refused");
      const response = await fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body === undefined ? {} : { body: request.body }),
        redirect: "error",
        signal: request.signal
      });
      const status = response.status;
      if (status < 200 || status > 299) {
        await response.body?.cancel().catch(() => undefined);
        return { status, bodyText: "" };
      }
      return { status, bodyText: await readBoundedBody(response) };
    }
  });
}

// ---------------------------------------------------------------------------
// Sandbox product read: strict transport and receipt-safe projection

function refusedProductReadRequest(): never {
  throw new Error("refused");
}

/**
 * Accepts only the one product-read request shape the client builds: GET, the
 * exact fixed URL, exactly the `X-API-Key` and `Accept` headers, no body and an
 * abort signal. Anything else is refused before it can reach a network port.
 */
function assertProductReadRequest(request: unknown): asserts request is ProdigiHttpRequest {
  try {
    if (request === null || typeof request !== "object") return refusedProductReadRequest();
    const candidate = request as Partial<ProdigiHttpRequest>;
    if (candidate.method !== "GET" || candidate.url !== PRODIGI_SANDBOX_PRODUCT_READ_URL || candidate.body !== undefined) return refusedProductReadRequest();
    const signal: unknown = candidate.signal;
    if (signal === null || typeof signal !== "object" || typeof (signal as AbortSignal).aborted !== "boolean") return refusedProductReadRequest();
    const headers: unknown = candidate.headers;
    if (headers === null || typeof headers !== "object" || Array.isArray(headers)) return refusedProductReadRequest();
    const names = Object.keys(headers).sort();
    const record = headers as Record<string, unknown>;
    if (names.length !== 2 || names[0] !== "Accept" || names[1] !== "X-API-Key" || record.Accept !== "application/json" ||
        typeof record["X-API-Key"] !== "string" || record["X-API-Key"].length === 0) return refusedProductReadRequest();
  } catch {
    return refusedProductReadRequest();
  }
}

async function readCountedBody(response: Response): Promise<{ readonly text: string; readonly bytes: number }> {
  const declared = response.headers?.get?.("content-length");
  if (declared !== null && declared !== undefined && /^\d+$/u.test(declared) && Number(declared) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return { text: "", bytes: Number(declared) };
  }
  const body = response.body;
  if (body === null || body === undefined) return { text: "", bytes: 0 };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    // The native byte count is checked before the chunk is kept or decoded.
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      return { text: "", bytes: total };
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(joined), bytes: total };
}

/**
 * Fetch-backed port for the one sandbox product read. It requests only the
 * fixed URL (no redirect is followed, a 3xx throws), counts native response
 * bytes before decoding, discards every non-2xx body, and reports the counted
 * bytes as `bodyBytes`.
 */
export function createProdigiProductReadFetchPort(fetchImpl: typeof fetch = globalThis.fetch): ProdigiHttpPort {
  return Object.freeze({
    async send(request: ProdigiHttpRequest): Promise<ProdigiHttpResponse> {
      assertProductReadRequest(request);
      const response = await fetchImpl(PRODIGI_SANDBOX_PRODUCT_READ_URL, {
        method: "GET",
        headers: { "X-API-Key": request.headers["X-API-Key"] as string, Accept: "application/json" },
        redirect: "error",
        signal: request.signal
      });
      const status = response.status;
      if (status < 200 || status > 299) {
        await response.body?.cancel().catch(() => undefined);
        return { status, bodyText: "", bodyBytes: 0 };
      }
      const { text, bytes } = await readCountedBody(response);
      return { status, bodyText: text, bodyBytes: bytes };
    }
  });
}

/** What the one-shot transport itself observed, independent of how the client classified the outcome. */
export interface ProdigiProductReadTransportSnapshot {
  /** Calls into `send`, including refused ones. */
  readonly attempts: number;
  /** Requests forwarded to the inner port: 0 or 1, ever. */
  readonly dispatched: number;
  /** Attempts stopped before the inner port (second call or wrong request shape). */
  readonly refused: number;
  readonly state: "idle" | "pending" | "returned" | "threw";
  readonly responseStatus: number | null;
  /** Native response bytes: the port's own count, else the UTF-8 length of the body text. */
  readonly responseBytes: number | null;
}

/**
 * Wraps a port so that at most one request can ever reach it. The attempt
 * counter is incremented synchronously, before anything else, so a second or
 * concurrent call is refused before it can touch the inner port. The snapshot
 * counts the dispatch itself, so a receipt stays accurate even when the
 * response is later rejected as invalid.
 */
export function createOneShotProdigiProductReadPort(inner: ProdigiHttpPort): {
  readonly port: ProdigiHttpPort;
  snapshot(): ProdigiProductReadTransportSnapshot;
} {
  let attempts = 0;
  let dispatched = 0;
  let refused = 0;
  let state: ProdigiProductReadTransportSnapshot["state"] = "idle";
  let responseStatus: number | null = null;
  let responseBytes: number | null = null;
  const port: ProdigiHttpPort = Object.freeze({
    async send(request: ProdigiHttpRequest): Promise<ProdigiHttpResponse> {
      attempts += 1;
      if (attempts > 1) {
        refused += 1;
        throw new Error("refused");
      }
      try {
        assertProductReadRequest(request);
      } catch {
        refused += 1;
        throw new Error("refused");
      }
      dispatched += 1;
      state = "pending";
      let response: ProdigiHttpResponse;
      try {
        response = await inner.send(request);
      } catch (error) {
        state = "threw";
        throw error;
      }
      state = "returned";
      try {
        const status: unknown = response?.status;
        responseStatus = typeof status === "number" && Number.isSafeInteger(status) ? status : null;
        const counted: unknown = response?.bodyBytes;
        const text: unknown = response?.bodyText;
        responseBytes = typeof counted === "number" && Number.isSafeInteger(counted) && counted >= 0
          ? counted
          : typeof text === "string" ? Buffer.byteLength(text, "utf8") : null;
      } catch {
        // A hostile response object cannot change what was dispatched.
      }
      return response;
    }
  });
  return Object.freeze({
    port,
    snapshot: (): ProdigiProductReadTransportSnapshot => Object.freeze({ attempts, dispatched, refused, state, responseStatus, responseBytes })
  });
}

export interface ProdigiProductReadObservation {
  readonly sku: string;
  /** SHA-256 (hex) of the canonical JSON of the decoded Product Details DTO. */
  readonly decodedSha256: string;
  readonly productDimensions: { readonly width: number; readonly height: number; readonly units: string };
  readonly attributeNames: readonly string[];
  /** Values of the attribute named `finish`; empty when the product has none. */
  readonly finishAttributeValues: readonly string[];
  readonly variantCount: number;
  readonly variantsShippingToUS: number;
  readonly shipsToIncludesUS: boolean;
  readonly printAreas: readonly { readonly name: string; readonly required: boolean }[];
  /** Distinct resolutions of the `default` print area across the variants that declare one. */
  readonly defaultPrintAreaResolutions: readonly { readonly horizontal: number; readonly vertical: number }[];
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

/**
 * Projects one decoded Product Details DTO to the facts a receipt may keep.
 * It drops the description and copies no raw text beyond names and values the
 * decoder already bounded; the hash covers the whole decoded DTO.
 */
export function projectProductReadObservation(details: ProdigiProductDetails): ProdigiProductReadObservation {
  const finishKey = Object.keys(details.attributes).find((name) => name.toLowerCase() === "finish");
  const finishes = finishKey === undefined ? [] : [...new Set(details.attributes[finishKey] ?? [])].sort();
  const resolutions = new Map<string, { horizontal: number; vertical: number }>();
  let shippingToUS = 0;
  for (const variant of details.variants) {
    if (variant.shipsTo.includes("US")) shippingToUS += 1;
    const size = variant.printAreaSizes.default;
    if (size !== undefined) resolutions.set(`${size.horizontalResolution}x${size.verticalResolution}`, { horizontal: size.horizontalResolution, vertical: size.verticalResolution });
  }
  return Object.freeze({
    sku: details.sku,
    decodedSha256: createHash("sha256").update(canonicalJson(details), "utf8").digest("hex"),
    productDimensions: Object.freeze({ width: details.productDimensions.width, height: details.productDimensions.height, units: details.productDimensions.units }),
    attributeNames: Object.freeze(Object.keys(details.attributes).sort()),
    finishAttributeValues: Object.freeze(finishes),
    variantCount: details.variants.length,
    variantsShippingToUS: shippingToUS,
    shipsToIncludesUS: shippingToUS > 0,
    printAreas: Object.freeze(Object.keys(details.printAreas).sort().map((name) => Object.freeze({ name, required: details.printAreas[name]?.required === true }))),
    defaultPrintAreaResolutions: Object.freeze([...resolutions.values()]
      .sort((a, b) => a.horizontal - b.horizontal || a.vertical - b.vertical).slice(0, 16).map((entry) => Object.freeze(entry)))
  });
}
