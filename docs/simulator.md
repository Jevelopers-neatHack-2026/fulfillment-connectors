# Deterministic offline simulator

`src/simulator.ts` provides a provider-shaped local fixture for runtime development and repeatable failure tests. It supports only `simulated` mode. It has no supplier endpoint, network client, credential input, or environment-variable lookup. Its transport accepts a small set of fixed local route strings and mutates an in-memory state object that can be saved as JSON and restored after a restart.

The simulator is not a selected supplier adapter, sandbox receipt, authorization issuer, production-bundle validator, or finance ledger. Its private fixtures use `development_fixture` bindings with an explicit synthetic digest. `runtime.audit()` therefore continues to report missing accepted contract pins, `sandboxReady: false`, and `liveModeSupported: false`. Nothing produced by this module counts as upstream contract acceptance, sandbox evidence, a real budget reservation, a purchase, revenue, or a charge.

## Run the local suite

With the pinned Node 24.21.0 and npm 11.19.0 toolchain and locked dependencies installed:

```sh
npm run build
npm run verify:mock
```

`npm run verify:mock` writes machine-readable local evidence under `evidence/FC-02-MOCK`. The suite uses the real `FulfillmentConnectorRuntime` and `createRuntimeMeteringResolver`; the resolver opens the repository's `FulfillmentMetering` against an isolated temporary `DurableJsonStore` and reopens it to test pending outbox replay after a simulated restart. A pre-dispatch sink failure leaves the simulator untouched, and a post-dispatch sink failure can be recovered without submitting a second order.

A ProductionBundle reference object (`contract: "ProductionBundle"`, `schema_version: "2.0.0"`, `id`, `revision`, an exact `sha256:` `content_hash`) passed as the quote or preflight `productionBundle` digests to its owner `content_hash`, so the simulated quote, the submit body and the authorization facts carry the owner bundle hash (FC-08). This applies only in simulated mode; every other value keeps its existing fixture digest. The contract validator, authorization verifier, `AttemptPersistence`, budget client, and usage sink remain synthetic development fixtures. The simulator itself does not use the development-only TicketStub order-authorization consumer in [docs/order-authorization.md](order-authorization.md), which is exercised separately by `npm run verify:order-authorization` against a fake issuer. Only the local metering implementation and JSON outbox are exercised; runtime attempt persistence and finance/authorization authority are not replaced by that store. Nothing changes the canonical schema catalog or represents these private ports as accepted production integrations. Simulator/provider fixture state and the runtime test store are JSON serializable; restart cases copy those fixtures through JSON before creating another runtime and simulator instance.

The simulator's local provider facts use `billing_mode: simulated`; no charge is recorded and the test does not authorize or reserve real funds. Test values and IDs are synthetic, and generated metering IDs are not used as provider or finance receipts.

The suite guards `globalThis.fetch`, checks the simulator source for HTTP, DNS, socket, TLS, `fetch`, and environment access, and verifies that no fetch call occurs. It was also run on macOS under `sandbox-exec` with the `network*` rule denied, which denies network operations for that process tree:

```sh
/usr/bin/sandbox-exec -p '(version 1) (allow default) (deny network*)' \
  /usr/bin/env -i PATH=/opt/homebrew/bin:/usr/bin:/bin \
  /opt/homebrew/bin/npm run verify:mock
```

The executable paths may need adjustment on another host. `env -i` explicitly supplies only `PATH`; macOS may add its native `__CF_USER_TEXT_ENCODING` variable when launching Node. No credentials are supplied or read, and the simulator accepts only a synthetic seed and fixed start time. This is process-scoped sandbox evidence, not a machine-wide packet-capture claim.

## Determinism and synthetic quote terms

Create a new simulator with a non-secret test seed and a fixed ISO timestamp, or restore a snapshot returned by `snapshot()`:

```js
const simulator = createDeterministicSimulator({
  seed: "fixture-seed-v1",
  startAt: "2026-10-10T14:00:00.000Z"
});
const saved = JSON.parse(JSON.stringify(simulator.snapshot()));
const restarted = createDeterministicSimulator({ snapshot: saved });
```

The clock is synthetic and advances only through `advanceTime()`. Synthetic quote and order identities derive from the seed and normalized fixture terms. The quote uses a fixed local price table: 1,200 USD minor units per item, 300 minor units shipping, and a simulated 10% tax on production, rounded to the nearest minor unit. Those figures only make deterministic tests possible; they do not describe any provider price, tax obligation, shipping charge, or quote policy.

The simulator hashes the production bundle and print-specification inputs for comparison, but does not store their original contents. It omits the destination and authorization envelope from provider requests and simulator state. Submit requests carry only local quote terms, the bundle digest, amount/currency, an opaque request fingerprint and the provider idempotency key. The test verifies a synthetic address is absent from provider snapshots and usage events. Do not use real customer material in fixtures.

Quote terms expire according to the stored synthetic clock. The default quote lifetime is one hour. Provider idempotency records have a local 30-day lifetime by default; tests can set shorter intervals and advance the clock. At the provider transport boundary, reusing an active key with the same normalized request returns its original synthetic order even after the quote expires. Reusing it with different terms fails with a provider-style conflict. A stale quote with a fresh or expired key cannot create a new order. The connector runtime keeps conservative quote-expiry validation before dispatch and may reject an expired retry before it reaches provider replay; previously persisted accepted runtime results remain governed by the runtime's own replay path. After the simulator's configured key expiry, the fixture permits a new synthetic order generation when the quote remains fresh. This is a deliberate local fault model, not a statement about a real supplier's retention policy.

Restoration accepts only the exact `fc-mock-development/2` snapshot shape. Before constructing a usable transport, it validates nested records, deterministic synthetic identifiers, record references, and the relationships among accepted orders, retained submit generations, current replay indexes, retained cancellation results, effective cancellation events, applied callbacks, authoritative order status/timestamps, dispatch counters, and simulated uncharged billing evidence. Every accepted order must have exactly one retained submit generation and one current key-index entry per key; generations are derived from retained history and expired generations remain in the snapshot. The current submit index must match the latest retained generation, and a new generation is allowed when the prior expiry equals the current synthetic time.

Effective cancellations have durable event facts and retained result generations, even after a cancel key expires or is reused. The stored order status and `statusOccurredAt` must match the accepted baseline plus applied status/shipment callbacks and cancellation events. Queued callbacks do not affect those fields until delivered. The fixture checks minimum counter consistency (including one submit dispatch per accepted order and replay, one quote dispatch per retained quote, and cancel dispatch evidence for retained cancel results); those counters are consistency checks, not an authenticated audit log.

Retained cancellation outcomes are checked against the order's acceptance time at the time of the result. A `not_found` observation remains valid if the same deterministic order ID is accepted later; it is rejected only when the retained acceptance is strictly earlier than that observation. Timestamps have millisecond precision and the fixture stores no within-tick sequence, so equal timestamps remain valid when either operation order is possible. A positive cancellation outcome requires acceptance no later than its observation. Replaying an unexpired cancellation key returns its original result even after later order creation; after expiry, reuse records a new generation without rewriting the earlier result.

Version 1 snapshots are rejected with a recreate instruction. That private development format did not retain expired submit generations or effective cancellation facts, so an automatic migration could guess at missing history. Recreate old test fixtures from the deterministic seed and clock rather than resetting or rewriting their history. This is not a customer-data migration and `fc-mock-development/2` is not an accepted shared persistence schema. Invalid or inconsistent JSON state fails closed before the provider transport can be used; JSON round trips of valid v2 snapshots are supported.

Accepted simulator orders append an evidence record with `billingMode: "simulated"` and `charged: false`. Runtime budget and usage ports in `tests/mock-fixtures.mjs` are synthetic. Runtime observations are written through the actual private metering outbox to a temporary local JSON store; its fixture `UsageSink` is not a finance intake or ledger. A reserved or uncertain test record does not authorize, reserve, or charge real funds.

## Operations and fault controls

The runtime exercises capability discovery, quote, preflight, submit, status, shipment observation, and cancellation. Quote, preflight, status, shipment, submit, and cancel dispatch only to the simulator's local transport. `validateBeforeSubmit` checks the local quote record and does not dispatch. Capability discovery reports the adapter descriptor without a transport call.

Pass one-shot faults to a new simulator. Faults are part of the serializable state and are removed when triggered. The six general fault kinds below are supported for quote, preflight, submit, status, shipment, and cancel. `unknown_status` is supported only for status. Capability discovery returns the adapter descriptor without crossing a local adapter or transport boundary, so fault plans targeting `discover_capabilities` are rejected during construction instead of remaining unused.

| Fault | Behavior | Expected evidence |
| --- | --- | --- |
| `refuse_before_dispatch` | Adapter rejects before its transport call | Provider dispatch count remains zero; submit remains `not_dispatched` |
| `unsupported` | Adapter reports an unsupported result before transport | Runtime returns `unsupported`; dispatch count remains zero |
| `rate_limit` | Local transport returns a 429-shaped failure before changing provider state | One dispatch, no new order; submit remains conservatively `possible` in the runtime |
| `accepted_then_timeout` | Local operation effects occur, then the transport loses the response; submit persists one accepted order and uncharged evidence | Submit stays ambiguous and the runtime blocks retry; cancellation keeps its persisted idempotent result |
| `crash_after_acceptance` | Simulator invokes the crash barrier after computing the local operation response and before returning it; submit has already persisted the order | For submit, the test captures provider plus runtime durable snapshots at that boundary, then restarts from them; the attempt is still `unknown`, status lookup can reconcile it, and a new key cannot dispatch again |
| `malformed_response` | Simulator performs the operation and supplies an invalid response shape | Submit stays ambiguous if an order was accepted; malformed output is not treated as success |
| `unknown_status` | Status lookup returns an explicit unknown observation | Unknown remains unknown; it is not promoted to accepted or completed |

The crash test models the durable boundary with an in-process snapshot callback rather than killing the operating system process. It resumes from the captured snapshot taken before runtime error handling can update the attempt. This verifies restart behavior at the relevant persistence boundary without claiming process-kill testing.

Callbacks can be queued with an optional delivery delay and delivered in any order. Re-delivery of one event ID is deduplicated. Status observations use a deterministic precedence: delivered, failed, cancelled, shipped, in production, accepted, then pending. Thus delivered wins conflicts with cancelled and failed wins conflicts with cancelled regardless of arrival order. `statusOccurredAt` is the maximum timestamp among applied authoritative status and shipment observations, so older callbacks do not rewind it. A synthetic shipment identity cannot be queued with conflicting details; duplicate observations are deduplicated, and split shipments are sorted by their synthetic identity. The current runtime `ShipmentResult` is singular; `simulator.shipments(providerRequestId)` exposes all local split-shipment records for tests.

## Scope limits

The private preflight fixture only checks that the local inputs can be hashed as JSON. It does not verify rights, dimensions, file formats, accepted production specifications, or unchanged approved bytes. Use the separately owned offline validator for those checks. The local simulator also does not authenticate real callbacks, contact a provider for reconciliation, publish finance observations, create authorizations, or make a sandbox call. Those gates remain pending until their owning contracts and implementations are verified.
