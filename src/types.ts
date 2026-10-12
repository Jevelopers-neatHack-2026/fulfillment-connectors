/**
 * Connector-local worker types.
 *
 * These are private adapter-facing values. Cross-repository envelopes and
 * payloads remain owned by shared-contracts and are accepted or emitted only
 * through an injected ContractValidator.
 */

import type { ProductionBundleEvidence, ProductionBundleGate } from "./production-bundle-contract.js";

export type ProviderMode = "simulated" | "sandbox";
export type Operation =
  | "discover_capabilities"
  | "quote"
  | "preflight"
  | "submit"
  | "status"
  | "shipment"
  | "cancel";

export type SharedShape =
  | "operation_envelope"
  | "capability"
  | "print_specification"
  | "preflight_report"
  | "production_bundle"
  | "fulfillment_quote"
  | "order_authorization"
  | "shipment_observation"
  | "operation_result"
  | "budget_reservation"
  | "fulfillment_usage";

export interface TrustedScope {
  readonly tenantId: string;
  readonly projectId: string;
}

export type ContractBindingState = "missing" | "development_fixture" | "accepted";

export interface ContractBinding {
  readonly shape: SharedShape;
  readonly ownerRepository: string;
  readonly upstreamIssue: string;
  readonly state: ContractBindingState;
  readonly schemaVersion?: string;
  readonly sourceRevision?: string;
  readonly fixtureDigest?: string;
}

export interface ContractReceipt {
  readonly shape: SharedShape;
  readonly schemaVersion: string;
  readonly tenantId: string;
  readonly projectId: string;
}

export interface BoundaryFailure {
  readonly code: "invalid_input" | "contract_missing" | "unsupported_schema_major" | "scope_mismatch";
}

export type BoundaryResult<T> =
  | { readonly ok: true; readonly value: T; readonly receipts: readonly ContractReceipt[] }
  | { readonly ok: false; readonly failure: BoundaryFailure };

export interface InboundBoundaryRequest {
  readonly operation: Operation;
  readonly requiredShapes: readonly SharedShape[];
  readonly envelope: unknown;
  readonly trustedScope: TrustedScope;
}

export interface OutboundBoundaryRequest {
  readonly operation: Operation;
  readonly requiredShapes: readonly SharedShape[];
  readonly value: unknown;
  readonly trustedScope: TrustedScope;
}

export interface ContractValidator {
  binding(shape: SharedShape): ContractBinding;
  validateInbound<T>(request: InboundBoundaryRequest): Promise<BoundaryResult<T>>;
  validateOutbound(request: OutboundBoundaryRequest): Promise<BoundaryResult<unknown>>;
}

export interface CapabilityQuery {
  readonly catalogKey?: string;
}

export interface QuoteCommand {
  readonly productionBundle: unknown;
  readonly quantity: number;
  readonly destination: unknown;
}

export interface PreflightCommand {
  readonly productionBundle: unknown;
  readonly printSpecification: unknown;
}

export interface SubmitQuoteTerms {
  readonly quoteId: string;
  readonly currency: string;
  readonly totalMinor: number;
  readonly expiresAt: string;
  readonly productionBundleDigest: string;
  readonly termsFingerprint: string;
}

export interface SubmitCommand {
  readonly productionBundle: unknown;
  readonly productionBundleDigest: string;
  readonly quote: SubmitQuoteTerms;
  readonly authorizationEnvelope: unknown;
  readonly amountMinor: number;
  readonly currency: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
}

export interface StatusCommand {
  readonly providerRequestId: string;
}

export interface ShipmentCommand {
  readonly providerRequestId: string;
}

export interface CancelCommand {
  readonly providerRequestId: string;
  readonly authorizationEnvelope: unknown;
  readonly budgetRequest?: BudgetRequest;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
}

export interface QuoteResult {
  readonly providerQuoteId: string;
  readonly currency: string;
  readonly totalMinor: number;
  readonly expiresAt: string;
  readonly breakdown: readonly { readonly label: string; readonly amountMinor: number }[];
}

export interface PreflightIssue {
  readonly code: string;
  readonly safeMessage: string;
}

export interface PreflightReport {
  readonly valid: boolean;
  readonly issues: readonly PreflightIssue[];
}

export interface SubmitResult {
  readonly providerRequestId: string;
  readonly acceptedAt: string;
}

export interface StatusResult {
  readonly providerRequestId: string;
  readonly providerStatus: string;
  readonly normalizedState: "pending" | "accepted" | "in_production" | "shipped" | "delivered" | "cancelled" | "failed" | "unknown";
  readonly observedAt: string;
}

export interface ShipmentResult {
  readonly providerRequestId: string;
  readonly providerShipmentId?: string;
  readonly trackingNumber?: string;
  readonly carrier?: string;
  readonly observedAt: string;
}

export interface CancelResult {
  readonly providerRequestId: string;
  readonly outcome: "cancelled" | "already_terminal" | "not_found";
  readonly observedAt: string;
}

export type ProviderResult<T> =
  | { readonly status: "supported"; readonly value: T }
  | { readonly status: "unsupported" };

export type SideEffectDeclaration = "none" | "external";
export type IdempotencyDeclaration = "not_applicable" | "provider_key" | "connector_attempt_store" | "unknown";

export interface OperationCapability {
  readonly supported: boolean;
  readonly sideEffect: SideEffectDeclaration;
  readonly mayCharge: boolean;
  readonly idempotency: IdempotencyDeclaration;
}

export type OperationCapabilities = Readonly<Record<Operation, OperationCapability>>;

export interface ProviderDescriptor {
  readonly providerId: string;
  readonly apiVersion: string;
  readonly productLimits: Readonly<Record<string, number | string | boolean>>;
  readonly operations: OperationCapabilities;
  readonly supportedModes: readonly ProviderMode[];
}

export interface ConnectorCapabilities extends ProviderDescriptor {
  readonly mode: ProviderMode;
}

export interface ProviderTransportRequest {
  readonly operation: Operation;
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: string;
  readonly body?: unknown;
  readonly idempotencyKey?: string;
}

export interface ProviderTransport {
  readonly mode: ProviderMode;
  request<T>(request: ProviderTransportRequest): Promise<T>;
}

export interface Clock {
  now(): number;
}

export interface AdapterCallContext {
  readonly mode: ProviderMode;
  readonly transport: ProviderTransport;
  readonly clock: Clock;
}

export interface PreSubmitContext {
  readonly mode: ProviderMode;
  readonly clock: Clock;
  readonly trustedScope: TrustedScope;
}

export interface AuthorizationFacts {
  /** Facts the issuer must bind; caller idempotency keys/fingerprints are excluded. */
  readonly providerId: string;
  readonly mode: ProviderMode;
  readonly trustedScope: TrustedScope;
  readonly operation: "submit" | "cancel";
  readonly command: Readonly<Record<string, unknown>>;
}

export interface AuthorizationCheck {
  readonly authorizationEnvelope: unknown;
  readonly facts: AuthorizationFacts;
}

export type AuthorizationClaimResult =
  | { readonly status: "rejected" }
  | {
      readonly status: "claimed";
      /** Stable identity of the issuer authorization. */
      readonly authorizationId: string;
      /** Stable logical fulfillment-action identity across authorization renewals and delivery keys. */
      readonly actionId: string;
      readonly claimReference: string;
    };

export type AuthorizationClaimed = Extract<AuthorizationClaimResult, { readonly status: "claimed" }>;

export type AuthorizationDispatchResult =
  | { readonly status: "dispatchable" }
  | { readonly status: "rejected" };

export interface AuthorizationVerifier {
  /**
   * The external authorization authority must verify these exact facts and
   * atomically claim the permitted action. A local boolean check is insufficient.
   */
  verifyAndClaim(check: AuthorizationCheck): Promise<AuthorizationClaimResult>;
  /**
   * Optional. A claim is not a promise that the authority still holds at
   * dispatch. When present, submit calls this immediately before EVERY
   * transport request, including adapter retries, after every other awaited
   * pre-dispatch step (including the dispatching metering write) with only
   * synchronous checks between the answer and the request, and sends nothing unless the
   * answer is exactly `dispatchable`. `rejected` is a stale authorization and a
   * throw or malformed answer is an unavailable verifier. Verifiers without the
   * method behave exactly as before.
   */
  revalidateBeforeDispatch?(check: AuthorizationCheck, claim: AuthorizationClaimed): Promise<AuthorizationDispatchResult>;
}

/**
 * The complete purchase terms the connector itself holds, in the shape an
 * order-authorization issuer compares against the signed record. They come from
 * the connector's own quote, bundle and destination bindings, never from the
 * authorization envelope.
 */
export interface TrustedOrderTerms {
  readonly orderRef: string;
  /** The confirmed supplier SKU, or null while none is confirmed. Never guessed. */
  readonly sku: string | null;
  readonly options: {
    readonly variantId: string;
    readonly material: string;
    readonly finish: string;
    readonly size: string;
    readonly quantity: number;
  };
  readonly quote: { readonly id: string; readonly amountMinor: number; readonly currency: string };
  /** An opaque destination reference and its digest. Never an address. */
  readonly destination: { readonly ref: string; readonly digest: string };
  readonly design: {
    readonly versionId: string;
    readonly designHash: string;
    readonly artHash: string;
    readonly factsHash: string;
    readonly compositionHash: string;
  };
  readonly approvalId: string;
  readonly capabilityVersion: string;
}

export interface TrustedTermsRequest {
  readonly trustedScope: TrustedScope;
  readonly providerId: string;
  readonly mode: ProviderMode;
  readonly productionBundleDigest: string;
  readonly quote: SubmitQuoteTerms;
}

export type TrustedTermsResult =
  | {
      readonly status: "bound";
      readonly terms: TrustedOrderTerms;
      /** Only explicit development fixtures are accepted until canonical bindings are accepted. */
      readonly provenance: { readonly kind: "development_fixture"; readonly digest: string };
    }
  | { readonly status: "missing"; readonly fields: readonly string[] };

/** Returns full terms only from exact local bindings, or reports what it cannot bind. */
export interface TrustedTermsSource {
  resolve(request: TrustedTermsRequest): Promise<TrustedTermsResult>;
}

export interface BudgetRequest {
  readonly amountMinor: number;
  readonly currency: string;
  readonly purpose: "fulfillment_submit" | "fulfillment_cancel";
}

export interface BudgetCheck {
  /** Canonical shared-contract payload, produced by ContractValidator. */
  readonly contractPayload: unknown;
  readonly trustedScope: TrustedScope;
  readonly mode: ProviderMode;
}

export interface BudgetClient {
  /** A thrown or malformed response is an uncertain reservation, never a denial. */
  authorize(check: BudgetCheck): Promise<{ readonly authorized: boolean; readonly reference?: string }>;
}

export type AttemptEffectState = "not_dispatched" | "possible" | "confirmed" | "unknown";
export type BudgetReservationState = "not_requested" | "pending" | "reserved" | "denied" | "unknown";

export interface SubmitAttemptRecord {
  readonly providerId: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly idempotencyKey: string;
  readonly claimId: string;
  readonly authorizationId: string;
  readonly actionId: string;
  readonly authorizationClaimReference: string;
  readonly requestFingerprint: string;
  readonly sideEffectState: AttemptEffectState;
  readonly budgetReservationState: BudgetReservationState;
  readonly budgetReservationReference?: string;
  readonly providerRequestId?: string;
  readonly updatedAt: number;
}

export interface AttemptPersistence {
  getSubmitAttempt(providerId: string, scope: TrustedScope, idempotencyKey: string): Promise<SubmitAttemptRecord | undefined>;
  /**
   * Atomically creates a durable, non-reclaimable action claim. The backing
   * store must enforce uniqueness by scoped logical actionId and authorizationId
   * as well as provider idempotency key, across workers and process restarts.
   * Budget reservations in pending, reserved, or unknown state are never
   * released or retried here; only an external authority may reconcile them.
   */
  claimSubmitAttempt(record: SubmitAttemptRecord): Promise<{
    readonly claimed: boolean;
    readonly existing?: SubmitAttemptRecord;
  }>;
  /** Updates only the record owned by record.claimId. */
  saveSubmitAttempt(record: SubmitAttemptRecord): Promise<void>;
}

export interface UsageEvent {
  readonly providerId: string;
  readonly operation: Operation;
  readonly mode: ProviderMode;
  readonly outcome: "dispatching" | "succeeded" | "failed";
  readonly sideEffectState: AttemptEffectState;
  readonly recordedAt: number;
}

export interface UsageSink {
  /** Canonical shared-contract payload, produced by ContractValidator. */
  record(contractPayload: unknown): Promise<void>;
}

/** Observation facts accepted by the runtime's durable metering adapter. */
export interface RuntimeMeteringObservation {
  readonly operation: Operation;
  readonly sourceEventKey?: string;
  readonly logicalOperationId?: string;
  readonly billableAttemptId?: string;
  readonly transportAttemptId?: string;
  readonly providerRequestId?: string;
  readonly outcome: "observed" | "attempt_prepared" | "dispatching" | "provider_accepted" | "not_dispatched" | "unknown";
  readonly completeness: "complete" | "partial" | "unknown";
  readonly durationMs?: number;
  readonly sourceRefs?: readonly string[];
  readonly quoteAmount?: {
    readonly amount: null |
      { readonly representation: "decimal"; readonly value: string; readonly currency: string } |
      { readonly representation: "scaled"; readonly units: string; readonly scale: number; readonly currency: string } |
      { readonly representation: "minor_units"; readonly units: string; readonly currency: string };
    readonly basis: "unknown" | "estimated" | "provider_confirmed";
  };
  readonly chargeAmount?: {
    readonly amount: null |
      { readonly representation: "decimal"; readonly value: string; readonly currency: string } |
      { readonly representation: "scaled"; readonly units: string; readonly scale: number; readonly currency: string } |
      { readonly representation: "minor_units"; readonly units: string; readonly currency: string };
    readonly basis: "unknown" | "estimated" | "provider_confirmed";
  };
  readonly effect: "non_billable_observation" | "potentially_billable_effect" | "confirmed_effect" | "unknown_effect";
}

export interface RuntimeMeteringRecorder {
  isConfiguredFor(providerId: string, mode: ProviderMode, scope: TrustedScope): boolean;
  recordObservation(input: RuntimeMeteringObservation): Promise<{ readonly status: string; readonly reason?: string }>;
  replayPending(): Promise<{ readonly pending: number; readonly failures: readonly string[] }>;
}

/** Opens a tenant/project-scoped durable metering recorder for one runtime call. */
export type RuntimeMeteringResolver = (scope: TrustedScope) => Promise<RuntimeMeteringRecorder>;

export interface ProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  quote(command: QuoteCommand, context: AdapterCallContext): Promise<ProviderResult<QuoteResult>>;
  preflight(command: PreflightCommand, context: AdapterCallContext): Promise<ProviderResult<PreflightReport>>;
  validateBeforeSubmit(command: SubmitCommand, context: PreSubmitContext): Promise<ProviderResult<PreflightReport>>;
  submit(command: SubmitCommand, context: AdapterCallContext): Promise<ProviderResult<SubmitResult>>;
  getStatus(command: StatusCommand, context: AdapterCallContext): Promise<ProviderResult<StatusResult>>;
  observeShipment(command: ShipmentCommand, context: AdapterCallContext): Promise<ProviderResult<ShipmentResult>>;
  cancel(command: CancelCommand, context: AdapterCallContext): Promise<ProviderResult<CancelResult>>;
}

export interface RuntimeDependencies {
  readonly contracts: ContractValidator;
  readonly transport: ProviderTransport;
  readonly clock: Clock;
  readonly persistence: AttemptPersistence;
  readonly authorizationVerifier: AuthorizationVerifier;
  readonly budgetClient: BudgetClient;
  readonly usageSink: UsageSink;
  /** Billable operations fail closed when no durable metering recorder is configured. */
  readonly metering?: RuntimeMeteringResolver;
  /**
   * The ProductionBundle gate (FC-08). Only an object created by `createProductionBundleGate` is accepted. Once the
   * `production_bundle` contract binding is `accepted`, a missing gate fails `contract_missing`.
   */
  readonly productionBundleGate?: ProductionBundleGate;
}

export interface RuntimeOptions {
  readonly mode?: ProviderMode;
  readonly sandboxEnabled?: boolean;
}

export interface ConnectorResponse<T> {
  readonly operation: Operation;
  readonly mode: ProviderMode;
  readonly providerId: string;
  readonly value: T;
  readonly sharedPayload: unknown;
  readonly emittedShapes: readonly SharedShape[];
  /** Present only on a `submit` that passed the ProductionBundle gate. It can only say "blocked". */
  readonly productionBundleEvidence?: ProductionBundleEvidence;
}

export interface ContractReadiness {
  readonly ready: boolean;
  readonly missingAcceptedPins: readonly {
    readonly shape: SharedShape;
    readonly ownerRepository: string;
    readonly upstreamIssue: string;
    readonly state: ContractBindingState;
    readonly schemaVersion?: string;
    readonly sourceRevision?: string;
    readonly fixtureDigest?: string;
  }[];
}

export interface RuntimeAudit {
  readonly runtimeVersion: string;
  readonly defaultMode: ProviderMode;
  readonly liveModeSupported: false;
  readonly contractReadiness: ContractReadiness;
  readonly sandboxReady: boolean;
  readonly sandboxReasons: readonly string[];
}
