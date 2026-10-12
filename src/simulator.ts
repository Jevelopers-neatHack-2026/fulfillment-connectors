// @ts-ignore Node built-in types are intentionally not a package dependency; execution targets Node 24.
import { createHash } from "node:crypto";
import type {
  AdapterCallContext,
  CancelCommand,
  CancelResult,
  Clock,
  Operation,
  PreflightCommand,
  PreflightReport,
  PreSubmitContext,
  ProviderAdapter,
  ProviderDescriptor,
  ProviderResult,
  QuoteCommand,
  QuoteResult,
  ShipmentCommand,
  ShipmentResult,
  StatusCommand,
  StatusResult,
  SubmitCommand,
  SubmitResult
} from "./types.js";

/** Private local fixture identity. It is not a supplier or accepted contract version. */
export const SIMULATOR_FIXTURE_VERSION = "fc-mock-development/2";
export const SIMULATOR_PROVIDER_ID = "development-deterministic-simulator";

export type SimulatorOrderStatus = StatusResult["normalizedState"];
export type SimulatorFaultKind =
  | "refuse_before_dispatch"
  | "unsupported"
  | "rate_limit"
  | "accepted_then_timeout"
  | "crash_after_acceptance"
  | "malformed_response"
  | "unknown_status";

type SimulatorFaultOperation = Exclude<Operation, "discover_capabilities">;
type SimulatorGeneralFaultKind = Exclude<SimulatorFaultKind, "unknown_status">;
export type SimulatorFault =
  | { readonly operation: SimulatorFaultOperation; readonly kind: SimulatorGeneralFaultKind }
  | { readonly operation: "status"; readonly kind: "unknown_status" };

export interface SimulatorShipmentRecord {
  readonly providerShipmentId: string;
  readonly trackingNumber: string;
  readonly carrier: string;
  readonly occurredAt: string;
}

export interface SimulatorQuoteRecord {
  readonly providerQuoteId: string;
  readonly productionBundleDigest: string;
  readonly quantity: number;
  readonly totalMinor: number;
  readonly currency: string;
  readonly termsFingerprint: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface SimulatorOrderRecord {
  readonly providerRequestId: string;
  readonly quoteId: string;
  readonly productionBundleDigest: string;
  readonly requestFingerprintDigest: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly acceptedAt: string;
  status: SimulatorOrderStatus;
  statusOccurredAt: string;
  shipments: SimulatorShipmentRecord[];
}

export interface SimulatorIdempotencyRecord {
  readonly keyDigest: string;
  readonly requestDigest: string;
  readonly providerRequestId: string;
  readonly expiresAt: number;
  readonly generation: number;
}

/** Retained accepted-order generation evidence. Unlike the replay index, this is append-only. */
export type SimulatorIdempotencyHistoryRecord = SimulatorIdempotencyRecord;

export interface SimulatorCancelIdempotencyRecord {
  readonly keyDigest: string;
  readonly requestDigest: string;
  readonly result: CancelResult;
  readonly expiresAt: number;
  readonly generation: number;
}

/** Retained cancel result generations used to validate the current cancel replay index. */
export type SimulatorCancelIdempotencyHistoryRecord = SimulatorCancelIdempotencyRecord;

/** Durable fact for a cancellation that changed an accepted order's status. */
export interface SimulatorCancellationEvent {
  readonly eventId: string;
  readonly keyDigest: string;
  readonly requestDigest: string;
  readonly generation: number;
  readonly providerRequestId: string;
  readonly occurredAt: string;
}

export interface SimulatorBillingEvidence {
  readonly billingMode: "simulated";
  readonly event: "order_accepted";
  readonly providerRequestId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly observedAt: string;
  readonly charged: false;
}

interface StatusCallbackRecord {
  readonly kind: "status";
  readonly eventId: string;
  readonly providerRequestId: string;
  readonly status: SimulatorOrderStatus;
  readonly occurredAt: string;
  readonly availableAt: number;
  deliveryAttempts: number;
  applied: boolean;
}

interface ShipmentCallbackRecord {
  readonly kind: "shipment";
  readonly eventId: string;
  readonly providerRequestId: string;
  readonly shipment: SimulatorShipmentRecord;
  readonly occurredAt: string;
  readonly availableAt: number;
  deliveryAttempts: number;
  applied: boolean;
}

export type SimulatorCallbackRecord = StatusCallbackRecord | ShipmentCallbackRecord;

export interface SimulatorCallbackDelivery {
  readonly eventId: string;
  readonly outcome: "delivered" | "delayed" | "duplicate" | "not_found";
}

export interface SimulatorSnapshot {
  readonly format: typeof SIMULATOR_FIXTURE_VERSION;
  readonly billingMode: "simulated";
  readonly seed: string;
  nowMs: number;
  readonly quoteTtlMs: number;
  readonly idempotencyTtlMs: number;
  readonly unsupportedOperations: Operation[];
  faults: SimulatorFault[];
  readonly triggeredFaults: SimulatorFault[];
  quotes: SimulatorQuoteRecord[];
  orders: SimulatorOrderRecord[];
  idempotency: SimulatorIdempotencyRecord[];
  idempotencyHistory: SimulatorIdempotencyHistoryRecord[];
  cancelIdempotency: SimulatorCancelIdempotencyRecord[];
  cancelIdempotencyHistory: SimulatorCancelIdempotencyHistoryRecord[];
  cancellations: SimulatorCancellationEvent[];
  callbacks: SimulatorCallbackRecord[];
  readonly dispatchCounters: Record<Operation, number>;
  duplicateSubmissions: number;
  duplicateCallbacks: number;
  readonly billingEvidence: SimulatorBillingEvidence[];
}

export interface SimulatorOptions {
  /** Synthetic test seed only. Never place production data or credentials here. */
  readonly seed?: string;
  /** Deterministic ISO timestamp or epoch milliseconds; required for a new state. */
  readonly startAt?: string | number;
  /** JSON-compatible state from snapshot(), used to model a restart. */
  readonly snapshot?: SimulatorSnapshot;
  readonly faults?: readonly SimulatorFault[];
  readonly unsupportedOperations?: readonly Operation[];
  readonly quoteTtlMs?: number;
  readonly idempotencyTtlMs?: number;
}

const OPERATIONS: readonly Operation[] = [
  "discover_capabilities", "quote", "preflight", "submit", "status", "shipment", "cancel"
];
const ORDER_STATUS_PRECEDENCE: Readonly<Record<SimulatorOrderStatus, number>> = {
  pending: 0,
  unknown: -1,
  accepted: 1,
  in_production: 2,
  shipped: 3,
  cancelled: 4,
  failed: 5,
  delivered: 6
};
const CURRENCY = "USD";
const UNIT_PRODUCTION_MINOR = 1_200;
const FLAT_SHIPPING_MINOR = 300;
const SIMULATED_TAX_BASIS_POINTS = 1_000;
const MAX_QUANTITY = 10_000;
const MAX_DATE_EPOCH_MS = 8_640_000_000_000_000;

function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function canonicalJson(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite simulator input");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("cyclic simulator input");
    seen.add(value);
    const parts: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor)) throw new TypeError("accessor simulator input");
      parts.push(canonicalJson(descriptor.value, seen));
    }
    seen.delete(value);
    return `[${parts.join(",")}]`;
  }
  if (typeof value !== "object") throw new TypeError("non-JSON simulator input");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError("non-JSON simulator object");
  if (seen.has(value)) throw new TypeError("cyclic simulator input");
  seen.add(value);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) throw new TypeError("symbol simulator input");
  const entries: string[] = [];
  for (const key of (keys as string[]).sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) throw new TypeError("accessor simulator input");
    entries.push(`${JSON.stringify(key)}:${canonicalJson(descriptor.value, seen)}`);
  }
  seen.delete(value);
  return `{${entries.join(",")}}`;
}

/** Exposed for local test fixtures; this is not a shared-contract digest rule. */
export function simulatorFixtureDigest(value: unknown): string {
  return `sha256:${hashText(canonicalJson(value))}`;
}

/** Local deterministic bridge for the private runtime's quote fingerprint field. */
export function simulatorQuoteTermsFingerprint(input: {
  readonly providerQuoteId: string;
  readonly totalMinor: number;
  readonly currency: string;
  readonly expiresAt: string;
  readonly productionBundleDigest: string;
}): string {
  return simulatorFixtureDigest({
    providerQuoteId: input.providerQuoteId,
    totalMinor: input.totalMinor,
    currency: input.currency,
    expiresAt: input.expiresAt,
    productionBundleDigest: input.productionBundleDigest
  });
}

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validStatus(value: unknown): value is SimulatorOrderStatus {
  return value === "pending" || value === "accepted" || value === "in_production" || value === "shipped" ||
    value === "delivered" || value === "cancelled" || value === "failed" || value === "unknown";
}

function validOperation(value: unknown): value is Operation {
  return typeof value === "string" && OPERATIONS.includes(value as Operation);
}

function hasExactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return keys.length === sortedExpected.length && keys.every((key, index) => key === sortedExpected[index]);
}

function validFaultPlan(value: unknown): value is SimulatorFault {
  if (!hasExactKeys(value, ["operation", "kind"]) || !validOperation(value.operation) ||
    value.operation === "discover_capabilities" || typeof value.kind !== "string") return false;
  const kinds: readonly string[] = [
    "refuse_before_dispatch", "unsupported", "rate_limit", "accepted_then_timeout",
    "crash_after_acceptance", "malformed_response", "unknown_status"
  ];
  return kinds.includes(value.kind) && (value.kind !== "unknown_status" || value.operation === "status");
}

function validSafeInteger(value: unknown, minimum = Number.MIN_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && Math.abs(parsed) <= MAX_DATE_EPOCH_MS && new Date(parsed).toISOString() === value;
}

function isHexDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function ownerBundleReferenceDigest(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record).sort().join("|");
  if (keys !== ["content_hash", "contract", "id", "revision", "schema_version"].join("|")) return null;
  if (record["contract"] !== "ProductionBundle" || record["schema_version"] !== "2.0.0") return null;
  return isSha256Digest(record["content_hash"]) ? record["content_hash"] : null;
}

function isSha256Digest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isSyntheticOrderId(value: unknown): value is string {
  return typeof value === "string" && /^sim-order-(?:[0-9a-f]{20}|[a-z0-9]+(?:-[a-z0-9]+)*)$/.test(value);
}

function isSyntheticShipmentId(value: unknown): value is string {
  return typeof value === "string" && /^sim-[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(value);
}

function validShipmentRecord(value: unknown): value is SimulatorShipmentRecord {
  return hasExactKeys(value, ["providerShipmentId", "trackingNumber", "carrier", "occurredAt"]) &&
    isSyntheticShipmentId(value.providerShipmentId) && typeof value.trackingNumber === "string" &&
    /^SIM-[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(value.trackingNumber) &&
    typeof value.carrier === "string" && /^Synthetic(?:[ A-Za-z0-9._-]{0,80})$/.test(value.carrier) &&
    canonicalTimestamp(value.occurredAt);
}

function mergeStatusObservation(order: SimulatorOrderRecord, incoming: SimulatorOrderStatus, occurredAt: string): void {
  if (ORDER_STATUS_PRECEDENCE[incoming] > ORDER_STATUS_PRECEDENCE[order.status]) order.status = incoming;
  if (Date.parse(occurredAt) > Date.parse(order.statusOccurredAt)) order.statusOccurredAt = occurredAt;
}

function descriptorFor(unsupported: readonly Operation[]): ProviderDescriptor {
  const disabled = new Set(unsupported);
  return Object.freeze({
    providerId: SIMULATOR_PROVIDER_ID,
    apiVersion: SIMULATOR_FIXTURE_VERSION,
    productLimits: Object.freeze({ maxQuantity: MAX_QUANTITY, currency: CURRENCY }),
    operations: Object.freeze({
      discover_capabilities: Object.freeze({ supported: !disabled.has("discover_capabilities"), sideEffect: "none", mayCharge: false, idempotency: "not_applicable" }),
      quote: Object.freeze({ supported: !disabled.has("quote"), sideEffect: "none", mayCharge: false, idempotency: "not_applicable" }),
      preflight: Object.freeze({ supported: !disabled.has("preflight"), sideEffect: "none", mayCharge: false, idempotency: "not_applicable" }),
      submit: Object.freeze({ supported: !disabled.has("submit"), sideEffect: "external", mayCharge: true, idempotency: "provider_key" }),
      status: Object.freeze({ supported: !disabled.has("status"), sideEffect: "none", mayCharge: false, idempotency: "not_applicable" }),
      shipment: Object.freeze({ supported: !disabled.has("shipment"), sideEffect: "none", mayCharge: false, idempotency: "not_applicable" }),
      cancel: Object.freeze({ supported: !disabled.has("cancel"), sideEffect: "external", mayCharge: false, idempotency: "provider_key" })
    }),
    supportedModes: Object.freeze(["simulated"] as const)
  });
}

function makeInitialState(options: SimulatorOptions): SimulatorSnapshot {
  if (typeof options.seed !== "string" || options.seed.trim() === "" || options.seed.length > 200) {
    throw new TypeError("a bounded synthetic simulator seed is required");
  }
  const start = typeof options.startAt === "string" ? Date.parse(options.startAt) : options.startAt;
  if (typeof start !== "number" || !Number.isSafeInteger(start) || Math.abs(start) > MAX_DATE_EPOCH_MS) {
    throw new TypeError("a deterministic simulator start time is required");
  }
  const quoteTtlMs = options.quoteTtlMs ?? 60 * 60 * 1_000;
  const idempotencyTtlMs = options.idempotencyTtlMs ?? 30 * 24 * 60 * 60 * 1_000;
  if (!Number.isSafeInteger(quoteTtlMs) || quoteTtlMs < 1 || !Number.isSafeInteger(idempotencyTtlMs) || idempotencyTtlMs < 1 ||
    start + quoteTtlMs > MAX_DATE_EPOCH_MS || start + idempotencyTtlMs > Number.MAX_SAFE_INTEGER) {
    throw new TypeError("simulator retention intervals must be positive safe integers");
  }
  const unsupportedOperations = [...new Set(options.unsupportedOperations ?? [])];
  if (unsupportedOperations.some((operation) => !validOperation(operation))) throw new TypeError("unknown unsupported simulator operation");
  const faults = (options.faults ?? []).map((fault) => {
    if (!validFaultPlan(fault)) {
      throw new TypeError("invalid simulator fault plan");
    }
    return fault.kind === "unknown_status"
      ? { operation: "status" as const, kind: "unknown_status" as const }
      : { operation: fault.operation, kind: fault.kind };
  });
  return {
    format: SIMULATOR_FIXTURE_VERSION,
    billingMode: "simulated",
    seed: options.seed,
    nowMs: start,
    quoteTtlMs,
    idempotencyTtlMs,
    unsupportedOperations,
    faults,
    triggeredFaults: [],
    quotes: [],
    orders: [],
    idempotency: [],
    idempotencyHistory: [],
    cancelIdempotency: [],
    cancelIdempotencyHistory: [],
    cancellations: [],
    callbacks: [],
    dispatchCounters: {
      discover_capabilities: 0, quote: 0, preflight: 0, submit: 0, status: 0, shipment: 0, cancel: 0
    },
    duplicateSubmissions: 0,
    duplicateCallbacks: 0,
    billingEvidence: []
  };
}

function parseSnapshot(snapshot: SimulatorSnapshot): SimulatorSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(JSON.stringify(snapshot)) as unknown;
  } catch {
    throw new TypeError("simulator snapshot must be JSON serializable");
  }
  const invalid = (): never => { throw new TypeError("simulator snapshot is invalid or has an unsupported version"); };
  if (isPlainRecord(parsed) && parsed.format === "fc-mock-development/1") {
    throw new TypeError("simulator snapshot fc-mock-development/1 cannot be migrated because it lacks retained generation and cancellation history; recreate this development-only fixture");
  }
  const snapshotKeys = [
    "format", "billingMode", "seed", "nowMs", "quoteTtlMs", "idempotencyTtlMs", "unsupportedOperations", "faults",
    "triggeredFaults", "quotes", "orders", "idempotency", "idempotencyHistory", "cancelIdempotency",
    "cancelIdempotencyHistory", "cancellations", "callbacks", "dispatchCounters", "duplicateSubmissions",
    "duplicateCallbacks", "billingEvidence"
  ];
  if (!hasExactKeys(parsed, snapshotKeys)) return invalid();
  const copy = parsed as unknown as SimulatorSnapshot;
  if (copy.format !== SIMULATOR_FIXTURE_VERSION || copy.billingMode !== "simulated" ||
    typeof copy.seed !== "string" || copy.seed.trim() === "" || copy.seed.length > 200 ||
    !validSafeInteger(copy.nowMs) || Math.abs(copy.nowMs) > MAX_DATE_EPOCH_MS ||
    !validSafeInteger(copy.quoteTtlMs, 1) || !validSafeInteger(copy.idempotencyTtlMs, 1) ||
    !Array.isArray(copy.unsupportedOperations) || copy.unsupportedOperations.some((op) => !validOperation(op)) ||
    new Set(copy.unsupportedOperations).size !== copy.unsupportedOperations.length ||
    !Array.isArray(copy.faults) || !copy.faults.every(validFaultPlan) ||
    !Array.isArray(copy.triggeredFaults) || !copy.triggeredFaults.every(validFaultPlan) ||
    !Array.isArray(copy.quotes) || !Array.isArray(copy.orders) || !Array.isArray(copy.idempotency) ||
    !Array.isArray(copy.idempotencyHistory) || !Array.isArray(copy.cancelIdempotency) ||
    !Array.isArray(copy.cancelIdempotencyHistory) || !Array.isArray(copy.cancellations) ||
    !Array.isArray(copy.callbacks) || !Array.isArray(copy.billingEvidence) ||
    !hasExactKeys(copy.dispatchCounters, OPERATIONS) ||
    OPERATIONS.some((operation) => !validSafeInteger(copy.dispatchCounters[operation], 0)) ||
    !validSafeInteger(copy.duplicateSubmissions, 0) || !validSafeInteger(copy.duplicateCallbacks, 0)) {
    return invalid();
  }

  const quoteKeys = ["providerQuoteId", "productionBundleDigest", "quantity", "totalMinor", "currency", "termsFingerprint", "createdAt", "expiresAt"];
  const quotesById = new Map<string, SimulatorQuoteRecord>();
  for (const value of copy.quotes as unknown[]) {
    if (!hasExactKeys(value, quoteKeys)) return invalid();
    const quote = value as unknown as SimulatorQuoteRecord;
    const createdAtMs = canonicalTimestamp(quote.createdAt) ? Date.parse(quote.createdAt) : Number.NaN;
    const expiresAtMs = canonicalTimestamp(quote.expiresAt) ? Date.parse(quote.expiresAt) : Number.NaN;
    if (typeof quote.providerQuoteId !== "string" || !/^sim-quote-[0-9a-f]{20}$/.test(quote.providerQuoteId) ||
      !isSha256Digest(quote.productionBundleDigest) || !validSafeInteger(quote.quantity, 1) || quote.quantity > MAX_QUANTITY ||
      !validSafeInteger(quote.totalMinor, 1) || quote.currency !== CURRENCY || !isSha256Digest(quote.termsFingerprint) ||
      !Number.isFinite(createdAtMs) || createdAtMs > copy.nowMs || !Number.isFinite(expiresAtMs) ||
      expiresAtMs !== createdAtMs + copy.quoteTtlMs || expiresAtMs > MAX_DATE_EPOCH_MS) return invalid();
    const production = UNIT_PRODUCTION_MINOR * quote.quantity;
    const tax = Math.floor((production * SIMULATED_TAX_BASIS_POINTS + 5_000) / 10_000);
    const expectedTotal = production + FLAT_SHIPPING_MINOR + tax;
    const expectedId = `sim-quote-${hashText(`${copy.seed}|${quote.productionBundleDigest}|${quote.quantity}|${expectedTotal}|${CURRENCY}|${createdAtMs}|${copy.quoteTtlMs}`).slice(0, 20)}`;
    const expectedTerms = simulatorQuoteTermsFingerprint({
      providerQuoteId: expectedId,
      totalMinor: expectedTotal,
      currency: CURRENCY,
      expiresAt: quote.expiresAt,
      productionBundleDigest: quote.productionBundleDigest
    });
    if (!Number.isSafeInteger(expectedTotal) || quote.totalMinor !== expectedTotal || quote.providerQuoteId !== expectedId ||
      quote.termsFingerprint !== expectedTerms || quotesById.has(quote.providerQuoteId)) return invalid();
    quotesById.set(quote.providerQuoteId, quote);
  }

  const orderKeys = ["providerRequestId", "quoteId", "productionBundleDigest", "requestFingerprintDigest", "amountMinor", "currency", "acceptedAt", "status", "statusOccurredAt", "shipments"];
  const ordersById = new Map<string, SimulatorOrderRecord>();
  for (const value of copy.orders as unknown[]) {
    if (!hasExactKeys(value, orderKeys)) return invalid();
    const order = value as unknown as SimulatorOrderRecord;
    const acceptedAtMs = canonicalTimestamp(order.acceptedAt) ? Date.parse(order.acceptedAt) : Number.NaN;
    const statusAtMs = canonicalTimestamp(order.statusOccurredAt) ? Date.parse(order.statusOccurredAt) : Number.NaN;
    const quote = typeof order.quoteId === "string" ? quotesById.get(order.quoteId) : undefined;
    if (!isSyntheticOrderId(order.providerRequestId) || !/^sim-order-[0-9a-f]{20}$/.test(order.providerRequestId) ||
      quote === undefined || !isSha256Digest(order.productionBundleDigest) || !isSha256Digest(order.requestFingerprintDigest) ||
      !validSafeInteger(order.amountMinor, 1) || order.currency !== CURRENCY || !Number.isFinite(acceptedAtMs) ||
      acceptedAtMs > copy.nowMs || !Number.isFinite(statusAtMs) || statusAtMs < acceptedAtMs ||
      !validStatus(order.status) || order.status === "unknown" || order.status === "pending" ||
      !Array.isArray(order.shipments) || ordersById.has(order.providerRequestId) ||
      order.productionBundleDigest !== quote.productionBundleDigest || order.amountMinor !== quote.totalMinor || order.currency !== quote.currency) {
      return invalid();
    }
    const shipmentIds = new Set<string>();
    for (const shipment of order.shipments as unknown[]) {
      if (!validShipmentRecord(shipment) || shipmentIds.has(shipment.providerShipmentId)) return invalid();
      shipmentIds.add(shipment.providerShipmentId);
    }
    ordersById.set(order.providerRequestId, order);
  }

  const acceptedHistoryByKey = new Map<string, SimulatorIdempotencyHistoryRecord[]>();
  const acceptedHistoryByOrder = new Map<string, SimulatorIdempotencyHistoryRecord>();
  const idempotencyRecordKeys = ["keyDigest", "requestDigest", "providerRequestId", "expiresAt", "generation"];
  for (const value of copy.idempotencyHistory as unknown[]) {
    if (!hasExactKeys(value, idempotencyRecordKeys)) return invalid();
    const record = value as unknown as SimulatorIdempotencyHistoryRecord;
    const order = typeof record.providerRequestId === "string" ? ordersById.get(record.providerRequestId) : undefined;
    const acceptedAtMs = order === undefined ? Number.NaN : Date.parse(order.acceptedAt);
    const expectedId = isHexDigest(record.keyDigest) && isHexDigest(record.requestDigest) && validSafeInteger(record.generation, 1)
      ? `sim-order-${hashText(`${copy.seed}|${record.keyDigest}|${record.requestDigest}|${record.generation}`).slice(0, 20)}`
      : "";
    if (!isHexDigest(record.keyDigest) || !isHexDigest(record.requestDigest) ||
      !isSyntheticOrderId(record.providerRequestId) || order === undefined ||
      acceptedHistoryByOrder.has(record.providerRequestId) || !validSafeInteger(record.expiresAt) ||
      !validSafeInteger(record.generation, 1) || record.providerRequestId !== expectedId ||
      order.requestFingerprintDigest !== `sha256:${record.requestDigest}` ||
      record.expiresAt !== acceptedAtMs + copy.idempotencyTtlMs) return invalid();
    acceptedHistoryByOrder.set(record.providerRequestId, record);
    const generations = acceptedHistoryByKey.get(record.keyDigest) ?? [];
    generations.push(record);
    acceptedHistoryByKey.set(record.keyDigest, generations);
  }
  if (acceptedHistoryByOrder.size !== ordersById.size) return invalid();
  for (const generations of acceptedHistoryByKey.values()) {
    generations.sort((left, right) => left.generation - right.generation);
    for (let index = 0; index < generations.length; index += 1) {
      const record = generations[index];
      if (record === undefined) return invalid();
      const order = ordersById.get(record.providerRequestId);
      if (record.generation !== index + 1 || order === undefined) return invalid();
      if (index > 0) {
        const previous = generations[index - 1];
        if (previous === undefined) return invalid();
        if (previous.expiresAt > Date.parse(order.acceptedAt)) return invalid();
      }
    }
  }

  const idempotencyKeys = new Set<string>();
  for (const value of copy.idempotency as unknown[]) {
    if (!hasExactKeys(value, idempotencyRecordKeys)) return invalid();
    const record = value as unknown as SimulatorIdempotencyRecord;
    const history = acceptedHistoryByKey.get(record.keyDigest);
    const latest = history?.[history.length - 1];
    if (!isHexDigest(record.keyDigest) || idempotencyKeys.has(record.keyDigest) || latest === undefined ||
      canonicalJson(record) !== canonicalJson(latest)) return invalid();
    idempotencyKeys.add(record.keyDigest);
  }
  if (idempotencyKeys.size !== acceptedHistoryByKey.size) return invalid();

  const cancelHistoryByKey = new Map<string, SimulatorCancelIdempotencyHistoryRecord[]>();
  const cancelHistoryByGeneration = new Map<string, SimulatorCancelIdempotencyHistoryRecord>();
  const cancelRecordKeys = ["keyDigest", "requestDigest", "result", "expiresAt", "generation"];
  for (const value of copy.cancelIdempotencyHistory as unknown[]) {
    if (!hasExactKeys(value, cancelRecordKeys)) return invalid();
    const record = value as unknown as SimulatorCancelIdempotencyHistoryRecord;
    if (!isHexDigest(record.keyDigest) || !isHexDigest(record.requestDigest) ||
      !validSafeInteger(record.expiresAt) || !validSafeInteger(record.generation, 1) ||
      !hasExactKeys(record.result, ["providerRequestId", "outcome", "observedAt"]) ||
      !isSyntheticOrderId(record.result.providerRequestId) ||
      (record.result.outcome !== "cancelled" && record.result.outcome !== "already_terminal" && record.result.outcome !== "not_found") ||
      !canonicalTimestamp(record.result.observedAt) || Date.parse(record.result.observedAt) > copy.nowMs ||
      record.expiresAt !== Date.parse(record.result.observedAt) + copy.idempotencyTtlMs) return invalid();
    const order = ordersById.get(record.result.providerRequestId);
    const acceptedAtMs = order === undefined ? undefined : Date.parse(order.acceptedAt);
    const observedAtMs = Date.parse(record.result.observedAt);
    if (record.result.outcome === "not_found") {
      // A retained result describes what was observed then, not what exists now.
      // Millisecond timestamps have no within-tick sequence, so equality remains possible.
      if (acceptedAtMs !== undefined && acceptedAtMs < observedAtMs) return invalid();
    } else if (acceptedAtMs === undefined || acceptedAtMs > observedAtMs) {
      return invalid();
    }
    const generationKey = `${record.keyDigest}:${record.generation}`;
    if (cancelHistoryByGeneration.has(generationKey)) return invalid();
    cancelHistoryByGeneration.set(generationKey, record);
    const generations = cancelHistoryByKey.get(record.keyDigest) ?? [];
    generations.push(record);
    cancelHistoryByKey.set(record.keyDigest, generations);
  }
  for (const generations of cancelHistoryByKey.values()) {
    generations.sort((left, right) => left.generation - right.generation);
    for (let index = 0; index < generations.length; index += 1) {
      const record = generations[index];
      if (record === undefined) return invalid();
      if (record.generation !== index + 1) return invalid();
      if (index > 0) {
        const previous = generations[index - 1];
        if (previous === undefined || previous.expiresAt > Date.parse(record.result.observedAt)) return invalid();
      }
    }
  }

  const cancelKeys = new Set<string>();
  for (const value of copy.cancelIdempotency as unknown[]) {
    if (!hasExactKeys(value, cancelRecordKeys)) return invalid();
    const record = value as unknown as SimulatorCancelIdempotencyRecord;
    const history = cancelHistoryByKey.get(record.keyDigest);
    const latest = history?.[history.length - 1];
    if (!isHexDigest(record.keyDigest) || cancelKeys.has(record.keyDigest) || latest === undefined ||
      canonicalJson(record) !== canonicalJson(latest)) return invalid();
    cancelKeys.add(record.keyDigest);
  }
  if (cancelKeys.size !== cancelHistoryByKey.size) return invalid();

  const cancellationEventsByOrder = new Map<string, SimulatorCancellationEvent>();
  const cancellationEventsByGeneration = new Map<string, SimulatorCancellationEvent>();
  const cancellationEventIds = new Set<string>();
  for (const value of copy.cancellations as unknown[]) {
    if (!hasExactKeys(value, ["eventId", "keyDigest", "requestDigest", "generation", "providerRequestId", "occurredAt"])) return invalid();
    const event = value as unknown as SimulatorCancellationEvent;
    const order = typeof event.providerRequestId === "string" ? ordersById.get(event.providerRequestId) : undefined;
    const eventGenerationKey = `${event.keyDigest}:${event.generation}`;
    const historyRecord = cancelHistoryByGeneration.get(eventGenerationKey);
    const expectedId = isHexDigest(event.keyDigest) && isHexDigest(event.requestDigest) && validSafeInteger(event.generation, 1)
      ? `sim-cancel-event-${hashText(`${copy.seed}|${event.keyDigest}|${event.requestDigest}|${event.generation}|${event.providerRequestId}|${event.occurredAt}`).slice(0, 16)}`
      : "";
    if (!isHexDigest(event.keyDigest) || !isHexDigest(event.requestDigest) || !validSafeInteger(event.generation, 1) ||
      !isSyntheticOrderId(event.providerRequestId) || order === undefined || !canonicalTimestamp(event.occurredAt) ||
      Date.parse(event.occurredAt) < Date.parse(order.acceptedAt) || Date.parse(event.occurredAt) > copy.nowMs ||
      event.eventId !== expectedId || cancellationEventIds.has(event.eventId) ||
      cancellationEventsByOrder.has(event.providerRequestId) || cancellationEventsByGeneration.has(eventGenerationKey) ||
      historyRecord === undefined || historyRecord.result.outcome !== "cancelled" ||
      historyRecord.requestDigest !== event.requestDigest || historyRecord.result.providerRequestId !== event.providerRequestId ||
      historyRecord.result.observedAt !== event.occurredAt) return invalid();
    cancellationEventIds.add(event.eventId);
    cancellationEventsByOrder.set(event.providerRequestId, event);
    cancellationEventsByGeneration.set(eventGenerationKey, event);
  }
  const effectiveCancellations = [...cancelHistoryByGeneration.entries()].filter(([, record]) => record.result.outcome === "cancelled");
  if (cancellationEventsByGeneration.size !== effectiveCancellations.length) return invalid();

  const callbackKeys = new Set<string>();
  const appliedShipments = new Map<string, Map<string, SimulatorShipmentRecord>>();
  const callbackBaseKeys = ["eventId", "providerRequestId", "occurredAt", "availableAt", "deliveryAttempts", "applied"];
  for (let index = 0; index < copy.callbacks.length; index += 1) {
    const value = copy.callbacks[index] as unknown;
    if (!isPlainRecord(value) || typeof value.kind !== "string") return invalid();
    const callback = value as unknown as SimulatorCallbackRecord;
    const expectedKeys = callback.kind === "status"
      ? [...callbackBaseKeys, "kind", "status"]
      : callback.kind === "shipment" ? [...callbackBaseKeys, "kind", "shipment"] : [];
    if (expectedKeys.length === 0 || !hasExactKeys(value, expectedKeys) ||
      !isSyntheticOrderId(callback.providerRequestId) || !ordersById.has(callback.providerRequestId) ||
      !canonicalTimestamp(callback.occurredAt) || !validSafeInteger(callback.availableAt) ||
      Math.abs(callback.availableAt) > MAX_DATE_EPOCH_MS || !validSafeInteger(callback.deliveryAttempts, 0) ||
      typeof callback.applied !== "boolean" || (callback.applied && callback.deliveryAttempts === 0)) return invalid();
    const content = callback.kind === "status"
      ? { status: callback.status, occurredAt: callback.occurredAt }
      : callback.shipment;
    if (callback.kind === "status") {
      if (!validStatus(callback.status) || callback.status === "unknown") return invalid();
    } else {
      if (!validShipmentRecord(callback.shipment) || callback.shipment.occurredAt !== callback.occurredAt) return invalid();
      if (callback.applied) {
        let shipments = appliedShipments.get(callback.providerRequestId);
        if (shipments === undefined) {
          shipments = new Map<string, SimulatorShipmentRecord>();
          appliedShipments.set(callback.providerRequestId, shipments);
        }
        const previous = shipments.get(callback.shipment.providerShipmentId);
        if (previous !== undefined && canonicalJson(previous) !== canonicalJson(callback.shipment)) return invalid();
        shipments.set(callback.shipment.providerShipmentId, callback.shipment);
      }
    }
    const expectedEventId = `sim-event-${hashText(`${copy.seed}|${index + 1}|${callback.providerRequestId}|${callback.kind}|${canonicalJson(content)}`).slice(0, 16)}`;
    if (callback.eventId !== expectedEventId || callbackKeys.has(callback.eventId)) return invalid();
    callbackKeys.add(callback.eventId);
  }

  for (const order of ordersById.values()) {
    const expectedShipments = [...(appliedShipments.get(order.providerRequestId)?.values() ?? [])]
      .sort((left, right) => left.providerShipmentId < right.providerShipmentId ? -1 : left.providerShipmentId > right.providerShipmentId ? 1 : 0);
    if (order.shipments.length !== expectedShipments.length || order.shipments.some((shipment, index) =>
      canonicalJson(shipment) !== canonicalJson(expectedShipments[index]))) return invalid();

    const derived = { ...order, status: "accepted" as const, statusOccurredAt: order.acceptedAt, shipments: [] };
    for (const callbackValue of copy.callbacks as SimulatorCallbackRecord[]) {
      if (!callbackValue.applied || callbackValue.providerRequestId !== order.providerRequestId) continue;
      if (callbackValue.kind === "status") mergeStatusObservation(derived, callbackValue.status, callbackValue.occurredAt);
      else mergeStatusObservation(derived, "shipped", callbackValue.occurredAt);
    }
    const cancellation = cancellationEventsByOrder.get(order.providerRequestId);
    if (cancellation !== undefined) mergeStatusObservation(derived, "cancelled", cancellation.occurredAt);
    if (order.status !== derived.status || order.statusOccurredAt !== derived.statusOccurredAt) return invalid();
  }

  for (const [, record] of cancelHistoryByGeneration) {
    if (record.result.outcome !== "already_terminal") continue;
    const order = ordersById.get(record.result.providerRequestId);
    if (order === undefined || !["delivered", "cancelled", "failed", "shipped"].includes(order.status)) return invalid();
  }

  const minimumSubmitDispatches = copy.orders.length + copy.duplicateSubmissions;
  const minimumCancelDispatches = Math.max(copy.cancelIdempotencyHistory.length, copy.cancellations.length);
  if (!Number.isSafeInteger(minimumSubmitDispatches) || copy.dispatchCounters.submit < minimumSubmitDispatches ||
    copy.dispatchCounters.quote < copy.quotes.length || copy.dispatchCounters.cancel < minimumCancelDispatches) return invalid();

  const evidenceByOrder = new Set<string>();
  if (copy.billingEvidence.length !== copy.orders.length) return invalid();
  for (const value of copy.billingEvidence as unknown[]) {
    if (!hasExactKeys(value, ["billingMode", "event", "providerRequestId", "amountMinor", "currency", "observedAt", "charged"])) return invalid();
    const evidence = value as unknown as SimulatorBillingEvidence;
    const order = isSyntheticOrderId(evidence.providerRequestId) ? ordersById.get(evidence.providerRequestId) : undefined;
    if (evidence.billingMode !== "simulated" || evidence.event !== "order_accepted" || evidence.charged !== false ||
      order === undefined || evidenceByOrder.has(evidence.providerRequestId) || !validSafeInteger(evidence.amountMinor, 1) ||
      evidence.amountMinor !== order.amountMinor || evidence.currency !== order.currency ||
      !canonicalTimestamp(evidence.observedAt) || evidence.observedAt !== order.acceptedAt) return invalid();
    evidenceByOrder.add(evidence.providerRequestId);
  }
  if (evidenceByOrder.size !== ordersById.size) return invalid();

  return copy;
}

class SimulatedProviderError extends Error {
  constructor(message = "Simulated provider operation failed.", readonly code?: string, readonly status?: number) {
    super(message);
    this.name = "SimulatedProviderError";
  }
}

function stableQuote(record: SimulatorQuoteRecord): QuoteResult {
  const production = UNIT_PRODUCTION_MINOR * record.quantity;
  const tax = Math.floor((production * SIMULATED_TAX_BASIS_POINTS + 5_000) / 10_000);
  return {
    providerQuoteId: record.providerQuoteId,
    currency: record.currency,
    totalMinor: record.totalMinor,
    expiresAt: record.expiresAt,
    breakdown: [
      { label: "simulated production", amountMinor: production },
      { label: "simulated shipping", amountMinor: FLAT_SHIPPING_MINOR },
      { label: "simulated tax", amountMinor: tax }
    ]
  };
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new SimulatedProviderError();
  return value;
}

function requireSafeInteger(value: unknown, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new SimulatedProviderError();
  return value as number;
}

export class DeterministicSimulator implements Clock {
  readonly mode = "simulated" as const;
  readonly adapter: ProviderAdapter;
  readonly transport: { readonly mode: "simulated"; request<T>(request: import("./types.js").ProviderTransportRequest): Promise<T> };
  readonly clock: Clock = this;
  readonly descriptor: ProviderDescriptor;
  private readonly state: SimulatorSnapshot;
  private crashBarrierHandler: (() => void) | undefined = undefined;

  constructor(options: SimulatorOptions) {
    if (options.snapshot !== undefined) {
      if (options.seed !== undefined || options.startAt !== undefined || options.faults !== undefined ||
        options.unsupportedOperations !== undefined || options.quoteTtlMs !== undefined || options.idempotencyTtlMs !== undefined) {
        throw new TypeError("restore from one snapshot without overriding its deterministic settings");
      }
      this.state = parseSnapshot(options.snapshot);
    } else {
      this.state = makeInitialState(options);
    }
    this.descriptor = descriptorFor(this.state.unsupportedOperations);
    this.transport = Object.freeze({
      mode: "simulated" as const,
      request: <T>(request: import("./types.js").ProviderTransportRequest): Promise<T> => this.request<T>(request)
    });
    this.adapter = this.createAdapter();
  }

  now(): number {
    return this.state.nowMs;
  }

  /** Advances only the synthetic clock stored in this isolated fixture. */
  advanceTime(milliseconds: number): void {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || !Number.isSafeInteger(this.state.nowMs + milliseconds) ||
      Math.abs(this.state.nowMs + milliseconds) > MAX_DATE_EPOCH_MS) {
      throw new TypeError("simulator time advance must be a non-negative safe integer");
    }
    this.state.nowMs += milliseconds;
  }

  snapshot(): SimulatorSnapshot {
    return JSON.parse(JSON.stringify(this.state)) as SimulatorSnapshot;
  }

  /** Test seam invoked at the persisted accepted-order / not-yet-returned-response crash boundary. */
  setCrashBarrierHandler(handler: (() => void) | undefined): void {
    this.crashBarrierHandler = handler;
  }

  dispatchCounters(): Readonly<Record<Operation, number>> {
    return Object.freeze({ ...this.state.dispatchCounters });
  }

  orders(): readonly SimulatorOrderRecord[] {
    return JSON.parse(JSON.stringify(this.state.orders)) as SimulatorOrderRecord[];
  }

  shipments(providerRequestId: string): readonly SimulatorShipmentRecord[] {
    const order = this.findOrder(providerRequestId);
    return order === undefined ? [] : JSON.parse(JSON.stringify(order.shipments)) as SimulatorShipmentRecord[];
  }

  queueStatusCallback(input: {
    readonly providerRequestId: string;
    readonly status: SimulatorOrderStatus;
    readonly occurredAt?: string;
    readonly delayMs?: number;
  }): string {
    if (!validStatus(input.status) || input.status === "unknown") throw new TypeError("callback status must be authoritative and recognized");
    return this.addCallback({
      kind: "status",
      providerRequestId: requireString(input.providerRequestId, "providerRequestId"),
      status: input.status,
      occurredAt: this.callbackTime(input.occurredAt),
      delayMs: input.delayMs ?? 0
    });
  }

  queueShipmentCallback(input: {
    readonly providerRequestId: string;
    readonly shipment: Omit<SimulatorShipmentRecord, "providerShipmentId"> & { readonly providerShipmentId?: string };
    readonly delayMs?: number;
  }): string {
    const providerRequestId = requireString(input.providerRequestId, "providerRequestId");
    const occurredAt = this.callbackTime(input.shipment.occurredAt);
    const shipmentId = input.shipment.providerShipmentId ?? `sim-shipment-${hashText(`${this.state.seed}|${providerRequestId}|${input.shipment.trackingNumber}|${occurredAt}`).slice(0, 16)}`;
    const shipment: SimulatorShipmentRecord = {
      providerShipmentId: requireString(shipmentId, "providerShipmentId"),
      trackingNumber: requireString(input.shipment.trackingNumber, "trackingNumber"),
      carrier: requireString(input.shipment.carrier, "carrier"),
      occurredAt
    };
    if (!validShipmentRecord(shipment)) throw new TypeError("shipment callbacks require synthetic shipment details");
    const order = this.findOrder(providerRequestId);
    if (order === undefined) throw new TypeError("callbacks require a known synthetic order");
    const priorShipments = [
      ...order.shipments,
      ...this.state.callbacks.flatMap((entry) => entry.kind === "shipment" && entry.providerRequestId === providerRequestId ? [entry.shipment] : [])
    ];
    if (priorShipments.some((prior) => prior.providerShipmentId === shipment.providerShipmentId && canonicalJson(prior) !== canonicalJson(shipment))) {
      throw new TypeError("a synthetic shipment identity cannot be reused with different details");
    }
    return this.addCallback({
      kind: "shipment",
      providerRequestId,
      shipment,
      occurredAt,
      delayMs: input.delayMs ?? 0
    });
  }

  deliverCallback(eventId: string): SimulatorCallbackDelivery {
    const callback = this.state.callbacks.find((entry) => entry.eventId === eventId);
    if (callback === undefined) return { eventId, outcome: "not_found" };
    callback.deliveryAttempts += 1;
    if (this.state.nowMs < callback.availableAt) return { eventId, outcome: "delayed" };
    if (callback.applied) {
      this.state.duplicateCallbacks += 1;
      return { eventId, outcome: "duplicate" };
    }
    const order = this.findOrder(callback.providerRequestId);
    if (order === undefined) return { eventId, outcome: "not_found" };
    if (callback.kind === "status") {
      mergeStatusObservation(order, callback.status, callback.occurredAt);
    } else {
      if (!order.shipments.some((entry) => entry.providerShipmentId === callback.shipment.providerShipmentId)) {
        order.shipments.push({ ...callback.shipment });
        order.shipments.sort((left, right) => left.providerShipmentId < right.providerShipmentId ? -1 : left.providerShipmentId > right.providerShipmentId ? 1 : 0);
      } else {
        this.state.duplicateCallbacks += 1;
      }
      mergeStatusObservation(order, "shipped", callback.occurredAt);
    }
    callback.applied = true;
    return { eventId, outcome: "delivered" };
  }

  private callbackTime(candidate?: string): string {
    if (candidate === undefined) return iso(this.state.nowMs);
    if (typeof candidate !== "string") throw new TypeError("callback time must be an ISO-compatible timestamp");
    const parsed = Date.parse(candidate);
    if (!Number.isFinite(parsed) || Math.abs(parsed) > MAX_DATE_EPOCH_MS) throw new TypeError("callback time must be an ISO-compatible timestamp");
    return iso(parsed);
  }

  private addCallback(input: {
    readonly kind: "status";
    readonly providerRequestId: string;
    readonly status: SimulatorOrderStatus;
    readonly occurredAt: string;
    readonly delayMs: number;
  } | {
    readonly kind: "shipment";
    readonly providerRequestId: string;
    readonly shipment: SimulatorShipmentRecord;
    readonly occurredAt: string;
    readonly delayMs: number;
  }): string {
    if (!Number.isSafeInteger(input.delayMs) || input.delayMs < 0) throw new TypeError("callback delay must be a non-negative safe integer");
    if (this.findOrder(input.providerRequestId) === undefined) throw new TypeError("callbacks require a known synthetic order");
    const availableAt = this.state.nowMs + input.delayMs;
    if (!Number.isSafeInteger(availableAt) || Math.abs(availableAt) > MAX_DATE_EPOCH_MS) {
      throw new TypeError("callback availability must be a finite simulator date");
    }
    const sequence = this.state.callbacks.length + 1;
    const content = input.kind === "status"
      ? { status: input.status, occurredAt: input.occurredAt }
      : input.shipment;
    const eventId = `sim-event-${hashText(`${this.state.seed}|${sequence}|${input.providerRequestId}|${input.kind}|${canonicalJson(content)}`).slice(0, 16)}`;
    const base = {
      eventId,
      providerRequestId: input.providerRequestId,
      occurredAt: input.occurredAt,
      availableAt,
      deliveryAttempts: 0,
      applied: false
    };
    if (input.kind === "status") {
      this.state.callbacks.push({ ...base, kind: "status", status: input.status });
    } else {
      this.state.callbacks.push({ ...base, kind: "shipment", shipment: { ...input.shipment } });
    }
    return eventId;
  }

  private createAdapter(): ProviderAdapter {
    const simulator = this;
    return Object.freeze({
      descriptor: this.descriptor,
      async quote(command: QuoteCommand, context: AdapterCallContext): Promise<ProviderResult<QuoteResult>> {
        if (!simulator.contextIsSimulated(context)) return { status: "unsupported" };
        const fault = simulator.takeAdapterFault("quote");
        if (fault === "unsupported") return { status: "unsupported" };
        if (fault === "refuse_before_dispatch") throw new SimulatedProviderError();
        const quantity = requireSafeInteger(command.quantity, 1);
        if (quantity > MAX_QUANTITY) throw new SimulatedProviderError();
        const bundleDigest = simulator.bundleDigestOrFail(command.productionBundle);
        const raw = await context.transport.request<unknown>({
          operation: "quote", method: "POST", path: "/simulator/quotes", body: { bundleDigest, quantity }
        });
        return { status: "supported", value: simulator.parseQuote(raw) };
      },
      async preflight(command: PreflightCommand, context: AdapterCallContext): Promise<ProviderResult<PreflightReport>> {
        if (!simulator.contextIsSimulated(context)) return { status: "unsupported" };
        const fault = simulator.takeAdapterFault("preflight");
        if (fault === "unsupported") return { status: "unsupported" };
        if (fault === "refuse_before_dispatch") throw new SimulatedProviderError();
        const bundleDigest = simulator.bundleDigestOrFail(command.productionBundle);
        const specificationDigest = simulator.digestOrFail(command.printSpecification);
        const raw = await context.transport.request<unknown>({
          operation: "preflight", method: "POST", path: "/simulator/preflight", body: { bundleDigest, specificationDigest }
        });
        return { status: "supported", value: simulator.parsePreflight(raw) };
      },
      async validateBeforeSubmit(command: SubmitCommand, context: PreSubmitContext): Promise<ProviderResult<PreflightReport>> {
        if (context.mode !== "simulated") return { status: "unsupported" };
        const report = simulator.validateSubmitQuote(command);
        return { status: "supported", value: report };
      },
      async submit(command: SubmitCommand, context: AdapterCallContext): Promise<ProviderResult<SubmitResult>> {
        if (!simulator.contextIsSimulated(context)) return { status: "unsupported" };
        const fault = simulator.takeAdapterFault("submit");
        if (fault === "unsupported") return { status: "unsupported" };
        if (fault === "refuse_before_dispatch") throw new SimulatedProviderError();
        const body = {
          quoteId: requireString(command.quote.quoteId, "quoteId"),
          quoteExpiresAt: requireString(command.quote.expiresAt, "quoteExpiresAt"),
          termsFingerprint: requireString(command.quote.termsFingerprint, "termsFingerprint"),
          productionBundleDigest: requireString(command.productionBundleDigest, "productionBundleDigest"),
          amountMinor: requireSafeInteger(command.amountMinor, 1),
          currency: requireString(command.currency, "currency"),
          requestFingerprint: requireString(command.requestFingerprint, "requestFingerprint")
        };
        const raw = await context.transport.request<unknown>({
          operation: "submit", method: "POST", path: "/simulator/orders", body, idempotencyKey: command.idempotencyKey
        });
        return { status: "supported", value: simulator.parseSubmit(raw) };
      },
      async getStatus(command: StatusCommand, context: AdapterCallContext): Promise<ProviderResult<StatusResult>> {
        if (!simulator.contextIsSimulated(context)) return { status: "unsupported" };
        const fault = simulator.takeAdapterFault("status");
        if (fault === "unsupported") return { status: "unsupported" };
        if (fault === "refuse_before_dispatch") throw new SimulatedProviderError();
        const raw = await context.transport.request<unknown>({
          operation: "status", method: "GET", path: "/simulator/orders/status", body: { providerRequestId: requireString(command.providerRequestId, "providerRequestId") }
        });
        return { status: "supported", value: simulator.parseStatus(raw) };
      },
      async observeShipment(command: ShipmentCommand, context: AdapterCallContext): Promise<ProviderResult<ShipmentResult>> {
        if (!simulator.contextIsSimulated(context)) return { status: "unsupported" };
        const fault = simulator.takeAdapterFault("shipment");
        if (fault === "unsupported") return { status: "unsupported" };
        if (fault === "refuse_before_dispatch") throw new SimulatedProviderError();
        const raw = await context.transport.request<unknown>({
          operation: "shipment", method: "GET", path: "/simulator/orders/shipments", body: { providerRequestId: requireString(command.providerRequestId, "providerRequestId") }
        });
        return { status: "supported", value: simulator.parseShipment(raw) };
      },
      async cancel(command: CancelCommand, context: AdapterCallContext): Promise<ProviderResult<CancelResult>> {
        if (!simulator.contextIsSimulated(context)) return { status: "unsupported" };
        const fault = simulator.takeAdapterFault("cancel");
        if (fault === "unsupported") return { status: "unsupported" };
        if (fault === "refuse_before_dispatch") throw new SimulatedProviderError();
        const raw = await context.transport.request<unknown>({
          operation: "cancel",
          method: "POST",
          path: "/simulator/orders/cancel",
          body: { providerRequestId: requireString(command.providerRequestId, "providerRequestId"), requestFingerprint: requireString(command.requestFingerprint, "requestFingerprint") },
          idempotencyKey: requireString(command.idempotencyKey, "idempotencyKey")
        });
        return { status: "supported", value: simulator.parseCancel(raw) };
      }
    });
  }

  private contextIsSimulated(context: AdapterCallContext): boolean {
    return context.mode === "simulated" && context.transport.mode === "simulated";
  }

  /**
   * Quote/preflight bundle digest (FC-08). An owner-shaped ProductionBundle reference digests to its owner
   * `content_hash`, so the simulated quote, the submit body and the authorization facts all carry the owner bundle
   * hash. This runs only after `contextIsSimulated`; nothing it returns is trusted outside simulated mode, and every
   * other value keeps the existing fixture digest byte-for-byte.
   */
  private bundleDigestOrFail(value: unknown): string {
    return ownerBundleReferenceDigest(value) ?? this.digestOrFail(value);
  }

  private digestOrFail(value: unknown): string {
    try {
      return simulatorFixtureDigest(value);
    } catch {
      throw new SimulatedProviderError();
    }
  }

  private validateSubmitQuote(command: SubmitCommand): PreflightReport {
    const quote = this.state.quotes.find((entry) => entry.providerQuoteId === command.quote.quoteId);
    if (quote === undefined || Date.parse(quote.expiresAt) <= this.state.nowMs || Date.parse(command.quote.expiresAt) <= this.state.nowMs) {
      return { valid: false, issues: [{ code: "stale_quote", safeMessage: "The local simulated quote is missing or expired." }] };
    }
    if (quote.productionBundleDigest !== command.productionBundleDigest ||
      quote.productionBundleDigest !== command.quote.productionBundleDigest ||
      quote.totalMinor !== command.amountMinor || quote.totalMinor !== command.quote.totalMinor ||
      quote.currency !== command.currency || quote.currency !== command.quote.currency ||
      quote.termsFingerprint !== command.quote.termsFingerprint || quote.expiresAt !== command.quote.expiresAt) {
      return { valid: false, issues: [{ code: "quote_terms_mismatch", safeMessage: "The local simulated quote terms do not match the submission." }] };
    }
    return { valid: true, issues: [] };
  }

  private takeAdapterFault(operation: Operation): "refuse_before_dispatch" | "unsupported" | undefined {
    const index = this.state.faults.findIndex((fault) => fault.operation === operation &&
      (fault.kind === "refuse_before_dispatch" || fault.kind === "unsupported"));
    if (index < 0) return undefined;
    const [fault] = this.state.faults.splice(index, 1);
    if (fault === undefined) return undefined;
    this.state.triggeredFaults.push({ operation: fault.operation, kind: fault.kind } as SimulatorFault);
    return fault.kind === "refuse_before_dispatch" || fault.kind === "unsupported" ? fault.kind : undefined;
  }

  private takeTransportFault(operation: Operation): SimulatorFaultKind | undefined {
    const index = this.state.faults.findIndex((fault) => fault.operation === operation &&
      fault.kind !== "refuse_before_dispatch" && fault.kind !== "unsupported");
    if (index < 0) return undefined;
    const [fault] = this.state.faults.splice(index, 1);
    if (fault === undefined) return undefined;
    this.state.triggeredFaults.push({ operation: fault.operation, kind: fault.kind } as SimulatorFault);
    return fault.kind;
  }

  private async request<T>(request: import("./types.js").ProviderTransportRequest): Promise<T> {
    this.assertLocalRequest(request);
    this.state.dispatchCounters[request.operation] += 1;
    const fault = this.takeTransportFault(request.operation);
    if (fault === "rate_limit") throw new SimulatedProviderError("Simulated provider rate limit.", "RATE_LIMIT", 429);
    let response: unknown;
    switch (request.operation) {
      case "discover_capabilities":
        response = { supported: true };
        break;
      case "quote":
        response = this.quoteResponse(request.body);
        break;
      case "preflight":
        response = this.preflightResponse(request.body);
        break;
      case "submit":
        response = this.submitResponse(request.body, request.idempotencyKey);
        break;
      case "status":
        response = this.statusResponse(request.body, fault === "unknown_status");
        break;
      case "shipment":
        response = this.shipmentResponse(request.body);
        break;
      case "cancel":
        response = this.cancelResponse(request.body, request.idempotencyKey);
        break;
      default:
        throw new SimulatedProviderError();
    }
    if (fault === "accepted_then_timeout") {
      const timeout = new Error("Simulated accepted request timed out.");
      timeout.name = "TimeoutError";
      throw timeout;
    }
    if (fault === "crash_after_acceptance") {
      this.crashBarrierHandler?.();
      const crash = new Error("Simulated process interruption after provider acceptance.");
      crash.name = "SimulatedCrashError";
      throw crash;
    }
    if (fault === "malformed_response") return { malformed: true } as T;
    if (fault === "unknown_status" && request.operation !== "status") throw new SimulatedProviderError();
    return response as T;
  }

  private assertLocalRequest(request: import("./types.js").ProviderTransportRequest): void {
    const routes: Readonly<Record<Operation, readonly [string, string]>> = {
      discover_capabilities: ["GET", "/simulator/capabilities"],
      quote: ["POST", "/simulator/quotes"],
      preflight: ["POST", "/simulator/preflight"],
      submit: ["POST", "/simulator/orders"],
      status: ["GET", "/simulator/orders/status"],
      shipment: ["GET", "/simulator/orders/shipments"],
      cancel: ["POST", "/simulator/orders/cancel"]
    };
    const route = request !== null && typeof request === "object" && validOperation(request.operation) ? routes[request.operation] : undefined;
    if (route === undefined || request.method !== route[0] || request.path !== route[1] || request.path.startsWith("http")) {
      throw new SimulatedProviderError();
    }
  }

  private quoteResponse(body: unknown): QuoteResult {
    if (!isPlainRecord(body)) throw new SimulatedProviderError();
    const productionBundleDigest = requireString(body.bundleDigest, "bundleDigest");
    const quantity = requireSafeInteger(body.quantity, 1);
    if (quantity > MAX_QUANTITY) throw new SimulatedProviderError();
    const existing = this.state.quotes.find((entry) => entry.productionBundleDigest === productionBundleDigest &&
      entry.quantity === quantity && Date.parse(entry.createdAt) === this.state.nowMs);
    if (existing !== undefined) return stableQuote(existing);
    const production = UNIT_PRODUCTION_MINOR * quantity;
    const tax = Math.floor((production * SIMULATED_TAX_BASIS_POINTS + 5_000) / 10_000);
    const totalMinor = production + FLAT_SHIPPING_MINOR + tax;
    if (!Number.isSafeInteger(totalMinor)) throw new SimulatedProviderError();
    const quoteExpiryMs = this.state.nowMs + this.state.quoteTtlMs;
    if (!Number.isSafeInteger(quoteExpiryMs) || quoteExpiryMs > MAX_DATE_EPOCH_MS) throw new SimulatedProviderError();
    const expiresAt = iso(quoteExpiryMs);
    const providerQuoteId = `sim-quote-${hashText(`${this.state.seed}|${productionBundleDigest}|${quantity}|${totalMinor}|${CURRENCY}|${this.state.nowMs}|${this.state.quoteTtlMs}`).slice(0, 20)}`;
    const termsFingerprint = simulatorQuoteTermsFingerprint({
      providerQuoteId, totalMinor, currency: CURRENCY, expiresAt, productionBundleDigest
    });
    const record: SimulatorQuoteRecord = {
      providerQuoteId,
      productionBundleDigest,
      quantity,
      totalMinor,
      currency: CURRENCY,
      termsFingerprint,
      createdAt: iso(this.state.nowMs),
      expiresAt
    };
    this.state.quotes.push(record);
    return stableQuote(record);
  }

  private preflightResponse(body: unknown): PreflightReport {
    if (!isPlainRecord(body) || typeof body.bundleDigest !== "string" || typeof body.specificationDigest !== "string") {
      throw new SimulatedProviderError();
    }
    return { valid: true, issues: [] };
  }

  private submitResponse(body: unknown, idempotencyKey: string | undefined): SubmitResult {
    if (!isPlainRecord(body)) throw new SimulatedProviderError();
    const quoteId = requireString(body.quoteId, "quoteId");
    const quoteExpiresAt = requireString(body.quoteExpiresAt, "quoteExpiresAt");
    const termsFingerprint = requireString(body.termsFingerprint, "termsFingerprint");
    const productionBundleDigest = requireString(body.productionBundleDigest, "productionBundleDigest");
    const amountMinor = requireSafeInteger(body.amountMinor, 1);
    const currency = requireString(body.currency, "currency");
    const requestFingerprint = requireString(body.requestFingerprint, "requestFingerprint");
    const key = requireString(idempotencyKey, "idempotencyKey");
    const quote = this.state.quotes.find((entry) => entry.providerQuoteId === quoteId);
    const keyDigest = hashText(`${this.state.seed}|provider-idempotency|${key}`);
    const requestDigest = hashText(canonicalJson({ quoteId, productionBundleDigest, amountMinor, currency, requestFingerprint }));
    const active = this.state.idempotency.find((entry) => entry.keyDigest === keyDigest && entry.expiresAt > this.state.nowMs);
    if (active !== undefined) {
      if (active.requestDigest !== requestDigest || quote === undefined || quote.productionBundleDigest !== productionBundleDigest ||
        quote.totalMinor !== amountMinor || quote.currency !== currency || quote.termsFingerprint !== termsFingerprint || quote.expiresAt !== quoteExpiresAt) {
        throw new SimulatedProviderError("The simulated idempotency key conflicts.", "IDEMPOTENCY_CONFLICT");
      }
      this.state.duplicateSubmissions += 1;
      const existingOrder = this.findOrder(active.providerRequestId);
      if (existingOrder === undefined) throw new SimulatedProviderError();
      return { providerRequestId: existingOrder.providerRequestId, acceptedAt: existingOrder.acceptedAt };
    }
    if (quote === undefined) {
      throw new SimulatedProviderError("The simulated quote is stale.", "STALE_QUOTE");
    }
    if (quote.productionBundleDigest !== productionBundleDigest || quote.totalMinor !== amountMinor || quote.currency !== currency ||
      quote.termsFingerprint !== termsFingerprint || quote.expiresAt !== quoteExpiresAt) {
      throw new SimulatedProviderError("The simulated quote terms differ.", "QUOTE_MISMATCH");
    }
    if (Date.parse(quote.expiresAt) <= this.state.nowMs || Date.parse(quoteExpiresAt) <= this.state.nowMs) {
      throw new SimulatedProviderError("The simulated quote is stale.", "STALE_QUOTE");
    }
    const priorGeneration = this.state.idempotencyHistory.reduce(
      (maximum, entry) => entry.keyDigest === keyDigest ? Math.max(maximum, entry.generation) : maximum,
      0
    );
    const generation = priorGeneration + 1;
    const idempotencyExpiry = this.state.nowMs + this.state.idempotencyTtlMs;
    if (!Number.isSafeInteger(idempotencyExpiry)) throw new SimulatedProviderError();
    const providerRequestId = `sim-order-${hashText(`${this.state.seed}|${keyDigest}|${requestDigest}|${generation}`).slice(0, 20)}`;
    const order: SimulatorOrderRecord = {
      providerRequestId,
      quoteId,
      productionBundleDigest,
      requestFingerprintDigest: `sha256:${requestDigest}`,
      amountMinor,
      currency,
      acceptedAt: iso(this.state.nowMs),
      status: "accepted",
      statusOccurredAt: iso(this.state.nowMs),
      shipments: []
    };
    this.state.orders.push(order);
    const idempotencyRecord = { keyDigest, requestDigest, providerRequestId, expiresAt: idempotencyExpiry, generation };
    this.state.idempotencyHistory.push(idempotencyRecord);
    this.state.idempotency = this.state.idempotency.filter((entry) => entry.keyDigest !== keyDigest);
    this.state.idempotency.push(idempotencyRecord);
    this.state.billingEvidence.push({
      billingMode: "simulated",
      event: "order_accepted",
      providerRequestId,
      amountMinor,
      currency,
      observedAt: iso(this.state.nowMs),
      charged: false
    });
    return { providerRequestId, acceptedAt: order.acceptedAt };
  }

  private statusResponse(body: unknown, forceUnknown: boolean): StatusResult {
    if (!isPlainRecord(body)) throw new SimulatedProviderError();
    const providerRequestId = requireString(body.providerRequestId, "providerRequestId");
    const order = this.findOrder(providerRequestId);
    const normalizedState: SimulatorOrderStatus = forceUnknown || order === undefined ? "unknown" : order.status;
    return {
      providerRequestId,
      providerStatus: normalizedState === "unknown" ? "Unknown" : normalizedState,
      normalizedState,
      observedAt: iso(this.state.nowMs)
    };
  }

  private shipmentResponse(body: unknown): ShipmentResult {
    if (!isPlainRecord(body)) throw new SimulatedProviderError();
    const providerRequestId = requireString(body.providerRequestId, "providerRequestId");
    const order = this.findOrder(providerRequestId);
    const shipment = order?.shipments[0];
    if (shipment === undefined) return { providerRequestId, observedAt: iso(this.state.nowMs) };
    return {
      providerRequestId,
      providerShipmentId: shipment.providerShipmentId,
      trackingNumber: shipment.trackingNumber,
      carrier: shipment.carrier,
      observedAt: iso(this.state.nowMs)
    };
  }

  private cancelResponse(body: unknown, idempotencyKey: string | undefined): CancelResult {
    if (!isPlainRecord(body)) throw new SimulatedProviderError();
    const providerRequestId = requireString(body.providerRequestId, "providerRequestId");
    if (!isSyntheticOrderId(providerRequestId)) throw new SimulatedProviderError();
    const key = requireString(idempotencyKey, "idempotencyKey");
    const requestDigest = hashText(canonicalJson({ providerRequestId, requestFingerprint: requireString(body.requestFingerprint, "requestFingerprint") }));
    const keyDigest = hashText(`${this.state.seed}|cancel-idempotency|${key}`);
    const idempotency = this.state.cancelIdempotency.find((entry) => entry.keyDigest === keyDigest && entry.expiresAt > this.state.nowMs);
    if (idempotency !== undefined && idempotency.requestDigest !== requestDigest) {
      throw new SimulatedProviderError("The simulated cancellation key conflicts.", "IDEMPOTENCY_CONFLICT");
    }
    if (idempotency !== undefined) return JSON.parse(JSON.stringify(idempotency.result)) as CancelResult;
    const order = this.findOrder(providerRequestId);
    let outcome: CancelResult["outcome"];
    if (order === undefined) outcome = "not_found";
    else if (["delivered", "cancelled", "failed", "shipped"].includes(order.status)) outcome = "already_terminal";
    else outcome = "cancelled";
    const observedAt = iso(this.state.nowMs);
    const result = { providerRequestId, outcome, observedAt } satisfies CancelResult;
    const priorGeneration = this.state.cancelIdempotencyHistory.reduce(
      (maximum, entry) => entry.keyDigest === keyDigest ? Math.max(maximum, entry.generation) : maximum,
      0
    );
    const generation = priorGeneration + 1;
    const idempotencyExpiry = this.state.nowMs + this.state.idempotencyTtlMs;
    if (!Number.isSafeInteger(idempotencyExpiry)) throw new SimulatedProviderError();
    const idempotencyRecord = { keyDigest, requestDigest, result, expiresAt: idempotencyExpiry, generation };
    if (outcome === "cancelled") {
      if (order === undefined) throw new SimulatedProviderError();
      mergeStatusObservation(order, "cancelled", observedAt);
      const event: SimulatorCancellationEvent = {
        eventId: `sim-cancel-event-${hashText(`${this.state.seed}|${keyDigest}|${requestDigest}|${generation}|${providerRequestId}|${observedAt}`).slice(0, 16)}`,
        keyDigest,
        requestDigest,
        generation,
        providerRequestId,
        occurredAt: observedAt
      };
      this.state.cancellations.push(event);
    }
    this.state.cancelIdempotencyHistory.push(idempotencyRecord);
    this.state.cancelIdempotency = this.state.cancelIdempotency.filter((entry) => entry.keyDigest !== keyDigest);
    this.state.cancelIdempotency.push(idempotencyRecord);
    return JSON.parse(JSON.stringify(result)) as CancelResult;
  }

  private parseQuote(value: unknown): QuoteResult {
    if (!isPlainRecord(value) || !Array.isArray(value.breakdown)) throw new SimulatedProviderError();
    const result = value as unknown as QuoteResult;
    requireString(result.providerQuoteId, "providerQuoteId");
    requireString(result.currency, "currency");
    requireString(result.expiresAt, "expiresAt");
    requireSafeInteger(result.totalMinor, 0);
    if (!Number.isFinite(Date.parse(result.expiresAt)) || !/^[A-Z]{3}$/.test(result.currency)) throw new SimulatedProviderError();
    let sum = 0;
    for (const line of result.breakdown) {
      if (!isPlainRecord(line)) throw new SimulatedProviderError();
      requireString(line.label, "label");
      sum += requireSafeInteger(line.amountMinor, 0);
      if (!Number.isSafeInteger(sum)) throw new SimulatedProviderError();
    }
    if (sum !== result.totalMinor) throw new SimulatedProviderError();
    return JSON.parse(JSON.stringify(result)) as QuoteResult;
  }

  private parsePreflight(value: unknown): PreflightReport {
    if (!isPlainRecord(value) || typeof value.valid !== "boolean" || !Array.isArray(value.issues)) throw new SimulatedProviderError();
    for (const issue of value.issues) {
      if (!isPlainRecord(issue) || typeof issue.code !== "string" || typeof issue.safeMessage !== "string") throw new SimulatedProviderError();
    }
    return JSON.parse(JSON.stringify(value)) as PreflightReport;
  }

  private parseSubmit(value: unknown): SubmitResult {
    if (!isPlainRecord(value)) throw new SimulatedProviderError();
    const providerRequestId = requireString(value.providerRequestId, "providerRequestId");
    const acceptedAt = requireString(value.acceptedAt, "acceptedAt");
    if (!Number.isFinite(Date.parse(acceptedAt))) throw new SimulatedProviderError();
    return { providerRequestId, acceptedAt };
  }

  private parseStatus(value: unknown): StatusResult {
    if (!isPlainRecord(value) || !validStatus(value.normalizedState)) throw new SimulatedProviderError();
    const providerRequestId = requireString(value.providerRequestId, "providerRequestId");
    const providerStatus = requireString(value.providerStatus, "providerStatus");
    const observedAt = requireString(value.observedAt, "observedAt");
    if (!Number.isFinite(Date.parse(observedAt))) throw new SimulatedProviderError();
    return { providerRequestId, providerStatus, normalizedState: value.normalizedState, observedAt };
  }

  private parseShipment(value: unknown): ShipmentResult {
    if (!isPlainRecord(value)) throw new SimulatedProviderError();
    const providerRequestId = requireString(value.providerRequestId, "providerRequestId");
    const observedAt = requireString(value.observedAt, "observedAt");
    if (!Number.isFinite(Date.parse(observedAt))) throw new SimulatedProviderError();
    if (value.providerShipmentId === undefined) return { providerRequestId, observedAt };
    return {
      providerRequestId,
      providerShipmentId: requireString(value.providerShipmentId, "providerShipmentId"),
      trackingNumber: requireString(value.trackingNumber, "trackingNumber"),
      carrier: requireString(value.carrier, "carrier"),
      observedAt
    };
  }

  private parseCancel(value: unknown): CancelResult {
    if (!isPlainRecord(value) || (value.outcome !== "cancelled" && value.outcome !== "already_terminal" && value.outcome !== "not_found")) {
      throw new SimulatedProviderError();
    }
    const providerRequestId = requireString(value.providerRequestId, "providerRequestId");
    const observedAt = requireString(value.observedAt, "observedAt");
    if (!Number.isFinite(Date.parse(observedAt))) throw new SimulatedProviderError();
    return { providerRequestId, outcome: value.outcome, observedAt };
  }

  private findOrder(providerRequestId: string): SimulatorOrderRecord | undefined {
    return this.state.orders.find((order) => order.providerRequestId === providerRequestId);
  }
}

export function createDeterministicSimulator(options: SimulatorOptions): DeterministicSimulator {
  return new DeterministicSimulator(options);
}
