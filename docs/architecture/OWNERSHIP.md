# fulfillment-connectors ownership and implementation boundary

**Repository status:** Public on GitHub; verified October 12, 2026.
**Proposed owner:** Creative and fulfillment.
**Implementation state:** A private Node.js 24.21.0 package implements an injected worker-runtime foundation, simulator, local bundle and authorization consumers, and a separately fixture-tested Prodigi v4 sandbox adapter. No provider account has been tested, no live mode is supported, and external schema, issuer and finance acceptance remain pending.

## Responsibility

Normalize print-provider capabilities, quotes, order submission, and delivery status. Own supplier adapter validation, external submission attempts, provider request identifiers, and external status normalization.

getticketstub.com owns verified customer authorization and the customer order lifecycle. The harness coordinates work. This repository checks submission prerequisites and reports external outcomes without creating a competing commercial state machine.

## Current implementation surface

The package exports its typed runtime at the root and a ProductionBundle consumer subpath. FulfillmentConnectorRuntime receives injected provider, contract-validation, transport, clock, attempt-persistence, authorization-verification, budget-authorization and usage-recording ports. Simulated is the default; sandbox requires exact owner evidence and accepted pins; liveModeSupported is always false. Attempt-store restart tests use in-memory fixtures, not a production durable store.

Catalog, quote normalization, comparison, status observations, security policy, metering, simulator, bundle inspection and simulated order-authorization consumer have offline tests. The separate Prodigi v4 sandbox adapter has fixture coverage for quote, order creation and retrieval. The provider matrix records accountTested as false. No provider request has been sent. No SKU, credential, callback-authentication result or local pass makes the sandbox ready.

The TicketStub-shaped order-authorization consumer is source-tested only with a fake issuer/HTTP port and pinned producer fixtures. It is development-only, accepts simulated connector mode, and is not run against the app server. This is not runtime adoption, accepted shared-contract mapping, conformance or acceptance.

## Integration targets and handoff

getticketstub.com owns authorization, customer lifecycle, product selection and financial authority. Print-production owns the artifact; cost-intelligence owns usage intake and accounting. Shared definitions, accepted source revisions and matching producer/consumer evidence are prerequisites for integration.

Offline suites do not contact providers. The one-command authenticated Prodigi smoke procedure in the [Prodigi sandbox guide](../prodigi-sandbox.md) sends one provider request and is owner-gated; do not run it without the separate approval and evidence specified there. See [runtime](../runtime.md), [provider matrix](../provider-matrix.md), [order authorization](../order-authorization.md), and [key management](../key-management.md) for interfaces and gates.

## P0 target slice

Design intent: obtain one provider sandbox quote and submit one explicitly authorized sandbox order when suitable sandbox and accepted prerequisites exist. Use the simulator for deterministic failure/recovery evidence. No current sandbox or live operation is claimed.

## Acceptance boundary

- [ ] Submission binds the approved artifact, quote terms, and authorization.
- [ ] Repeated delivery of the same command cannot create duplicate orders.
- [ ] Uncertain external outcomes remain visible until resolved.
- [ ] Provider status events are validated and deduplicated.
- [ ] Sandbox and live operations remain distinguishable in reporting.
- [ ] Charges retain their original currency and confirmation status.

The canonical current-state architecture describes implementation across repositories. The historical v1.0 architecture kit remains design intent: [current organization architecture](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/blob/main/docs/architecture/CURRENT-STATE.md) · [v1.0 design intent](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/blob/main/docs/architecture-kit/v1.0/docs/architecture.md).

Use the [repository acceptance view](ACCEPTANCE.md) for criterion allocation only. Current criteria and evidence live in the [master checklist](https://github.com/Jevelopers-neatHack-2026/integration-evals/blob/main/planning/acceptance-checklist.md) and [JSON tracker](https://github.com/Jevelopers-neatHack-2026/integration-evals/blob/main/planning/acceptance-checklist.json). See the [central implementation plan](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/blob/main/docs/planning/implementation-plan.md), [contract catalog](https://github.com/Jevelopers-neatHack-2026/shared-contracts/blob/main/docs/contract-catalog.md) and [organization contribution guidance](https://github.com/Jevelopers-neatHack-2026/.github/blob/main/CONTRIBUTING.md). Named owner and reviewer assignments remain kickoff decisions.

For a guide-by-topic list, see the [documentation index](../INDEX.md).
