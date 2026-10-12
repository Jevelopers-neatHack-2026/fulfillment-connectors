import { ConnectorError, type ConnectorErrorCode } from "./errors.js";
import { ALL_SHARED_SHAPES, AUXILIARY_SHAPES, CONTRACT_OWNERSHIP, INPUT_SHAPES, OUTPUT_SHAPES, uniqueShapes } from "./contracts.js";
import {
  classifyRecheckFailure,
  evidenceFromReport,
  isGenuineProductionBundleGate,
  validateGateReport,
  type ProductionBundleGate,
  type ProductionBundleGateRequest,
  type ProductionBundleReport
} from "./production-bundle-contract.js";
import type {
  AdapterCallContext,
  AttemptEffectState,
  AuthorizationClaimResult,
  AuthorizationClaimed,
  AuthorizationCheck,
  AuthorizationDispatchResult,
  BudgetRequest,
  CancelCommand,
  CancelResult,
  CapabilityQuery,
  Clock,
  ConnectorCapabilities,
  ConnectorResponse,
  ContractBinding,
  ContractReceipt,
  ContractReadiness,
  ContractValidator,
  Operation,
  PreflightCommand,
  PreflightReport,
  PreSubmitContext,
  ProviderAdapter,
  ProviderDescriptor,
  ProviderMode,
  ProviderResult,
  QuoteCommand,
  QuoteResult,
  RuntimeAudit,
  RuntimeDependencies,
  RuntimeOptions,
  RuntimeMeteringRecorder,
  RuntimeMeteringObservation,
  ProviderTransportRequest,
  SharedShape,
  ShipmentCommand,
  ShipmentResult,
  StatusCommand,
  StatusResult,
  SubmitAttemptRecord,
  SubmitCommand,
  SubmitResult,
  TrustedScope,
  UsageEvent
} from "./types.js";

const RUNTIME_VERSION = "0.1.0";
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/;

interface ExecuteHooks<T> {
  readonly beforeTransport?: (transportCalled: boolean) => void | Promise<void>;
  /**
   * Awaited as the LAST asynchronous step before a transport request: after the
   * dispatching metering write, followed only by synchronous mode and quote
   * checks and then the transport call itself.
   */
  readonly beforeDispatch?: (transportCalled: boolean) => Promise<void>;
  readonly assertPreDispatch?: (transportCalled: boolean) => void;
  readonly onSuccess?: (value: T, sideEffectState: AttemptEffectState) => Promise<void>;
  readonly onFailure?: (sideEffectState: AttemptEffectState) => Promise<void>;
  readonly meteringAttempt?: {
    readonly logicalOperationId: string;
    readonly billableAttemptId: string;
    readonly sourceRefs: () => readonly string[];
    readonly quoteAmount?: RuntimeMeteringObservation["quoteAmount"];
  };
}

interface Decoded<T> {
  readonly value: T;
  readonly trustedScope: TrustedScope;
}

interface PrecheckedDecode {
  readonly shapes: readonly SharedShape[];
  readonly scopeSnapshot: TrustedScope;
  readonly envelopeSnapshot: unknown;
}

function snapshotJson(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("cyclic input");
    seen.add(value);
    const copy: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor)) throw new TypeError("sparse or accessor input");
      copy.push(snapshotJson(descriptor.value, seen));
    }
    seen.delete(value);
    return Object.freeze(copy);
  }
  if (typeof value !== "object") throw new TypeError("non-JSON input");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError("non-JSON object");
  if (seen.has(value)) throw new TypeError("cyclic input");
  seen.add(value);
  const copy: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new TypeError("symbol input");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) throw new TypeError("accessor input");
    Object.defineProperty(copy, key, {
      value: snapshotJson(descriptor.value, seen),
      enumerable: descriptor.enumerable === true,
      configurable: true,
      writable: true
    });
  }
  seen.delete(value);
  return Object.freeze(copy);
}

function validAuthorizationClaim(value: AuthorizationClaimResult): value is Extract<AuthorizationClaimResult, { status: "claimed" }> {
  return value !== null && typeof value === "object" && value.status === "claimed" &&
    typeof value.authorizationId === "string" && value.authorizationId.trim() !== "" && value.authorizationId.length <= 512 &&
    typeof value.actionId === "string" && value.actionId.trim() !== "" && value.actionId.length <= 512 &&
    typeof value.claimReference === "string" && value.claimReference.trim() !== "" && value.claimReference.length <= 512;
}

function validBudgetReservationReference(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && value.trim() === value &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function quoteAmountEvidence(totalMinor: number, currency: string): NonNullable<RuntimeMeteringObservation["quoteAmount"]> {
  return {
    amount: { representation: "minor_units", units: String(totalMinor), currency },
    basis: "provider_confirmed"
  };
}

function quoteAmountFromResult(value: unknown): RuntimeMeteringObservation["quoteAmount"] | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const candidate = value as { currency?: unknown; totalMinor?: unknown };
  if (typeof candidate.currency !== "string" || !/^[A-Z]{3}$/.test(candidate.currency) ||
      !Number.isSafeInteger(candidate.totalMinor) || (candidate.totalMinor as number) < 0) return undefined;
  return quoteAmountEvidence(candidate.totalMinor as number, candidate.currency);
}

export class FulfillmentConnectorRuntime {
  readonly mode: ProviderMode;
  private readonly descriptor: ProviderDescriptor;
  private readonly sandboxEnabled: boolean;
  private diagnosticCounter = 0;

  constructor(
    private readonly adapter: ProviderAdapter,
    private readonly dependencies: RuntimeDependencies,
    options: RuntimeOptions = {}
  ) {
    const rawOptions = options !== null && typeof options === "object" ? options as { mode?: unknown; sandboxEnabled?: unknown } : {};
    this.mode = (rawOptions.mode === undefined ? "simulated" : rawOptions.mode) as ProviderMode;
    this.descriptor = snapshotJson(adapter.descriptor) as ProviderDescriptor;
    Object.defineProperty(this, "mode", { value: this.mode, writable: false, configurable: false, enumerable: true });
    this.sandboxEnabled = rawOptions.sandboxEnabled === true;
  }

  audit(): RuntimeAudit {
    const contractReadiness = this.contractReadiness();
    const sandboxReasons: string[] = [];
    if (!this.sandboxEnabled) sandboxReasons.push("sandbox mode was not explicitly enabled");
    if (!contractReadiness.ready) sandboxReasons.push("one or more accepted shared-contract pins are missing");
    if (!this.descriptor.supportedModes.includes("sandbox")) sandboxReasons.push("provider adapter does not declare sandbox support");
    if (this.dependencies.transport.mode !== "sandbox") sandboxReasons.push("injected transport is not bound to sandbox mode");
    return {
      runtimeVersion: RUNTIME_VERSION,
      defaultMode: "simulated",
      liveModeSupported: false,
      contractReadiness,
      sandboxReady: sandboxReasons.length === 0,
      sandboxReasons
    };
  }

  async discoverCapabilities(envelope: unknown, trustedScope: TrustedScope): Promise<ConnectorResponse<ConnectorCapabilities>> {
    const { value: command, trustedScope: scope } = await this.decode<CapabilityQuery>("discover_capabilities", envelope, trustedScope);
    void command;
    const capabilities: ConnectorCapabilities = {
      ...this.descriptor,
      mode: this.mode
    };
    return this.execute("discover_capabilities", scope, async () => ({
      status: "supported",
      value: capabilities
    }));
  }

  async quote(envelope: unknown, trustedScope: TrustedScope): Promise<ConnectorResponse<QuoteResult>> {
    const { value: command, trustedScope: scope } = await this.decode<QuoteCommand>("quote", envelope, trustedScope);
    if (!Number.isSafeInteger(command.quantity) || command.quantity <= 0) {
      throw this.failure("quote", "invalid_input", "not_dispatched");
    }
    return this.execute("quote", scope, async (context) => {
      const result = await this.adapter.quote(command, context);
      if (result.status === "supported" && !this.validQuoteResult(result.value)) {
        throw this.failure("quote", "invalid_input", "not_dispatched");
      }
      return result;
    });
  }

  async preflight(envelope: unknown, trustedScope: TrustedScope): Promise<ConnectorResponse<PreflightReport>> {
    const { value: command, trustedScope: scope } = await this.decode<PreflightCommand>("preflight", envelope, trustedScope);
    return this.execute("preflight", scope, (context) => this.adapter.preflight(command, context));
  }

  async submit(envelope: unknown, trustedScope: TrustedScope): Promise<ConnectorResponse<SubmitResult>> {
    // PBR-23: decode's pure prechecks (mode, scope shape, snapshot, binding availability) keep their existing codes and
    // precedence; the ProductionBundle hard block then runs BEFORE ContractValidator.validateInbound or any other port.
    const prechecked = this.precheckDecode("submit", envelope, trustedScope);
    const bundleGate = this.assertSubmitBundleGate();
    const { value: command, trustedScope: scope } = await this.decodeAfterPrecheck<SubmitCommand>("submit", prechecked);
    this.validateSubmissionCommand(command, "submit");
    this.assertProviderSupport("submit");
    this.validateSubmissionDeclaration();
    const providerId = this.descriptor.providerId;
    const bundleRequest: ProductionBundleGateRequest | undefined = bundleGate === undefined ? undefined : {
      trustedScope: scope,
      bundleDigest: command.productionBundleDigest,
      providerId,
      runtimeMode: this.mode,
      transportMode: this.dependencies.transport.mode,
      quote: command.quote,
      envelopeBundle: command.productionBundle
    };
    // The gate runs before the adapter pre-submit, the claim, the budget and the metering write: an invalid bundle
    // reaches no other port. Its report is re-validated here; the gate's own say-so is never trusted.
    const bundleReport: ProductionBundleReport | undefined = bundleGate === undefined || bundleRequest === undefined
      ? undefined
      : await this.runBundleGate(bundleGate, "checkBeforeSubmit", bundleRequest, "not_dispatched");

    let preSubmit: ProviderResult<PreflightReport>;
    try {
      preSubmit = await this.adapter.validateBeforeSubmit(command, {
        mode: this.mode,
        clock: this.dependencies.clock,
        trustedScope: scope
      });
    } catch (error) {
      throw this.normalizeFailure(error, "submit", "not_dispatched", false);
    }
    if (preSubmit === null || typeof preSubmit !== "object" || !["supported", "unsupported"].includes(preSubmit.status)) {
      throw this.failure("submit", "provider_failure", "not_dispatched");
    }
    if (preSubmit.status === "unsupported") {
      throw this.failure("submit", "unsupported", "not_dispatched");
    }
    if (preSubmit.value === null || typeof preSubmit.value !== "object" || typeof preSubmit.value.valid !== "boolean") {
      throw this.failure("submit", "provider_failure", "not_dispatched");
    }
    if (!preSubmit.value.valid) {
      const staleQuote = Array.isArray(preSubmit.value.issues) && preSubmit.value.issues.some(
        (issue) => issue !== null && typeof issue === "object" && issue.code === "stale_quote"
      );
      throw this.failure("submit", staleQuote ? "stale_quote" : "invalid_input", "not_dispatched");
    }
    this.assertQuoteCurrent(command.quote);
    // Refuse an already mismatched transport before claiming authorization or
    // requesting a financial reservation. execute() rechecks after awaits.
    this.assertRuntimeMode("submit");

    const budgetRequest: BudgetRequest = {
      amountMinor: command.amountMinor,
      currency: command.currency,
      purpose: "fulfillment_submit"
    };
    const canonicalBudgetPayload = await this.encodeAuxiliaryPayload(
      "submit",
      "budget_reservation",
      budgetRequest,
      scope
    );

    let existing: SubmitAttemptRecord | undefined;
    try {
      existing = await this.dependencies.persistence.getSubmitAttempt(
        providerId,
        scope,
        command.idempotencyKey
      );
    } catch {
      throw this.failure("submit", "persistence_unavailable", "not_dispatched");
    }
    if (existing !== undefined) throw this.existingAttemptFailure(existing, command.requestFingerprint, true);

    const { authorizationEnvelope, idempotencyKey, requestFingerprint, ...authorizedCommand } = command;
    void idempotencyKey;
    void requestFingerprint;
    let authorization: AuthorizationCheck;
    try {
      authorization = snapshotJson({
        authorizationEnvelope,
        facts: {
          providerId,
          mode: this.mode,
          trustedScope: scope,
          operation: "submit",
          command: authorizedCommand
        }
      }) as AuthorizationCheck;
    } catch {
      throw this.failure("submit", "invalid_input", "not_dispatched");
    }
    let authorizationClaim: AuthorizationClaimResult;
    try {
      authorizationClaim = await this.dependencies.authorizationVerifier.verifyAndClaim(authorization);
    } catch {
      throw this.failure("submit", "authorization_unavailable", "not_dispatched");
    }
    if (authorizationClaim !== null && typeof authorizationClaim === "object" && authorizationClaim.status === "rejected") {
      throw this.failure("submit", "stale_authorization", "not_dispatched");
    }
    if (!validAuthorizationClaim(authorizationClaim)) {
      throw this.failure("submit", "authorization_unavailable", "not_dispatched");
    }

    const claim: SubmitAttemptRecord = {
      providerId,
      tenantId: scope.tenantId,
      projectId: scope.projectId,
      idempotencyKey: command.idempotencyKey,
      claimId: this.newReference(),
      authorizationId: authorizationClaim.authorizationId,
      actionId: authorizationClaim.actionId,
      authorizationClaimReference: authorizationClaim.claimReference,
      requestFingerprint: command.requestFingerprint,
      sideEffectState: "unknown",
      budgetReservationState: "not_requested",
      updatedAt: this.dependencies.clock.now()
    };
    let claimResult;
    try {
      claimResult = await this.dependencies.persistence.claimSubmitAttempt(claim);
    } catch {
      throw this.failure("submit", "persistence_unavailable", "not_dispatched");
    }
    if (!claimResult.claimed) {
      const occupied = claimResult.existing;
      if (occupied === undefined) throw this.failure("submit", "persistence_unavailable", "not_dispatched");
      throw this.existingAttemptFailure(occupied, command.requestFingerprint, occupied.idempotencyKey === command.idempotencyKey);
    }

    let currentAttempt = claim;
    const submitResponse = await this.execute(
      "submit",
      scope,
      async (context) => {
        this.assertQuoteCurrent(command.quote);
        currentAttempt = await this.saveAttempt({
          ...currentAttempt,
          budgetReservationState: "pending",
          updatedAt: this.dependencies.clock.now()
        });
        let result: { readonly authorized: boolean; readonly reference?: string };
        try {
          result = await this.dependencies.budgetClient.authorize({
            contractPayload: canonicalBudgetPayload,
            trustedScope: scope,
            mode: this.mode
          });
        } catch {
          try {
            currentAttempt = await this.saveAttempt({
              ...currentAttempt,
              budgetReservationState: "unknown",
              updatedAt: this.dependencies.clock.now()
            });
          } catch {
            // The previously stored pending state still prevents another reservation.
          }
          throw this.failure("submit", "budget_unavailable", "not_dispatched");
        }
        if (result === null || typeof result !== "object" || typeof result.authorized !== "boolean") {
          currentAttempt = await this.saveAttempt({
            ...currentAttempt,
            budgetReservationState: "unknown",
            updatedAt: this.dependencies.clock.now()
          });
          throw this.failure("submit", "budget_unavailable", "not_dispatched");
        }
        if (!result.authorized) {
          currentAttempt = await this.saveAttempt({
            ...currentAttempt,
            budgetReservationState: "denied",
            updatedAt: this.dependencies.clock.now()
          });
          throw this.failure("submit", "budget_denied", "not_dispatched");
        }
        if (!validBudgetReservationReference(result.reference)) {
          currentAttempt = await this.saveAttempt({
            ...currentAttempt,
            budgetReservationState: "unknown",
            updatedAt: this.dependencies.clock.now()
          });
          throw this.failure("submit", "budget_unavailable", "not_dispatched");
        }
        currentAttempt = await this.saveAttempt({
          ...currentAttempt,
          budgetReservationState: "reserved",
          budgetReservationReference: result.reference,
          updatedAt: this.dependencies.clock.now()
        });
        this.assertQuoteCurrent(command.quote);
        this.assertRuntimeMode("submit");
        return this.adapter.submit(command, context);
      },
      {
        meteringAttempt: {
          logicalOperationId: authorizationClaim.actionId,
          billableAttemptId: currentAttempt.claimId,
          sourceRefs: () => [
            `authorization-claim:${authorizationClaim.claimReference}`,
            `quote:${command.quote.quoteId}`,
            `bundle:${command.productionBundleDigest}`,
            ...(bundleReport === undefined ? [] : [`bundle-validation:${bundleReport.reportDigest}`]),
            ...(currentAttempt.budgetReservationReference === undefined
              ? []
              : [`budget-reservation:${currentAttempt.budgetReservationReference}`])
          ],
          quoteAmount: quoteAmountEvidence(command.quote.totalMinor, command.quote.currency)
        },
        ...(bundleGate !== undefined || typeof this.dependencies.authorizationVerifier.revalidateBeforeDispatch === "function" ? {
          beforeDispatch: (transportCalled: boolean) => this.recheckBeforeDispatch(
            bundleGate,
            bundleRequest,
            bundleReport,
            authorization,
            authorizationClaim,
            transportCalled
          )
        } : {}),
        assertPreDispatch: (transportCalled) => this.assertQuoteCurrent(
          command.quote,
          transportCalled ? "possible" : "not_dispatched"
        ),
        onSuccess: async (value) => {
          currentAttempt = await this.saveAttempt({
            ...currentAttempt,
            sideEffectState: "confirmed",
            providerRequestId: value.providerRequestId,
            updatedAt: this.dependencies.clock.now()
          });
        },
        onFailure: async (sideEffectState) => {
          currentAttempt = await this.saveAttempt({
            ...currentAttempt,
            sideEffectState,
            updatedAt: this.dependencies.clock.now()
          });
        }
      }
    );
    return bundleReport === undefined
      ? submitResponse
      : { ...submitResponse, productionBundleEvidence: evidenceFromReport(bundleReport) };
  }

  async getStatus(envelope: unknown, trustedScope: TrustedScope): Promise<ConnectorResponse<StatusResult>> {
    const { value: command, trustedScope: scope } = await this.decode<StatusCommand>("status", envelope, trustedScope);
    return this.execute("status", scope, (context) => this.adapter.getStatus(command, context));
  }

  async observeShipment(envelope: unknown, trustedScope: TrustedScope): Promise<ConnectorResponse<ShipmentResult>> {
    const { value: command, trustedScope: scope } = await this.decode<ShipmentCommand>("shipment", envelope, trustedScope);
    return this.execute("shipment", scope, (context) => this.adapter.observeShipment(command, context));
  }

  async cancel(envelope: unknown, trustedScope: TrustedScope): Promise<ConnectorResponse<CancelResult>> {
    const { value: command, trustedScope: scope } = await this.decode<CancelCommand>("cancel", envelope, trustedScope);
    this.validateCancelCommand(command);
    this.assertProviderSupport("cancel");
    const declaration = this.descriptor.operations.cancel;
    if (
      declaration.sideEffect !== "external" ||
      declaration.idempotency !== "provider_key" ||
      declaration.mayCharge
    ) {
      throw this.failure("cancel", "unsupported", "not_dispatched");
    }
    const providerId = this.descriptor.providerId;
    const { authorizationEnvelope, idempotencyKey, requestFingerprint, ...authorizedCommand } = command;
    void idempotencyKey;
    void requestFingerprint;
    let authorization: AuthorizationCheck;
    try {
      authorization = snapshotJson({
        authorizationEnvelope,
        facts: {
          providerId,
          mode: this.mode,
          trustedScope: scope,
          operation: "cancel",
          command: authorizedCommand
        }
      }) as AuthorizationCheck;
    } catch {
      throw this.failure("cancel", "invalid_input", "not_dispatched");
    }
    let authorizationClaim: AuthorizationClaimResult;
    try {
      authorizationClaim = await this.dependencies.authorizationVerifier.verifyAndClaim(authorization);
    } catch {
      throw this.failure("cancel", "authorization_unavailable", "not_dispatched");
    }
    if (authorizationClaim !== null && typeof authorizationClaim === "object" && authorizationClaim.status === "rejected") {
      throw this.failure("cancel", "stale_authorization", "not_dispatched");
    }
    if (!validAuthorizationClaim(authorizationClaim)) {
      throw this.failure("cancel", "authorization_unavailable", "not_dispatched");
    }

    return this.execute("cancel", scope, (context) => this.adapter.cancel(command, context), {
      meteringAttempt: {
        logicalOperationId: authorizationClaim.actionId,
        billableAttemptId: authorizationClaim.claimReference,
        sourceRefs: () => [
          `authorization-claim:${authorizationClaim.claimReference}`,
          `provider-request:${command.providerRequestId}`
        ]
      }
    });
  }

  /**
   * ProductionBundle submit gate, evaluated before ANY injected port (PBR-19/PBR-23):
   * - Owner 0.9.7 cannot return an eligible state, so no non-simulated submit can be justified. This is unconditional:
   *   it does not depend on a gate, a binding state, `sandboxEnabled` or any configuration.
   * - An object that is not a genuine, frozen gate created by `createProductionBundleGate` is rejected.
   * - Once the `production_bundle` binding is accepted, a missing gate is `contract_missing`.
   * Only `submit` is affected; quote, preflight, status, shipment, cancel and discovery are untouched.
   */
  private assertSubmitBundleGate(): ProductionBundleGate | undefined {
    if (this.mode !== "simulated" || this.dependencies.transport.mode !== "simulated") {
      throw this.failure("submit", "bundle_invalid", "not_dispatched");
    }
    const gate: unknown = this.dependencies.productionBundleGate;
    if (gate === undefined) {
      if (this.bindingFor("production_bundle").state === "accepted") throw this.failure("submit", "contract_missing", "not_dispatched");
      return undefined;
    }
    if (!isGenuineProductionBundleGate(gate)) throw this.failure("submit", "bundle_invalid", "not_dispatched");
    return gate;
  }

  private async runBundleGate(
    gate: ProductionBundleGate,
    method: "checkBeforeSubmit" | "recheckBeforeDispatch",
    request: ProductionBundleGateRequest,
    sideEffectState: AttemptEffectState
  ): Promise<ProductionBundleReport> {
    let candidate: unknown;
    try {
      candidate = await gate[method](request);
    } catch {
      throw this.failure("submit", "bundle_invalid", sideEffectState);
    }
    const validated = validateGateReport(candidate, { bundleDigest: request.bundleDigest });
    if (!validated.ok || validated.report.verdict !== "integrity_passed_blocked") {
      throw this.failure("submit", "bundle_invalid", sideEffectState);
    }
    return validated.report;
  }

  /**
   * Runs immediately before EVERY transport request (including adapter retries):
   * 1. await the gate's re-resolution, bounded re-read and owner re-verification;
   * 2. await the authorization revalidation, which stays the LAST await;
   * 3. compare synchronously. No await sits between this comparison and the transport call.
   */
  private async recheckBeforeDispatch(
    gate: ProductionBundleGate | undefined,
    request: ProductionBundleGateRequest | undefined,
    prior: ProductionBundleReport | undefined,
    authorization: AuthorizationCheck,
    claim: AuthorizationClaimed,
    transportCalled: boolean
  ): Promise<void> {
    const sideEffectState: AttemptEffectState = transportCalled ? "possible" : "not_dispatched";
    let rechecked: unknown;
    if (gate !== undefined && request !== undefined) {
      try {
        rechecked = await gate.recheckBeforeDispatch(request);
      } catch {
        throw this.failure("submit", "bundle_invalid", sideEffectState);
      }
    }
    if (typeof this.dependencies.authorizationVerifier.revalidateBeforeDispatch === "function") {
      await this.revalidateAuthorizationBeforeDispatch(authorization, claim, transportCalled);
    }
    if (gate === undefined || request === undefined || prior === undefined) return;
    const validated = validateGateReport(rechecked, { bundleDigest: request.bundleDigest });
    if (!validated.ok) throw this.failure("submit", "bundle_invalid", sideEffectState);
    const report = validated.report;
    if (report.verdict !== "integrity_passed_blocked") throw this.failure("submit", classifyRecheckFailure(report), sideEffectState);
    if (
      report.setDigest !== prior.setDigest ||
      report.bundle === null || prior.bundle === null || report.bundle.hash !== prior.bundle.hash
    ) throw this.failure("submit", "bundle_changed", sideEffectState);
  }

  private async decode<T>(operation: Operation, envelope: unknown, trustedScope: TrustedScope): Promise<Decoded<T>> {
    return this.decodeAfterPrecheck<T>(operation, this.precheckDecode(operation, envelope, trustedScope));
  }

  /** The pure half of decode: no injected port is touched. Codes and precedence are unchanged from the original decode. */
  private precheckDecode(operation: Operation, envelope: unknown, trustedScope: TrustedScope): PrecheckedDecode {
    this.assertRuntimeMode(operation);
    if (
      trustedScope === null || typeof trustedScope !== "object" ||
      typeof trustedScope.tenantId !== "string" || trustedScope.tenantId.trim() === "" ||
      typeof trustedScope.projectId !== "string" || trustedScope.projectId.trim() === ""
    ) throw this.failure(operation, "scope_mismatch", "not_dispatched");
    let scopeSnapshot: TrustedScope;
    let envelopeSnapshot: unknown;
    try {
      scopeSnapshot = snapshotJson(trustedScope) as TrustedScope;
      envelopeSnapshot = snapshotJson(envelope);
    } catch {
      throw this.failure(operation, "invalid_input", "not_dispatched");
    }
    const shapes = INPUT_SHAPES[operation];
    for (const shape of uniqueShapes([...shapes, ...OUTPUT_SHAPES[operation], ...AUXILIARY_SHAPES[operation]])) {
      this.assertBindingAvailable(operation, shape);
    }
    return { shapes, scopeSnapshot, envelopeSnapshot };
  }

  /** The port half of decode: `ContractValidator.validateInbound` and receipt checks. */
  private async decodeAfterPrecheck<T>(operation: Operation, prechecked: PrecheckedDecode): Promise<Decoded<T>> {
    const { shapes, scopeSnapshot, envelopeSnapshot } = prechecked;
    let validation;
    try {
      validation = await this.dependencies.contracts.validateInbound<T>({
        operation,
        requiredShapes: shapes,
        envelope: envelopeSnapshot,
        trustedScope: scopeSnapshot
      });
    } catch {
      throw this.failure(operation, "contract_rejected", "not_dispatched");
    }
    if (!validation.ok) {
      throw this.failure(operation, validation.failure.code, "not_dispatched");
    }
    this.assertReceipts(operation, validation.receipts, shapes, scopeSnapshot);
    try {
      return {
        value: snapshotJson(validation.value) as T,
        trustedScope: scopeSnapshot
      };
    } catch {
      throw this.failure(operation, "invalid_input", "not_dispatched");
    }
  }

  private async execute<T>(
    operation: Operation,
    trustedScope: TrustedScope,
    handler: (context: AdapterCallContext) => Promise<ProviderResult<T>>,
    hooks: ExecuteHooks<T> = {}
  ): Promise<ConnectorResponse<T>> {
    this.assertRuntimeMode(operation);
    this.assertProviderSupport(operation);

    const capability = this.descriptor.operations[operation];
    const externalEffect = capability.sideEffect === "external";
    let metering: RuntimeMeteringRecorder | undefined;
    if (this.dependencies.metering !== undefined) {
      try { metering = await this.dependencies.metering(trustedScope); }
      catch {
        await this.callFailureHook(hooks, "not_dispatched");
        throw this.failure(operation, "usage_sink_unavailable", "not_dispatched");
      }
      let configuredForScope = false;
      try { configuredForScope = metering.isConfiguredFor(this.descriptor.providerId, this.mode, trustedScope); }
      catch { configuredForScope = false; }
      if (!configuredForScope) {
        await this.callFailureHook(hooks, "not_dispatched");
        throw this.failure(operation, "usage_sink_unavailable", "not_dispatched");
      }
    }
    if (externalEffect && (metering === undefined || hooks.meteringAttempt === undefined)) {
      await this.callFailureHook(hooks, "not_dispatched");
      throw this.failure(operation, "usage_sink_unavailable", "not_dispatched");
    }
    if (externalEffect && metering !== undefined) {
      try {
        const replay = await metering.replayPending();
        if (replay.pending !== 0 || replay.failures.length !== 0) {
          await this.callFailureHook(hooks, "not_dispatched");
          throw this.failure(operation, "usage_sink_unavailable", "not_dispatched");
        }
      } catch (error) {
        await this.callFailureHook(hooks, "not_dispatched");
        if (error instanceof ConnectorError) throw error;
        throw this.failure(operation, "usage_sink_unavailable", "not_dispatched");
      }
    }

    const meteringKey = hooks.meteringAttempt === undefined
      ? `runtime:${this.newReference()}`
      : `runtime:${hooks.meteringAttempt.billableAttemptId}`;
    const operationEffect: RuntimeMeteringObservation["effect"] = externalEffect
      ? capability.mayCharge ? "potentially_billable_effect" : "unknown_effect"
      : "non_billable_observation";
    const currentSourceRefs = (): readonly string[] => hooks.meteringAttempt?.sourceRefs() ?? [];
    const recordMetering = async (
      observation: RuntimeMeteringObservation,
      requireDelivery: boolean,
      sideEffectState: AttemptEffectState
    ): Promise<void> => {
      if (metering === undefined) return;
      let result;
      try { result = await metering.recordObservation(observation); }
      catch { throw this.failure(operation, "usage_sink_unavailable", sideEffectState); }
      if (requireDelivery && result.status !== "recorded") {
        throw this.failure(operation, "usage_sink_unavailable", sideEffectState);
      }
      if (!requireDelivery && result.status === "blocked") {
        throw this.failure(operation, "usage_sink_unavailable", sideEffectState);
      }
    };

    let transportCalled = false;
    let lastTransportAttemptId: string | null = null;
    let lastProviderRequestId: string | undefined;
    let finalObservationAttempted = false;
    const context: AdapterCallContext = {
      mode: this.mode,
      clock: this.dependencies.clock,
      transport: {
        mode: this.mode,
        request: async <R>(request: ProviderTransportRequest): Promise<R> => {
          this.assertRuntimeMode(operation);
          let requestSnapshot: ProviderTransportRequest;
          try {
            requestSnapshot = snapshotJson(request) as ProviderTransportRequest;
          } catch {
            throw this.failure(operation, "invalid_input", transportCalled ? "possible" : "not_dispatched");
          }
          await hooks.beforeTransport?.(transportCalled);
          this.assertRuntimeMode(operation);
          hooks.assertPreDispatch?.(transportCalled);
          const transportAttemptId = this.newReference();
          lastTransportAttemptId = transportAttemptId;
          if (metering !== undefined) {
            await recordMetering({
              operation,
              sourceEventKey: `${meteringKey}:${transportAttemptId}:dispatching`,
              ...(hooks.meteringAttempt === undefined ? {} : {
                logicalOperationId: hooks.meteringAttempt.logicalOperationId,
                billableAttemptId: hooks.meteringAttempt.billableAttemptId
              }),
              transportAttemptId,
              outcome: "dispatching",
              completeness: "partial",
              sourceRefs: currentSourceRefs(),
              ...(hooks.meteringAttempt?.quoteAmount === undefined ? {} : { quoteAmount: hooks.meteringAttempt.quoteAmount }),
              chargeAmount: { amount: null, basis: "unknown" },
              effect: operationEffect
            }, true, transportCalled ? "possible" : "not_dispatched");
          }
          // Metering validation and delivery are asynchronous boundaries, so the
          // dispatch-time authorization check runs after them. Nothing awaited
          // may sit between this hook and the transport call below.
          if (hooks.beforeDispatch !== undefined) await hooks.beforeDispatch(transportCalled);
          // Recheck mutable mode and immutable quote facts immediately before transport.
          this.assertRuntimeMode(operation);
          hooks.assertPreDispatch?.(transportCalled);
          transportCalled = true;
          return this.dependencies.transport.request<R>(requestSnapshot);
        }
      }
    };

    try {
      if (metering !== undefined) {
        if (externalEffect && hooks.meteringAttempt === undefined) {
          throw this.failure(operation, "usage_sink_unavailable", "not_dispatched");
        }
        if (!externalEffect || hooks.meteringAttempt !== undefined) {
          await recordMetering({
            operation,
            sourceEventKey: `${meteringKey}:${externalEffect ? "prepared" : "started"}`,
            ...(hooks.meteringAttempt === undefined ? {} : {
              logicalOperationId: hooks.meteringAttempt.logicalOperationId,
              billableAttemptId: hooks.meteringAttempt.billableAttemptId
            }),
            outcome: externalEffect ? "attempt_prepared" : "dispatching",
            completeness: "partial",
            sourceRefs: currentSourceRefs(),
            ...(hooks.meteringAttempt?.quoteAmount === undefined ? {} : { quoteAmount: hooks.meteringAttempt.quoteAmount }),
            chargeAmount: { amount: null, basis: "unknown" },
            effect: operationEffect
          }, true, "not_dispatched");
        }
      } else if (!externalEffect) {
        await this.recordUsage({
          operation,
          outcome: "dispatching",
          sideEffectState: "not_dispatched"
        }, trustedScope);
      }
    } catch (error) {
      await this.callFailureHook(hooks, "not_dispatched");
      if (error instanceof ConnectorError) throw error;
      throw this.failure(operation, "usage_sink_unavailable", "not_dispatched");
    }

    let successfulSideEffect = false;
    try {
      const result = await handler(context);
      if (result.status === "unsupported") {
        throw this.failure(operation, "unsupported", transportCalled ? "possible" : "not_dispatched");
      }
      successfulSideEffect = externalEffect;
      const sideEffectState = successfulSideEffect ? "confirmed" : "not_dispatched";
      await hooks.onSuccess?.(result.value, sideEffectState);
      if (result.value !== null && typeof result.value === "object" &&
          "providerRequestId" in result.value && typeof (result.value as { readonly providerRequestId?: unknown }).providerRequestId === "string") {
        lastProviderRequestId = (result.value as { readonly providerRequestId: string }).providerRequestId;
      }

      if (metering !== undefined) {
        const outcome = externalEffect ? "provider_accepted" : "observed";
        const observedQuoteAmount = hooks.meteringAttempt?.quoteAmount ?? quoteAmountFromResult(result.value);
        await recordMetering({
          operation,
          sourceEventKey: `${meteringKey}:${lastTransportAttemptId ?? "no-transport"}:${outcome}`,
          ...(hooks.meteringAttempt === undefined ? {} : {
            logicalOperationId: hooks.meteringAttempt.logicalOperationId,
            billableAttemptId: hooks.meteringAttempt.billableAttemptId
          }),
          ...(lastTransportAttemptId === null ? {} : { transportAttemptId: lastTransportAttemptId }),
          ...(lastProviderRequestId === undefined ? {} : { providerRequestId: lastProviderRequestId }),
          outcome,
          completeness: "complete",
          sourceRefs: currentSourceRefs(),
          ...(observedQuoteAmount === undefined ? {} : { quoteAmount: observedQuoteAmount }),
          chargeAmount: { amount: null, basis: "unknown" },
          effect: externalEffect ? capability.mayCharge ? "confirmed_effect" : "unknown_effect" : "non_billable_observation"
        }, false, sideEffectState);
        finalObservationAttempted = true;
      }

      const outputShapes = OUTPUT_SHAPES[operation];
      for (const shape of outputShapes) this.assertBindingAvailable(operation, shape);
      let outbound;
      try {
        outbound = await this.dependencies.contracts.validateOutbound({
          operation,
          requiredShapes: outputShapes,
          value: result.value,
          trustedScope
        });
      } catch {
        throw this.failure(operation, "contract_rejected", sideEffectState);
      }
      if (!outbound.ok) {
        throw this.failure(operation, outbound.failure.code, sideEffectState);
      }
      this.assertReceipts(operation, outbound.receipts, outputShapes, trustedScope);
      if (metering === undefined) {
        await this.recordUsageBestEffort({
          operation,
          outcome: "succeeded",
          sideEffectState
        }, trustedScope);
      }
      return {
        operation,
        mode: this.mode,
        providerId: this.descriptor.providerId,
        value: result.value,
        sharedPayload: outbound.value,
        emittedShapes: outputShapes
      };
    } catch (error) {
      const sideEffectState = this.effectState(error, operation, transportCalled, successfulSideEffect);
      await this.callFailureHook(hooks, sideEffectState);
      if (metering !== undefined && !finalObservationAttempted) {
        const outcome = externalEffect
          ? sideEffectState === "confirmed" ? "provider_accepted" : transportCalled ? "unknown" : "not_dispatched"
          : transportCalled ? "unknown" : "not_dispatched";
        try {
          await recordMetering({
            operation,
            sourceEventKey: `${meteringKey}:${lastTransportAttemptId ?? "no-transport"}:${outcome}`,
            ...(hooks.meteringAttempt === undefined ? {} : {
              logicalOperationId: hooks.meteringAttempt.logicalOperationId,
              billableAttemptId: hooks.meteringAttempt.billableAttemptId
            }),
            ...(lastTransportAttemptId === null ? {} : { transportAttemptId: lastTransportAttemptId }),
            ...(lastProviderRequestId === undefined ? {} : { providerRequestId: lastProviderRequestId }),
            outcome,
            completeness: outcome === "unknown" ? "partial" : "complete",
            sourceRefs: currentSourceRefs(),
            ...(hooks.meteringAttempt?.quoteAmount === undefined ? {} : { quoteAmount: hooks.meteringAttempt.quoteAmount }),
            chargeAmount: { amount: null, basis: "unknown" },
            effect: externalEffect
              ? sideEffectState === "confirmed" ? "confirmed_effect" : sideEffectState === "not_dispatched" ? "potentially_billable_effect" : "unknown_effect"
              : "non_billable_observation"
          }, false, sideEffectState);
        } catch { /* the durable attempt record remains authoritative when recording is unavailable */ }
      } else if (metering === undefined) {
        await this.recordUsageBestEffort({
          operation,
          outcome: "failed",
          sideEffectState
        }, trustedScope);
      }
      throw this.normalizeFailure(error, operation, sideEffectState, transportCalled);
    }
  }

  private assertRuntimeMode(operation: Operation): void {
    const runtimeMode: unknown = this.mode;
    if (runtimeMode !== "simulated" && runtimeMode !== "sandbox") {
      throw this.failure(operation, "mode_mismatch", "not_dispatched");
    }
    if (!this.descriptor.supportedModes.includes(runtimeMode) || this.dependencies.transport.mode !== runtimeMode) {
      throw this.failure(operation, "mode_mismatch", "not_dispatched");
    }
    if (this.mode === "sandbox" && !this.audit().sandboxReady) {
      throw this.failure(operation, "sandbox_disabled", "not_dispatched");
    }
  }

  private assertProviderSupport(operation: Operation): void {
    if (this.descriptor.operations[operation].supported !== true) {
      throw this.failure(operation, "unsupported", "not_dispatched");
    }
  }

  private assertBindingAvailable(operation: Operation, shape: SharedShape): void {
    const binding = this.bindingFor(shape);
    if (
      binding.shape !== shape ||
      !["missing", "development_fixture", "accepted"].includes(binding.state) ||
      binding.state === "missing" ||
      typeof binding.schemaVersion !== "string"
    ) {
      throw this.failure(operation, "contract_missing", "not_dispatched");
    }
    if (
      binding.ownerRepository !== CONTRACT_OWNERSHIP[shape].ownerRepository ||
      binding.upstreamIssue !== CONTRACT_OWNERSHIP[shape].upstreamIssue
    ) throw this.failure(operation, "contract_missing", "not_dispatched");
    if (binding.state === "development_fixture" && (typeof binding.fixtureDigest !== "string" || !binding.fixtureDigest.trim())) {
      throw this.failure(operation, "contract_missing", "not_dispatched");
    }
    if (binding.state === "accepted" && (
      typeof binding.sourceRevision !== "string" || !binding.sourceRevision.trim() ||
      typeof binding.fixtureDigest !== "string" || !binding.fixtureDigest.trim()
    )) {
      throw this.failure(operation, "contract_missing", "not_dispatched");
    }
    if (this.mode === "sandbox" && binding.state !== "accepted") {
      throw this.failure(operation, "sandbox_disabled", "not_dispatched");
    }
    if (VERSION_PATTERN.exec(binding.schemaVersion) === null) {
      throw this.failure(operation, "contract_missing", "not_dispatched");
    }
  }

  private assertReceipts(
    operation: Operation,
    receipts: readonly ContractReceipt[],
    expectedShapes: readonly SharedShape[],
    trustedScope: TrustedScope
  ): void {
    const uniqueExpected = uniqueShapes(expectedShapes);
    if (!Array.isArray(receipts) || receipts.length !== uniqueExpected.length) {
      throw this.failure(operation, "contract_rejected", "not_dispatched");
    }
    for (const shape of uniqueExpected) {
      const matching = receipts.filter((receipt) => receipt !== null && typeof receipt === "object" && receipt.shape === shape);
      if (matching.length !== 1) {
        throw this.failure(operation, "contract_rejected", "not_dispatched");
      }
      const receipt = matching[0]!;
      const binding = this.bindingFor(shape);
      if (
        typeof receipt.tenantId !== "string" || typeof receipt.projectId !== "string" ||
        receipt.tenantId !== trustedScope.tenantId || receipt.projectId !== trustedScope.projectId
      ) {
        throw this.failure(operation, "scope_mismatch", "not_dispatched");
      }
      const receiptVersion = typeof receipt.schemaVersion === "string" ? VERSION_PATTERN.exec(receipt.schemaVersion) : null;
      const bindingVersion = typeof binding.schemaVersion === "string" ? VERSION_PATTERN.exec(binding.schemaVersion) : null;
      if (receiptVersion === null || bindingVersion === null || receiptVersion[1] !== bindingVersion[1]) {
        throw this.failure(operation, "unsupported_schema_major", "not_dispatched");
      }
      if (this.mode === "sandbox" && receipt.schemaVersion !== binding.schemaVersion) {
        throw this.failure(operation, "contract_rejected", "not_dispatched");
      }
    }
  }

  private validateSubmissionCommand(command: SubmitCommand, operation: "submit"): void {
    const quote = command.quote;
    if (
      typeof command.idempotencyKey !== "string" ||
      command.idempotencyKey.trim() === "" ||
      typeof command.requestFingerprint !== "string" ||
      command.requestFingerprint.trim() === "" ||
      !Number.isSafeInteger(command.amountMinor) ||
      command.amountMinor <= 0 ||
      typeof command.currency !== "string" ||
      !this.validBudgetRequest({
        amountMinor: command.amountMinor,
        currency: command.currency,
        purpose: "fulfillment_submit"
      }) ||
      quote === null ||
      typeof quote !== "object" ||
      typeof quote.quoteId !== "string" ||
      quote.quoteId.trim() === "" ||
      typeof quote.termsFingerprint !== "string" ||
      quote.termsFingerprint.trim() === "" ||
      typeof quote.productionBundleDigest !== "string" ||
      typeof command.productionBundleDigest !== "string" ||
      command.productionBundleDigest.trim() === "" ||
      !Number.isSafeInteger(quote.totalMinor) ||
      quote.totalMinor <= 0 ||
      typeof quote.currency !== "string" ||
      !/^[A-Z]{3}$/.test(quote.currency) ||
      typeof quote.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(quote.expiresAt))
    ) {
      throw this.failure(operation, "invalid_input", "not_dispatched");
    }
    this.assertQuoteCurrent(quote);
    if (
      quote.productionBundleDigest !== command.productionBundleDigest ||
      quote.totalMinor !== command.amountMinor ||
      quote.currency !== command.currency
    ) {
      throw this.failure(operation, "invalid_input", "not_dispatched");
    }
  }

  private assertQuoteCurrent(
    quote: SubmitCommand["quote"],
    sideEffectState: AttemptEffectState = "not_dispatched"
  ): void {
    if (Date.parse(quote.expiresAt) <= this.dependencies.clock.now()) {
      throw this.failure("submit", "stale_quote", sideEffectState);
    }
  }

  /**
   * A claim is not a promise that the authority holds at dispatch. Budget,
   * persistence and metering all run between the claim and the transport, so an
   * optional verifier revalidates immediately before every transport request:
   * after the dispatching metering write, with only synchronous checks left.
   */
  private async revalidateAuthorizationBeforeDispatch(
    authorization: AuthorizationCheck,
    claim: AuthorizationClaimed,
    transportCalled: boolean
  ): Promise<void> {
    const sideEffectState: AttemptEffectState = transportCalled ? "possible" : "not_dispatched";
    const verifier = this.dependencies.authorizationVerifier;
    let result: AuthorizationDispatchResult;
    try {
      if (typeof verifier.revalidateBeforeDispatch !== "function") throw new TypeError("missing revalidation");
      result = await verifier.revalidateBeforeDispatch(authorization, Object.freeze({ ...claim }));
    } catch {
      throw this.failure("submit", "authorization_unavailable", sideEffectState);
    }
    if (result !== null && typeof result === "object" && result.status === "rejected") {
      throw this.failure("submit", "stale_authorization", sideEffectState);
    }
    if (result === null || typeof result !== "object" || result.status !== "dispatchable") {
      throw this.failure("submit", "authorization_unavailable", sideEffectState);
    }
  }

  private validQuoteResult(result: QuoteResult): boolean {
    if (
      result === null || typeof result !== "object" || !Array.isArray(result.breakdown) ||
      typeof result.providerQuoteId !== "string" ||
      result.providerQuoteId.trim() === "" ||
      !/^[A-Z]{3}$/.test(result.currency) ||
      !Number.isSafeInteger(result.totalMinor) ||
      result.totalMinor < 0 ||
      !Number.isFinite(Date.parse(result.expiresAt)) ||
      Date.parse(result.expiresAt) <= this.dependencies.clock.now()
    ) return false;
    let sum = 0;
    for (const line of result.breakdown) {
      if (
        line === null || typeof line !== "object" || typeof line.label !== "string" || line.label.trim() === "" ||
        !Number.isSafeInteger(line.amountMinor) || line.amountMinor < 0
      ) return false;
      sum += line.amountMinor;
      if (!Number.isSafeInteger(sum)) return false;
    }
    return sum === result.totalMinor;
  }

  private validateCancelCommand(command: CancelCommand): void {
    if (
      typeof command.idempotencyKey !== "string" ||
      command.idempotencyKey.trim() === "" ||
      typeof command.requestFingerprint !== "string" ||
      command.requestFingerprint.trim() === "" ||
      typeof command.providerRequestId !== "string" ||
      command.providerRequestId.trim() === "" ||
      (command.budgetRequest !== undefined && !this.validBudgetRequest(command.budgetRequest))
    ) {
      throw this.failure("cancel", "invalid_input", "not_dispatched");
    }
  }

  private validBudgetRequest(request: BudgetRequest): boolean {
    return Number.isSafeInteger(request.amountMinor) && request.amountMinor > 0 && /^[A-Z]{3}$/.test(request.currency);
  }

  private validateSubmissionDeclaration(): void {
    const capability = this.descriptor.operations.submit;
    if (
      capability.sideEffect !== "external" ||
      !capability.mayCharge ||
      capability.idempotency === "not_applicable" ||
      capability.idempotency === "unknown"
    ) {
      throw this.failure("submit", "unsupported", "not_dispatched");
    }
  }

  private contractReadiness(): ContractReadiness {
    const missingAcceptedPins = ALL_SHARED_SHAPES.flatMap((shape) => {
      const binding = this.bindingFor(shape);
      const complete =
        binding.state === "accepted" &&
        binding.ownerRepository === CONTRACT_OWNERSHIP[shape].ownerRepository &&
        binding.upstreamIssue === CONTRACT_OWNERSHIP[shape].upstreamIssue &&
        typeof binding.schemaVersion === "string" &&
        VERSION_PATTERN.exec(binding.schemaVersion) !== null &&
        typeof binding.sourceRevision === "string" && binding.sourceRevision.trim() !== "" &&
        typeof binding.fixtureDigest === "string" &&
        binding.fixtureDigest.trim() !== "";
      if (complete) return [];
      return [{
        shape,
        ownerRepository: binding.ownerRepository,
        upstreamIssue: binding.upstreamIssue,
        state: binding.state,
        ...(binding.schemaVersion === undefined ? {} : { schemaVersion: binding.schemaVersion }),
        ...(binding.sourceRevision === undefined ? {} : { sourceRevision: binding.sourceRevision }),
        ...(binding.fixtureDigest === undefined ? {} : { fixtureDigest: binding.fixtureDigest })
      }];
    });
    return { ready: missingAcceptedPins.length === 0, missingAcceptedPins };
  }

  private bindingFor(shape: SharedShape): ContractBinding {
    const owner = CONTRACT_OWNERSHIP[shape];
    try {
      const binding = this.dependencies.contracts.binding(shape);
      if (
        binding !== undefined && binding !== null && typeof binding === "object" &&
        typeof binding.state === "string" && typeof binding.ownerRepository === "string" &&
        typeof binding.upstreamIssue === "string"
      ) return binding;
    } catch {
      // Unavailable bindings use the private ownership catalog and remain fail-closed.
    }
    return {
      shape,
      ownerRepository: owner.ownerRepository,
      upstreamIssue: owner.upstreamIssue,
      state: "missing"
    };
  }

  private failure(operation: Operation, code: ConnectorErrorCode, sideEffectState: AttemptEffectState): ConnectorError {
    return new ConnectorError(
      operation,
      code,
      this.newReference(),
      sideEffectState
    );
  }

  private newReference(): string {
    this.diagnosticCounter += 1;
    const nonce = Math.random().toString(36).slice(2, 8);
    return `fc-${this.diagnosticCounter.toString().padStart(6, "0")}-${nonce}`;
  }

  private existingAttemptFailure(
    existing: SubmitAttemptRecord,
    requestFingerprint: string,
    sameIdempotencyKey: boolean
  ): ConnectorError {
    if (sameIdempotencyKey && existing.requestFingerprint !== requestFingerprint) {
      return this.failure("submit", "idempotency_conflict", existing.sideEffectState);
    }
    if (existing.sideEffectState === "confirmed") {
      return this.failure("submit", "duplicate_submission", "confirmed");
    }
    if (existing.sideEffectState === "possible" || existing.sideEffectState === "unknown") {
      return this.failure("submit", "ambiguous_submission", existing.sideEffectState);
    }
    if (["pending", "reserved", "unknown"].includes(existing.budgetReservationState)) {
      return this.failure("submit", "reservation_unresolved", existing.sideEffectState);
    }
    return this.failure("submit", "authorization_action_claimed", existing.sideEffectState);
  }

  private async saveAttempt(record: SubmitAttemptRecord): Promise<SubmitAttemptRecord> {
    try {
      await this.dependencies.persistence.saveSubmitAttempt({ ...record });
      return record;
    } catch {
      throw this.failure("submit", "persistence_unavailable", record.sideEffectState);
    }
  }

  private effectState(
    error: unknown,
    operation: Operation,
    transportCalled: boolean,
    successfulSideEffect: boolean
  ): AttemptEffectState {
    if (error instanceof ConnectorError) {
      if (error.sideEffectState === "confirmed") return "confirmed";
      if (error.sideEffectState === "unknown") return "unknown";
    }
    if (successfulSideEffect) return "confirmed";
    if (this.descriptor.operations[operation].sideEffect === "external" && transportCalled) return "possible";
    return "not_dispatched";
  }

  private normalizeFailure(
    error: unknown,
    operation: Operation,
    sideEffectState: AttemptEffectState,
    transportCalled: boolean
  ): ConnectorError {
    if (error instanceof ConnectorError) {
      return this.failure(operation, error.code, sideEffectState);
    }
    const candidate = error !== null && typeof error === "object" ? error as { name?: unknown; code?: unknown; status?: unknown } : {};
    const name = typeof candidate.name === "string" ? candidate.name : "";
    const code = typeof candidate.code === "string" ? candidate.code.toUpperCase() : "";
    const timedOut = name === "TimeoutError" || name === "AbortError" || code === "ETIMEDOUT" || code === "ECONNABORTED";
    const rateLimited = candidate.status === 429 || code === "RATE_LIMIT" || code === "RATE_LIMITED";
    const failureCode: ConnectorErrorCode =
      rateLimited ? "rate_limit" :
      timedOut ? (operation === "submit" && transportCalled ? "ambiguous_submission" : "timeout") :
      operation === "submit" && transportCalled ? "ambiguous_submission" :
      "provider_failure";
    return this.failure(operation, failureCode, sideEffectState);
  }

  private async encodeAuxiliaryPayload(
    operation: Operation,
    shape: SharedShape,
    value: unknown,
    trustedScope: TrustedScope
  ): Promise<unknown> {
    this.assertBindingAvailable(operation, shape);
    let result;
    try {
      result = await this.dependencies.contracts.validateOutbound({
        operation,
        requiredShapes: [shape],
        value,
        trustedScope
      });
    } catch {
      throw this.failure(operation, "contract_rejected", "not_dispatched");
    }
    if (!result.ok) throw this.failure(operation, result.failure.code, "not_dispatched");
    this.assertReceipts(operation, result.receipts, [shape], trustedScope);
    try {
      return snapshotJson(result.value);
    } catch {
      throw this.failure(operation, "contract_rejected", "not_dispatched");
    }
  }

  private async recordUsage(
    event: Omit<UsageEvent, "providerId" | "mode" | "recordedAt"> & { operation: Operation },
    trustedScope: TrustedScope
  ): Promise<void> {
    const contractPayload = await this.encodeAuxiliaryPayload(
      event.operation,
      "fulfillment_usage",
      {
        ...event,
        providerId: this.descriptor.providerId,
        mode: this.mode,
        recordedAt: this.dependencies.clock.now()
      },
      trustedScope
    );
    await this.dependencies.usageSink.record(contractPayload);
  }

  private async recordUsageBestEffort(
    event: Omit<UsageEvent, "providerId" | "mode" | "recordedAt"> & { operation: Operation },
    trustedScope: TrustedScope
  ): Promise<void> {
    try {
      await this.recordUsage(event, trustedScope);
    } catch {
      // The dispatching event is recorded before provider work; its failure state is persisted separately.
    }
  }

  private async callFailureHook<T>(hooks: ExecuteHooks<T>, sideEffectState: AttemptEffectState): Promise<void> {
    try {
      await hooks.onFailure?.(sideEffectState);
    } catch {
      // Keep the original typed failure. Reconciliation must inspect the persisted attempt.
    }
  }
}
