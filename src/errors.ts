import type { Operation } from "./types.js";

export type ConnectorErrorCode =
  | "invalid_input"
  | "unsupported"
  | "stale_quote"
  | "stale_authorization"
  | "rate_limit"
  | "timeout"
  | "ambiguous_submission"
  | "duplicate_submission"
  | "scope_mismatch"
  | "unsupported_schema_major"
  | "contract_missing"
  | "contract_rejected"
  | "authorization_rejected"
  | "authorization_unavailable"
  | "authorization_action_claimed"
  | "budget_denied"
  | "budget_unavailable"
  | "reservation_unresolved"
  | "persistence_unavailable"
  | "usage_sink_unavailable"
  | "provider_failure"
  | "idempotency_conflict"
  | "sandbox_disabled"
  | "mode_mismatch"
  | "bundle_invalid"
  | "bundle_changed";

export type SideEffectState = "not_dispatched" | "possible" | "confirmed" | "unknown";

const SAFE_MESSAGES: Readonly<Record<ConnectorErrorCode, string>> = {
  invalid_input: "The operation input did not pass validation.",
  unsupported: "The provider does not support this operation.",
  stale_quote: "The quote is stale or no longer valid.",
  stale_authorization: "The authorization is stale or does not cover this operation.",
  rate_limit: "The provider rate limit prevented this operation.",
  timeout: "The provider request timed out.",
  ambiguous_submission: "The external submission outcome is ambiguous and needs reconciliation.",
  duplicate_submission: "An external submission already exists for this idempotency key.",
  scope_mismatch: "The validated tenant or project does not match the trusted scope.",
  unsupported_schema_major: "The contract schema major version is not supported.",
  contract_missing: "An accepted contract binding is required for this operation.",
  contract_rejected: "The shared contract boundary rejected this operation.",
  authorization_rejected: "The supplied authorization did not authorize this operation.",
  authorization_unavailable: "The configured authorization verifier is unavailable.",
  authorization_action_claimed: "The authorized action was already claimed and cannot be replayed.",
  budget_denied: "The configured budget client denied this operation.",
  budget_unavailable: "The configured budget client is unavailable.",
  reservation_unresolved: "A prior budget reservation needs external disposition before another attempt.",
  persistence_unavailable: "The configured persistence port is unavailable.",
  usage_sink_unavailable: "The configured usage sink is unavailable.",
  provider_failure: "The provider operation failed.",
  idempotency_conflict: "The idempotency key is already bound to a different request.",
  sandbox_disabled: "Sandbox mode is disabled or lacks required release prerequisites.",
  mode_mismatch: "The provider adapter and transport mode do not match the runtime mode.",
  bundle_invalid: "The production bundle did not pass validation.",
  bundle_changed: "The production bundle changed before dispatch."
};

const RETRYABLE_CODES: ReadonlySet<ConnectorErrorCode> = new Set([
  "rate_limit",
  "timeout",
  "ambiguous_submission"
]);

export class ConnectorError extends Error {
  readonly module = "fulfillment-connectors";
  readonly safeMessage: string;
  readonly retryable: boolean;

  constructor(
    readonly operation: Operation,
    readonly code: ConnectorErrorCode,
    readonly diagnosticReference: string,
    readonly sideEffectState: SideEffectState,
    retryable = RETRYABLE_CODES.has(code)
  ) {
    super(SAFE_MESSAGES[code]);
    this.name = "ConnectorError";
    this.safeMessage = SAFE_MESSAGES[code];
    this.retryable = retryable;
  }

  toJSON(): {
    module: string;
    operation: Operation;
    code: ConnectorErrorCode;
    safeMessage: string;
    diagnosticReference: string;
    retryable: boolean;
    side_effect_state: SideEffectState;
  } {
    return {
      module: this.module,
      operation: this.operation,
      code: this.code,
      safeMessage: this.safeMessage,
      diagnosticReference: this.diagnosticReference,
      retryable: this.retryable,
      side_effect_state: this.sideEffectState
    };
  }
}
