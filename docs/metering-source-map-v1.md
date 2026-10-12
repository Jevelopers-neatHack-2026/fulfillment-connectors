# FC-10 producer source-fact map, version 1

**Status: producer proposal pending owner review. This is a pinned inventory and mapping request, not a new canonical schema, a wire adapter, or Finance acceptance.**

This answers the [Finance dependency request on FC-10](https://github.com/Jevelopers-neatHack-2026/fulfillment-connectors/issues/6#issuecomment-6111503586). The companion [machine-readable inventory](metering-source-map-v1.json) records existing fields and absent prerequisites without inventing missing values. No runtime or durable-state format changes are made.

## Source and scope

Inspected producer revision: `a1c04e6424626475c7c6db3d397cc6e3392c1600`.

- [Metering implementation](https://github.com/Jevelopers-neatHack-2026/fulfillment-connectors/blob/a1c04e6424626475c7c6db3d397cc6e3392c1600/src/metering.ts), Git blob `f8549dd5ebffa04118c8b7a7a2ee540fef30f4d5`: `observationCandidate`, `newEvent`, persisted outbox and delivery/recovery handling.
- [Metering ownership and recovery documentation](https://github.com/Jevelopers-neatHack-2026/fulfillment-connectors/blob/a1c04e6424626475c7c6db3d397cc6e3392c1600/docs/metering.md).
- [Existing producer tests](https://github.com/Jevelopers-neatHack-2026/fulfillment-connectors/blob/a1c04e6424626475c7c6db3d397cc6e3392c1600/tests/metering-suite.mjs). Their development fixtures are not an executed Finance consumer row.

The source pin identifies what was inspected. It is **not** evidence of the revision deployed by a host, an authenticated build, or the source revision of a supplier observation. Accepted canonical schema/package pins and a real consumer receipt must be recorded separately. No claim about the absence of newer upstream implementations is made here.

## Identity mapping and the source-event gap

| Role | Current producer field | Preservation / limitation |
| --- | --- | --- |
| Producer event | Outbox `eventId`; candidate `event_id` | Generated once and persisted. Re-delivery preserves this identity; it is not a provider execution. |
| Producer observation | Outbox `observationId`; candidate `observation_id` | Preserve separately from operation and attempt identities. |
| Original source event | Outbox `sourceEventKey` | Present as supplied or null **only in the private outbox**; absent from `observationCandidate`. Never recover it by guessing from `event_id`. |
| Logical operation | Candidate `logical_operation_id` | Groups related work, not a universal retry or accounting deduplication key. |
| Billable attempt | Candidate `billable_attempt_id`; associated outbox `attemptId` where applicable | Distinct attempts remain distinct; the ID does not prove a charge occurred. |
| Transport attempt | Candidate `transport_attempt_id` | Preserve supplied identity. A general producer token must not be silently cast to a canonical UUID. |
| Provider request | Candidate `provider_request_id` | Supplier-boundary fact when available; not a substitute for provider execution identity. |
| Provider execution | No candidate `provider_attempt_id` | Remains unavailable when absent. Do not generate it from another ID or collapse executions. |
| Reservation request | Candidate `reservation_request_id` | Correlation only. Does not itself prove a hold, grant, settlement or release. |

**Producer proposal for owner review:** preserve source-event identity alongside the unchanged candidate, correlated using the persisted `eventId`/`event_id` pair, rather than reconstructing identity from an opaque token. A consumer that receives only the current candidate cannot recover `sourceEventKey`. The exact approved carrier (canonical field, authenticated sidecar or accepted adapter input), null semantics, trust binding and compatibility behavior remain decisions for the shared-contracts and Finance owners. This document does not implement or authorize any of those carriers.

Do not mutate previously persisted canonical envelopes to retrofit the proposal. Lost-ACK/restart replay must retain its original identity and payload. A future migration must explicitly cover legacy outbox records, already-delivered envelopes, changed-payload conflicts and supported schema versions.

## Source facts versus missing authority

`observed_at` and `occurred_at` are separate source timestamps; retain their distinction. They are not signatures or build timestamps. Keep `mode`, `billing_mode` and `evidence_mode` independent. A sandbox label does not establish real account evidence or authorize an accounting effect.

Preserve `provider_id`, `operation`, `outcome`, `completeness`, `duration_ms`, `source_refs`, `quote_amount`, `charge_amount` and `effect` as source facts. A source reference is not authenticated evidence, an action grant, an order approval or proof that an amount was incurred. The private outbox `fingerprint` is not an accepted canonical content hash. An accepted content hash needs the owner's agreed bytes, canonicalization, algorithm, authenticated evidence binding and conflict policy; do not relabel a local fingerprint.

Trusted host context must independently establish environment, actor, tenant/project and applicable current action grants. Merely copying candidate `trusted_scope` does not authenticate the sender. A documented source pin does not establish deployed producer/build provenance. Finance owns verification of the transport/signature and content-addressed source evidence it accepts.

## Amounts and event families

Keep exact decimal text, scaled integer representation and its explicit scale, or unscaled source minor-unit integers in their original representation with currency and basis. Unknown is not zero. An absent minor-unit exponent must not be inferred by this producer mapping. Preserve quote evidence separately from actual charge evidence; an accepted order, reservation, quote, elapsed duration or shipment status alone is not incurred expense.

Missing model identifiers, billable units, provider execution IDs and original-charge linkage remain missing or unknown. In particular, do not turn measured duration into a made-up quantity of billable model usage or fabricate a charge/refund identity. Source-supported refunds require the accepted original-charge linkage.

[Shared-contracts #11](https://github.com/Jevelopers-neatHack-2026/shared-contracts/issues/11) owns accepted event families, identity/attempt semantics and usage unknown-value behavior. [Shared-contracts #12](https://github.com/Jevelopers-neatHack-2026/shared-contracts/issues/12) owns the reservation shape separately. The current private `fulfillment_usage` / `budget_reservation` validation boundary is not proof that its payload is an accepted `UsageEvent`, FinancialEvent or Finance request. Unsupported mappings must fail closed rather than bypassing validation.

## Owner handoff and required consumer evidence

The [fulfillment row in cost-intelligence #15](https://github.com/Jevelopers-neatHack-2026/cost-intelligence/issues/15) can progress independently of other producer rows, once its own prerequisites are present. The required deliverables are:

| Accountable role | Exact next deliverable |
| --- | --- |
| Creative and fulfillment, FC-10 #6 | Review this source inventory; supply sanitized immutable source fixtures, source/build pins, source-event identity and timestamp provenance without fabricated fields. |
| Shared-contracts maintainer with producer and consumer owners, #11/#12 | Agree event-family/version, identity representation, missing-value behavior, source-event carrier, content-hash/evidence binding and migration at exact canonical pins. |
| Finance and reliability, cost-intelligence #15 (with scoped #10/#12/#13 interfaces) | Implement the accepted row adapter; execute real intake, reservation and uncertainty/recovery checks; return the actual consumer revision, fixture digest, commands, outcomes and acknowledgement. |
| Product and frontend/application owner, getticketstub.com #16 | Supply applicable trusted context and exact-command authority. Customer order authorization does not substitute for Finance intake authorization. |

Required row checks include valid/invalid input, same-event re-delivery, changed payload under a reused identity, distinct attempts under one operation, lost ACK and restart, uncertain outcomes without implicit hold release, missing identities, unsupported schema mapping, exact money/unknowns, quote-only non-expense, independent modes, and authenticated actor/scope/action-grant negatives.

These are **required checks, not results**. The existing producer suite and any synthetic examples do not establish real gateway conformance, provider acceptance or consumer approval. Retain prior failed results when later fixes are verified.

## Privacy, acceptance and compatibility

Do not publish private snapshots, shipping data, signed URLs, secrets, opaque production correlation values or unredacted provider receipts. Public examples must be explicitly synthetic. Schema-valid data still needs an appropriate privacy/trust review.

This documentation-only mapping makes no runtime/API/storage changes, does not select a canonical version, and does not create new financial authority. Review acceptance of the inventory is distinct from later implementation and executed consumer conformance. FC-10 #6, release gate #16 and epic #1 remain open until their complete scoped criteria and accountable acceptance are recorded. No sandbox/live/provider/paid action is authorized or evidenced by this handoff.
