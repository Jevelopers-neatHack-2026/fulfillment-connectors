export { CONTRACT_OWNERSHIP, INPUT_SHAPES, OUTPUT_SHAPES, AUXILIARY_SHAPES, ALL_SHARED_SHAPES } from "./contracts.js";
export { ConnectorError } from "./errors.js";
export type { ConnectorErrorCode, SideEffectState } from "./errors.js";
export { FulfillmentConnectorRuntime } from "./runtime.js";
export {
  ORDER_AUTHORIZATION_ACTION,
  ORDER_AUTHORIZATION_AUDIENCE,
  ORDER_AUTHORIZATION_CONSUMER_HEADERS,
  ORDER_AUTHORIZATION_PATHS,
  ORDER_AUTHORIZATION_REJECTION_REASONS,
  ORDER_AUTHORIZATION_SCHEMA,
  OrderAuthorizationError,
  canonicalJson as orderAuthorizationCanonicalJson,
  consumerSignature as orderAuthorizationConsumerSignature,
  createConsumerRequestSigner,
  createTicketStubOrderAuthorizationVerifier,
  deriveOrderActionId,
  deriveOrderClaimKey,
  orderClaimLookupBody
} from "./order-authorization-client.js";
export type {
  ConsumerRequestSigner,
  OrderAuthorizationErrorCode,
  OrderAuthorizationHttpPort,
  OrderAuthorizationHttpRequest,
  OrderAuthorizationHttpResponse,
  TicketStubOrderAuthorizationOptions
} from "./order-authorization-client.js";
export type * from "./types.js";
export * from "./catalog.js";
export { createRuntimeMeteringResolver, FulfillmentMetering } from "./metering.js";
export type {
  AmountBasis,
  AmountEvidence,
  BillableAttemptInput,
  BudgetReservationResolver,
  DispatchIdentity,
  DispatchPort,
  DispatchResult,
  EvidenceMode,
  ExactMoney,
  MeteringDependencies,
  MeteringFailure,
  MeteringObservationInput,
  MeteringOutcome,
  MeteringResult,
  MeteringSnapshot,
  StoredAttemptSummary
} from "./metering.js";
export {
  AttemptStoreError,
  LocalAttemptPersistence,
  createLocalAttemptPersistence
} from "./attempt-store.js";
export type {
  AttemptHistory,
  LocalAttemptPersistenceOptions
} from "./attempt-store.js";
export {
  evaluateProviderPolicy,
  PRODIGI_SANDBOX_ADAPTER_ID,
  PRODIGI_SANDBOX_BASE_URL,
  PRODIGI_SANDBOX_OPERATION_ENDPOINTS,
  PRODIGI_SANDBOX_PRODUCT_READ_PATH,
  PRODIGI_SANDBOX_PRODUCT_READ_SELECTION,
  PROVIDER_ENVIRONMENT_MATRIX
} from "./provider-matrix.js";
export type {
  MatrixEvidence,
  ProviderOperationMatrixCell,
  ProviderPolicyAssessment,
  ProviderPolicyInput,
  ProviderPolicyReason,
  SandboxDecisionRequest,
  SandboxDecisionVerifier,
  SandboxRoute,
  SandboxOperation,
  VerifiedSandboxDecision
} from "./provider-matrix.js";
export * from "./security.js";
export {
  evaluatePrivateQuoteCurrent,
  executePrivateQuote,
  PRIVATE_QUOTE_FORMAT,
  QuoteExecutionError
} from "./quotes.js";
export type {
  BoundedQuotePort,
  PrivateQuoteBinding,
  PrivateQuoteResponse,
  PrivateQuoteSnapshot,
  ProviderAmountInput,
  QuoteClock,
  QuoteCurrentEvaluation,
  QuoteCurrentReason,
  QuoteDependencies,
  QuoteErrorCode,
  QuoteExecutionPolicy,
  QuoteLeadTime,
  QuoteProviderCallContext,
  QuoteProviderRequest,
  QuoteRequiredAction,
  QuoteSnapshotPersistence,
  QuoteUnknownReason,
  QuotedAmount
} from "./quotes.js";
export type { ExactMoney as PrivateQuoteExactMoney } from "./quotes.js";
export {
  fixtureStatusMapping,
  fixtureTrackingHostPolicy,
  normalizeProviderObservation,
  StatusInputError
} from "./status.js";
export type {
  NormalizedQuantityFact,
  NormalizedStatusItem,
  NormalizedStatusObservation,
  NormalizedStatusShipment,
  ObservationSource,
  ProjectedStatusState,
  ProviderStatusMapping,
  ProviderStatusObservation,
  QuantityBasis,
  QuantityFact,
  QuantityKind,
  StatusInputErrorCode,
  StatusItemFact,
  StatusShipmentFact,
  StatusState,
  TrackingHostPolicy
} from "./status.js";
export { LocalStatusStore, StatusStoreError } from "./status-store.js";
export type {
  ConflictKind,
  ConflictLocation,
  LocalStatusStoreOptions,
  PollLease,
  PollPolicy,
  PollRunResult,
  PollTaskKind,
  ProjectedItem,
  ProjectedQuantity,
  ProjectedShipment,
  StatusConflict,
  StatusCorrectionPolicy,
  StatusObservationRecord,
  StatusOutboxEvent,
  StatusOutboxLease,
  StatusProjection,
  StatusResolution,
  StatusScope,
  StatusStoreErrorCode,
  TrustedLookupRequest,
  TrustedLookupResponse,
  TrustedStatusLookup
} from "./status-store.js";
export { comparePrivateQuotes, PRIVATE_COMPARISON_FORMAT } from "./comparison.js";
export type {
  ComparisonCapabilityFit,
  ComparisonQuoteEntry,
  ComparisonQuoteReferences,
  ComparisonReason,
  PrivateQuoteComparison,
  PrivateQuoteComparisonDependencies,
  PrivateQuoteComparisonRequest
} from "./comparison.js";
export {
  decodeProdigiProductDetails,
  prodigiProductDetailsPath,
  ProdigiProductDetailsError
} from "./prodigi-product-details.js";
export type {
  ProdigiProductDetails,
  ProdigiProductDetailsErrorCode,
  ProdigiProductDimensions,
  ProdigiPrintArea,
  ProdigiPrintAreaSize,
  ProdigiProductVariant
} from "./prodigi-product-details.js";
export { inspectPngBytes, PNG_INSPECTION_LIMITS } from "./png-inspection.js";
export type {
  PngExpectationFailure,
  PngExpectationFailureCode,
  PngExpectationField,
  PngExpectationReport,
  PngInspectionCode,
  PngInspectionMetadata,
  PngInspectionResult,
  PngInspectionStatus,
  PngObservedContentType,
  PngObservedFormat,
  PngPhysicalResolution
} from "./png-inspection.js";
export {
  createEnvServerSecretSource,
  PRODIGI_SANDBOX_SECRET_BINDING,
  SecretResolverError
} from "./prodigi-secrets.js";
export type {
  CredentialClass,
  EnvSecretSourceOptions,
  SecretReferenceBinding,
  SecretResolverErrorCode
} from "./prodigi-secrets.js";
export {
  createFetchProdigiHttpPort,
  createOneShotProdigiProductReadPort,
  createProdigiProductReadFetchPort,
  createProdigiQuotePort,
  isVerifiedSandboxProductReadGrant,
  mapOrderRequest,
  mapQuoteRequest,
  PRODIGI_SANDBOX_ORIGIN,
  PRODIGI_SANDBOX_PRODUCT_READ_URL,
  ProdigiSandboxClient,
  ProdigiSandboxError,
  projectOrderResponse,
  projectProductReadObservation,
  projectQuoteResponse,
  toProdigiShippingMethod,
  toStatusResult
} from "./prodigi-sandbox.js";
export type {
  ProdigiHttpPort,
  ProdigiHttpRequest,
  ProdigiHttpResponse,
  ProdigiOrderCreateInput,
  ProdigiOrderItemInput,
  ProdigiOrderObservation,
  ProdigiOrderRecipientInput,
  ProdigiOrderStage,
  ProdigiProductReadObservation,
  ProdigiProductReadReferences,
  ProdigiProductReadTransportSnapshot,
  ProdigiProviderQuote,
  ProdigiQuoteMappingConfig,
  ProdigiQuoteShippingMethod,
  ProdigiSandboxClientOptions,
  ProdigiSandboxDecision,
  ProdigiSandboxErrorCode,
  ProdigiShippingMethod,
  ProdigiSideEffectState,
  ProdigiSizing,
  ProdigiStepState,
  SandboxProductReadGrantRequest,
  SandboxProductReadGrantVerifier,
  VerifiedSandboxProductReadGrant
} from "./prodigi-sandbox.js";
export {
  createInMemoryProdigiReconciliationStore,
  createProdigiReadLimiter,
  decideProdigiOrdering,
  isProdigiOrderCallbackType,
  PRODIGI_CALLBACK_EVENT_TYPES,
  PRODIGI_ORDER_CALLBACK_TYPE_PREFIX,
  PRODIGI_SANDBOX_CALLBACK_SOURCE,
  parseProdigiCallbackEvent,
  ProdigiCallbackError,
  ProdigiCallbackReconciler
} from "./prodigi-callbacks.js";
export type {
  ProdigiCallbackErrorCode,
  ProdigiCallbackHint,
  ProdigiCallbackOutcome,
  ProdigiCallbackReconcilerOptions,
  ProdigiCallbackResult,
  InMemoryProdigiReconciliationStore,
  ProdigiOrderingDecision,
  ProdigiOrderReader,
  ProdigiPollPolicy,
  ProdigiAbandonReason,
  ProdigiJobRetryPolicy,
  ProdigiPendingReconciliation,
  ProdigiReconcileAbandonedEvent,
  ProdigiReadLimiter,
  ProdigiReconcileErrorCode,
  ProdigiReconcileJob,
  ProdigiReconcileResult,
  ProdigiReconcileStatus,
  ProdigiReconciliationScheduler,
  ProdigiScheduledRunResult,
  ProdigiScheduledRunStatus,
  ProdigiReconciledOrderState,
  ProdigiReconciliationStore
} from "./prodigi-callbacks.js";

// FC-08: owner-free ProductionBundle contract types (ports, report, criteria, evidence). The values and the implementation, which
// imports the owner package, are available only from "@jevelopers/fulfillment-connectors/production-bundle".
export type {
  ByteReadRequest,
  ByteReadResult,
  CriterionId,
  CriterionResult,
  CriterionState,
  ProductionBundleAnchorProvenance,
  ProductionBundleByteSource,
  ProductionBundleEvidence,
  ProductionBundleGate,
  ProductionBundleGateRequest,
  ProductionBundlePublicationSource,
  ProductionBundleReport,
  ProductionBundleVerdict,
  PublicationRequest,
  PublicationResult
} from "./production-bundle-contract.js";
