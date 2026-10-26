# FC-04 private quote normalization

`src/quotes.ts` implements an offline development interface for FC-04.1–3. The private `connector-development-quote/1` result binds normalized provider terms to one exact catalog capture, eligible product selection, quantity, destination reference and digest, shipping method, and trusted tenant/project scope. Its runtime functions and private types are exported through the package root for local integration. This private result is not the canonical `FulfillmentQuote` schema or a `QuoteResult` accepted by the connector submission runtime.

Shared-contracts #25 owns the canonical quote shape. The caller must inject the existing `ContractValidator`; the quote path asks it for the `fulfillment_quote` binding and delegates `validateOutbound`. A development fixture binding remains explicitly marked `development_fixture`. Every pin value surfaced in `contractBinding`, including `schemaVersion`, is checked as bounded, privacy-safe metadata before the quote port runs; schema versions must also match the supported version syntax, so safe ordinary versions and prereleases are allowed while URLs, personal contact details, address-like text, and secret-like material are rejected. The receipt version returned by `validateOutbound` is checked before its mapped payload is returned. This change does not invent a competing schema or claim producer/consumer conformance.

## Execution boundary

`executePrivateQuote(input, dependencies)` takes an exact request object with:

| Field | Meaning |
| --- | --- |
| `catalogSource` | Private catalog snapshot input normalized by the existing catalog helper. |
| `selection` | Selection evaluated against that snapshot, including its snapshot and catalog-content identities. |
| `quantity` | Safe integer quantity from 1 through 1,000,000. |
| `destinationReference` | Namespaced opaque destination reference; raw address data is not accepted. |
| `destinationDigest` | SHA-256 digest binding the destination without copying its personal data into the quote. |

Dependencies provide `quotePort.quote(request, { operation: "quote", signal })`, the injected `ContractValidator`, a millisecond `clock.now()`, and a trusted `{ tenantId, projectId }` scope. The bounded quote port has no submit or payment method. Its request contains only provider/API/catalog identity, exact product and selection facts, destination reference/digest and coarse destination codes, shipping, quantity, and a request digest. It does not receive personalization text or a street address. The default policy limits the call to five seconds, ten calls per port per one-second window, and five minutes of local quote validity; supplied policy limits are strictly bounded. Timeout aborts the provided signal and returns a typed safe error.

Inputs and responses are copied through strict own-data validation. Accessors are rejected without invocation; malformed prototypes, sparse or oversized arrays, unsafe numbers, unexpected fields, and invalid references fail closed. Provider failures, including thrown objects and proxy-backed errors, are reduced to newly owned fixed typed diagnostics; only the internal timeout sentinel and own-data rate-limit codes influence classification. Provider warnings and notes are bounded and screened for personal data, URLs, and secret-like values. The boundary result is checked for one exact quote receipt and matching tenant/project scope and schema major before it is returned. Privacy screening allows canonical ISO timestamps only in recognized quote time fields and exact monetary strings only as contract-mapped quote amounts; it still checks mapped text for personal and secret-like content.

## Money, completeness, and expiry

Provider amounts use exact decimal strings and one explicit currency and scale. The normalizer converts them to integer minor units with `BigInt`, without floating-point arithmetic or rounding. Supported input scales are 0–6 places; excess precision or a non-decimal value rejects the provider response. Production, shipping, tax, fee, and total are each either explicitly `known` or `unknown` with a reason code. A known zero remains a known amount.

Tax basis is explicitly `included`, `excluded`, or `unknown`. For excluded tax, the exact reconciliation is production + shipping + fee + tax = total. For included tax, the provider's total is reconciled against production + shipping + fee, while the tax amount remains separately represented. Unknown total, required line amounts, or tax basis produces an `incomplete` quote with an explicit list of missing reconciliation inputs; none is converted to zero. A quote is complete only when all amount lines are known, tax basis is known, and the total reconciles. Lead time is an estimate range or an explicit unknown.

The snapshot preserves provider expiry separately from a conservative local policy expiry. When provider expiry is undocumented, the effective expiry uses the configured local maximum. When provider expiry is earlier, it takes precedence; equality records both sources. A provider expiry at or before quote creation is rejected. Expiry is inclusive as a cutoff: a quote is stale when `effectiveValidUntil <= now`.

Quote IDs are deterministic SHA-256 fingerprints of the immutable quote body, including the scoped selection and normalized terms. A separate terms fingerprint covers the provider reference, currency, breakdown, expiry, lead time, warnings, and notes. These local hashes preserve identity; they do not establish provider authenticity or a canonical contract pin.

## Rechecking and effects

`evaluatePrivateQuoteCurrent(quote, currentInput, dependencies)` first copies and checks the complete private snapshot shape, exact money representation and reconciliation, terms fingerprint, quote fingerprint, expiry relationships, and creation time. It then verifies the current trusted scope, expiry, fresh catalog, selection eligibility, product/spec and catalog identities, options/materials, destination, quantity, and shipping method. This detects malformed or internally inconsistent serialized snapshots; the local hashes are identity checks and do not prove authenticity. It reports `current`, `stale`, `incomplete`, or `invalid`, with explicit refresh, revalidation, re-quote, and external-authorization actions. Any changed binding requires a fresh quote and renewed external authorization. An incomplete or stale quote cannot be presented as current for external review.

Snapshot revalidation uses the same field rules as quote creation for trusted tenant/project scope. The privacy scan treats only exact, structurally validated binding identifiers as opaque: scope IDs, provider/API/catalog IDs, SKU and variant IDs, selected option/material values, destination country/region codes, and shipping method. The exemption applies to the exact value under its matching field name; the phone heuristic and all URL, email, address, and secret checks remain active for notes and other unbound fields. A valid numeric identifier can therefore round-trip through a mapped quote and currentness check without making free text or a different value safe.

Every result is marked `financialEffect: "quote_only"`. A quote is an estimate, not a paid order, provider charge, budget reservation, or actual expense. This code makes no order, payment, budget, metering, provider-network, or sandbox call.

The private suite is `npm run test:quote`; its synthetic fixtures exercise exact currency arithmetic, unknown versus zero amounts, included/excluded tax, malformed and mismatched provider terms, expiry, changed bindings, timeout, rate limits, contract scope, and zero order submissions. `npm run verify:quote` runs the same suite through the stable simulated evidence wrapper. The suite reports local fixture behavior only: shared-contracts #25 canonical mapping and consumer conformance remain pending, scoped persistence is optional through the local development store described below, and sandbox/live/release readiness remain false.


## Scoped development persistence

`executePrivateQuote` accepts an optional `quoteStore` implementing
`QuoteSnapshotPersistence.save(quote, trustedScope)`. The function validates the
store method before quoting, then awaits persistence after the contract boundary
accepts the normalized snapshot and before returning success. A failed save
returns a safe `persistence_unavailable` error; a quote request may already have
occurred, but no order or expense API is reachable. Existing callers without a
store retain in-memory behavior. Hosts that require durable quotes must supply it.

`@jevelopers/fulfillment-connectors/development-quote-store` exports
`createLocalQuoteStore(directory)`. The host must provision a dedicated, current-user
0700 directory with no symlink path. The store creates a 0600 `quotes.sqlite`, uses
SQLite FULL synchronous transactions, and keys records by trusted tenant, project
and content-bound quote ID. Duplicate saves retain the original row. Reads and
saves recheck the complete existing private quote hash/terms validator; corrupt or
changed records fail without overwriting history. One SQLite statement checks
the stored byte length and returns the payload only when it is at most 512 KiB,
so a concurrent replacement cannot send a larger payload into JavaScript between
a size check and lookup. Oversized rows raise the safe store error; absent rows
still return `undefined`. This bounds the payload transferred to JavaScript, not
SQLite's internal memory or the size of the database on disk.
The schema is local version 1. Every open validates the exact schema objects and
column/type/nullability/key shape in a transaction, including already-versioned
databases. Unknown versions, extra tables/views/indexes/triggers, and changed or
missing columns are refused without rewriting the database.
There is no destructive migration or automatic repair. Back up/restore the whole
closed database and preserve its permissions; corrupted or future formats require
host investigation, not resetting it in place.

The API exposes `save`, `get`, and `close`. `get` retrieves immutable historical
terms, including expired quotes; consumers must still call
`evaluatePrivateQuoteCurrent` with current scope, inputs and clock before use.
The store has no submission, authorization, ledger, retention/deletion or encryption
port. It is single-host private development storage, not a shared production DB.
The host owns encryption, disk capacity, retention, backups, authenticated scope
and the directory lifecycle. Do not place production personal data in this store.
Canonical FulfillmentQuote mapping and application consumer acceptance remain open.
The package root does not import SQLite; only the development subpath loads it.

`npm run test:quote-store` builds and runs guarded local fixtures for persistence
through real quote execution, process restart, scope isolation, duplicate writers,
changed terms, tampering, closed storage, invalid contracts, unsafe paths and schema
refusal. These fixtures make zero network calls and confer no provider acceptance.
