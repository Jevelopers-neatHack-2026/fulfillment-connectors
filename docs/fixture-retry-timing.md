# Private fixture retry timing (FC06-AS-010)

Refs [issue #11's retained advisory](https://github.com/Jevelopers-neatHack-2026/fulfillment-connectors/issues/11#issuecomment-6106431472).
This is the P3 test-helper follow-up beneath FC-06, not completion of FC-06.1–4,
FUL-03, a sandbox journey or a release gate. Production retry/claim/storage policy
and all external authorization boundaries are unchanged.

`tests/fixture-claim-retry.mjs` owns the pure helper and diagnostic validator.
`tests/attempt-store-fixtures.mjs` re-exports the same two names so existing
in-process tests and real child-process fixtures use the repaired implementation.
No compiled runtime or provider is required for the focused timing controls.

## Timing contract

Every clock sample must be a finite nonnegative number and may not move backwards.
Equal samples are valid. Offsets, cutoff comparisons, remaining delay and recorded
elapsed values use raw numbers, not three-decimal rounded values. Both the decision
and actual outer-attempt start must precede the cutoff. A claim already started
before that boundary may finish after it; this is not an operation-completion timeout.
Only `storage_busy` is retried, through the same supplied claim closure. The existing
negative-control hook may deliberately violate the cutoff so the checker can reject it.

A bad clock invalidates the fixture with `fixture_clock_invalid` and no subsequent
claim. A fault after a claim does not establish that the claim had no effects; do not
reinterpret the rejected test run as `not_dispatched` or as permission to retry.
The caller's real child-process timeout remains the outer bound for hung claims or
an injected clock that never advances. This helper is not a production scheduler.

The diagnostic checker validates nonnegative decision/start/completion/stop/elapsed
chronology, ordering between attempts, exact elapsed consistency, ordinals and counts,
result/error exclusivity, and the final stop reason. New elapsed fields are calculated
from the recorded raw offsets and survive a JSON round-trip. Historical rounded
receipts remain historical evidence; do not rewrite them or describe them as having
passed this stricter raw-timing checker.

## Verification

```sh
npm run test:fixture-retry
npm run test:attempt-store
npm test
npm run verify:attempt-store
```

The first command runs dependency-free synthetic timing/claim tests. The next two
also run those controls before the existing attempt or full suite, respectively.
The verifier still exercises the real attempt fixtures and re-exported helpers.
The pinned repository toolchain remains Node 24.21.0 / npm 11.19.0; it is not relaxed.

Local focused execution used available Node 22.16.0 / npm 10.9.2, not the repository
pin. The original two functions were extracted unchanged from Git-blob-verified
`tests/attempt-store-fixtures.mjs` at main
`a1c04e6424626475c7c6db3d397cc6e3392c1600`, then executed against the same regression
suite in an isolated module. The final baseline failed 31 of 43 cases; the repair
passed all 43 with no failures, cancellations, skips or todos. Earlier 41-case runs
are retained separately. See the [local receipt](evidence/fc06-as010-local.json)
for source/output hashes, actual commands and limitations. This is focused helper
execution, not a full local checkout, build or durable-store integration run.

Pinned full build, the existing negative/recovery/consumer suites, all verifier
commands, exact-PR independent review and postmerge verification remain separate
requirements. None of the synthetic tests contacts a provider, grants an action,
creates an order, or supplies a Finance/app consumer acknowledgement.
