# Prodigi v4 sandbox adapter and secret-reference resolver

**Status:** implemented and covered by offline fixtures only. No request has been sent to Prodigi from this repository, so neither sandbox authentication nor any wire behavior has been confirmed against an account. Live mode does not exist.

Tracker: getticketstub.com #27 (Prodigi sandbox item) and [FC-02-SANDBOX](https://github.com/Jevelopers-neatHack-2026/fulfillment-connectors/issues/15).

## Modules

| Module | Exports | Purpose |
| --- | --- | --- |
| `src/prodigi-secrets.ts` | `createEnvServerSecretSource`, `PRODIGI_SANDBOX_SECRET_BINDING`, `SecretResolverError` | Server-side secret-reference resolver that implements the existing `ServerSecretSource` port used by `withServerSecret` |
| `src/prodigi-sandbox.ts` | `ProdigiSandboxClient`, `createProdigiQuotePort`, `mapQuoteRequest`, `mapOrderRequest`, `projectQuoteResponse`, `projectOrderResponse`, `toStatusResult`, `createFetchProdigiHttpPort`, `ProdigiSandboxError` | Prodigi v4 sandbox quote, order-create and order-read mapping |
| `src/prodigi-sandbox.ts` | `ProdigiSandboxClient.getProductDetails`, `createProdigiProductReadFetchPort`, `createOneShotProdigiProductReadPort`, `projectProductReadObservation`, the `SandboxProductReadGrant*` types | The single owner-gated product read ([below](#sandbox-product-read-global-pho-4x6)) |
| `scripts/prodigi-sandbox-product-read.mjs` | `runProductRead`, `validateProductReadReceipt`, `validateReceiptPath` | Zero-request preflight and the gated execution of that read |

## Secret references

Configuration names a credential by **reference** (`prodigi/sandbox/api-key`), never by value. A binding maps one reference to one provider, one credential class and one environment variable:

| Reference | Provider | Class | Environment variable |
| --- | --- | --- | --- |
| `prodigi/sandbox/api-key` | `prodigi` | `sandbox` | `PRODIGI_SANDBOX_API_KEY` |

This is the only predeclared binding. **No live binding exists and no `PRODIGI_API_KEY` binding is defined.**

Resolver rules:

- The environment is read on every `load` (no caching), so rotation takes effect on the next call. Only own properties count. A value must be 1–4096 visible ASCII characters with no whitespace; otherwise the result is `undefined` and `withServerSecret` fails with `server_secret_unavailable`.
- A lease is issued only when the reference, provider and requested mode all match, and only for mode `sandbox`. Simulated mode never receives a credential.
- Sandbox and live stay separate. A sandbox binding's variable must contain a `SANDBOX` token and no `LIVE`, `PROD` or `PRODUCTION` token, and a live binding's variable must not contain `SANDBOX`. One reference or variable cannot be bound twice.
- Live-class bindings are refused at construction unless the future flag `allowLiveCredentialBindings: true` is set. Even with the flag, no live lease can be issued, because `ProviderMode` has no live member. Live ordering stays a separate, future, owner-authorized launch step.
- Errors use fixed codes and messages and never include values.

Locally, the key lives in the git-ignored, owner-only `.env` (see `.env.example`). The package has no `.env` loader. The smoke command uses Node's built-in `--env-file`.

## Adapter

Base URL: `https://api.sandbox.prodigi.com/v4.0` (from `PRODIGI_SANDBOX_BASE_URL`), authenticated with the `X-API-Key` header. Endpoints come only from `PRODIGI_SANDBOX_OPERATION_ENDPOINTS`:

| Operation | Request | Mapping |
| --- | --- | --- |
| Quote | `POST /v4.0/quotes` | Private `QuoteProviderRequest` → `{ shippingMethod, destinationCountryCode, currencyCode, items: [{ sku, copies, attributes, assets: [{ printArea }] }] }`. `shippingMethod` uses the quote reference's lowercase values (`budget`, `standard`, `standardplus`, `express`, `overnight`). |
| Order create | `POST /v4.0/Orders` | Private `ProdigiOrderCreateInput` → `{ merchantReference, idempotencyKey, shippingMethod, recipient, items: [{ sku, copies, sizing, attributes, assets: [{ printArea, url, md5Hash }] }] }`. `shippingMethod` uses the order reference's PascalCase values (`Budget`, `Standard`, `StandardPlus`, `Express`, `Overnight`). No `callbackUrl` or `metadata` is sent. |
| Status | `GET /v4.0/orders/{ord_…}` | Strict `ord_` ID; no body |

No accepted shared-contracts schema exists yet for orders or quotes (shared-contracts #24–#27), so the inputs are the connector's private types. `createProdigiQuotePort` adapts the client to the existing `BoundedQuotePort`, so `executePrivateQuote` normalizes Prodigi quotes through the same exact-money pipeline as the fixtures.

### Gates, in order, before any request

None of these steps reads a secret or sends anything until step 6.

1. Input validation and mapping (`mapQuoteRequest`, `mapOrderRequest`, the strict `ord_` ID check).
2. The request's SKU, destination and shipping method must equal the configured decision.
3. `sandboxCallsEnabled` must be exactly `true` (default off).
4. The caller's `AbortSignal`, if given, must not already be aborted. An aborted signal throws `aborted` / `not_dispatched`.
5. `evaluateProviderPolicy`, called with `adapterId: PRODIGI_SANDBOX_ADAPTER_ID`, must return `sandbox_call_permitted` with `providerCallPermitted: true` for the operation's exact route. This needs the configured decision (SKU, destination country, shipping method, decision reference) to pass an injected `SandboxDecisionVerifier`. Without the adapter ID the policy still returns `sandbox_prerequisites_verified` with `providerCallPermitted: false`, which the adapter refuses.
6. `withServerSecret` must resolve a sandbox-class lease. The key exists only inside that callback. The signal is checked once more just before the request goes to the HTTP port.

Any failed gate throws `ProdigiSandboxError` with `sideEffectState: "not_dispatched"`. The HTTP port is not called, and no secret is read before step 6.

### Response projection

- **Quote.** The adapter keeps exactly one quote whose `shipmentMethod` matches the request. Line mapping: `production` = `costSummary.items`, `shipping` = `costSummary.shipping`, `tax` = `totalTax`, `total` = `totalCost`. `fee` = `branding`, which is an explicit known zero when absent because the adapter never requests branded inserts. Absent tax or total values stay unknown, never zero. Amounts must be decimal strings in the requested currency (USD, GBP, EUR, CAD or AUD at scale 2). The docs say `totalCost` includes tax but not whether line amounts include it, so the tax basis comes only from exact reconciliation (`excluded` if lines + tax = total, `included` if lines = total and tax > 0, otherwise `unknown`). Prodigi documents no quote ID or expiry, so `providerQuoteReference` is a local SHA-256 digest and expiry and lead time are `unknown/not_disclosed`. Only issue `errorCode`s survive, as warnings; descriptions are dropped.
- **Order.** Outcome (`created`, `onHold`, `createdWithIssues`, `alreadyExists` for create; `ok` for read) is compared case-insensitively, because the docs mix casing. The observation keeps the order ID, timestamps, stage, step details, issue codes and shipment ID, status, carrier name and dispatch date. Recipient, addresses, asset URLs, tracking numbers, tracking URLs, charges and metadata are dropped. A tracking number usually reveals the delivery town or postcode and the signer, so only `hasTrackingNumber` is kept; reconcile shipments by order and shipment ID. The carrier name is display-only. If it is not plain text (letters, digits, spaces and `._:/#()&,'+-`), it becomes `null` and the read still succeeds. Shipment ID, status, order ID, stage and step details stay strict.
- **`alreadyExists`.** Prodigi returns the existing order for a reused idempotency key, even when that order's items differ from the new request. The adapter does not compare them; callers must compare the returned order with their own record before treating it as the same order.
- **Status mapping.** `Cancelled` maps to `cancelled`. `Complete` maps to `shipped` (all shipments notified, not delivered). Any step in `Error` maps to `unknown`. `inProduction` or `shipping` started maps to `in_production`. Anything else maps to `accepted`.

### Failures

Each failure is a `ProdigiSandboxError` with a fixed code and message, a `sideEffectState`, and the HTTP status. Provider bodies are never copied.

- 400 → `validation_failed`, 401 or 403 → `authentication_failed`, 404 → `not_found`, 429 → `rate_limited`. These are `not_dispatched`.
- Other statuses → `provider_unavailable`. Transport errors → `provider_unavailable`, or `timeout` (default 30 s, maximum 60 s). Malformed bodies → `invalid_response`.
- A failure after the request reached the HTTP port (including a response whose fields throw when read) is never reported as `credential_unavailable` or `not_dispatched`. For order creation it is `provider_unavailable` with `sideEffectState: "unknown"`: the order may or may not exist.
- For order creation, every uncertain outcome is `sideEffectState: "unknown"` and must be reconciled with a read, not retried blindly. For quotes and order reads it stays `not_dispatched`. That value is inaccurate once the request has left the port, and it is kept only so existing behavior does not change; a receipt must count requests itself and never infer the count from `sideEffectState`. The product read does not share this gap: after dispatch every failure, including 4xx, is `possible`.

The fetch port allows only the sandbox origin and sets `redirect: "error"`. It rejects a declared `content-length` over 1 MiB and otherwise streams the body with a byte counter, cancelling it past 1 MiB. Non-2xx bodies are discarded unread.

## Sandbox product read (GLOBAL-PHO-4X6)

**Status: implemented and offline-tested only. The real request is `NOT_EXECUTED` and `NOT_AUTHORIZED`.** Nothing has been sent to Prodigi, no key has been read, and the missing owner-action authority below is a real blocker, not a formality.

One authenticated `GET https://api.sandbox.prodigi.com/v4.0/products/GLOBAL-PHO-4X6` with `X-API-Key` and `Accept: application/json`, no body, to see what the sandbox says about the owner-delegated validation SKU (finish, US `shipsTo`, and the default print area's documented recommended pixel dimensions). It is not a quote, an order or a catalog snapshot, and it is not run by tests or CI.

### Route and policy

`SandboxOperation` has a fourth member, `productDetails`, with the endpoint-table entry `GET /v4.0/products/{sku}`. `evaluateProviderPolicy` accepts it only for the fixed selection `GLOBAL-PHO-4X6` / `US` / `Standard` (`PRODIGI_SANDBOX_PRODUCT_READ_SELECTION`); any other SKU, destination or shipping method is blocked with `product_read_selection_not_allowed` before the verifier runs. The first read is itself the first test of account access, so for this operation the policy does not require `sandboxAccountAccessConfirmed` and nothing may present that attestation as proof.

`ProdigiSandboxClient.getProductDetails(references, signal?)` has no SKU, URL or host parameter. The path is `prodigiProductDetailsPath(decision.sku)`, checked against `PRODIGI_SANDBOX_PRODUCT_READ_PATH`, and the decision must be the fixed selection (otherwise `decision_mismatch`). The decoded result is `decodeProdigiProductDetails(body, decision.sku)`, the existing strict decoder; no response shape is invented.

### Gates, in order, before the key is read

1. **One call per client.** The claim is taken synchronously before any `await` and never released: a second, concurrent or retried call fails with `request_budget_exhausted` before any gate, key read or port call.
2. Reference shape (`ownerPermissionReference`, `accountTermsReference`, `requestCostBudgetReference`, `receiptBinding = sha256:<hex of the receipt path>`) and the fixed selection.
3. `sandboxCallsEnabled === true`; the signal is not aborted.
4. `evaluateProviderPolicy` returns `sandbox_call_permitted` for the exact route (the decision verifier attests the delegated tuple only).
5. **Trusted owner-action grant.** The injected `productReadGrantVerifier` must return the exact request echoed back, with `ownerPermissionVerified`, `accountTermsAccepted`, `requestCostBudgetApproved` and `singleUse` all `true` and an unexpired `expiresAt`. The request carries `sourceRevision`, `builtArtifactSha256` and `ownerPacketSha256` as well as the references, so the host approves the revision, the exact built code and the owner packet together. The grant must also carry `approvedSourceRevision`, `approvedBuiltArtifactSha256` and `approvedOwnerPacketSha256`, which the host states from its own trusted context (the approved owner packet) and the library compares with the candidate: a host that only echoes the request, or never looked at the digest, is rejected. Nothing here can stop a trusted host from copying the candidate into those fields; that is a lie by the authority, not a gap this repository can close. No verifier, a throw, a missing or extra field, or a stale grant fails with `grant_unverified` / `not_dispatched`. The same check (`isVerifiedSandboxProductReadGrant`) is used by the command-line preflight, so the preflight cannot be looser than the execution.
6. `withServerSecret` resolves the sandbox key; the signal is checked once more; the one request is handed to the port.

The deadline/abort signal is re-checked after **every** `await` of steps 4-5 and immediately before the key load, so a continuation that resumes after the deadline (or after a caller abort) calls no further trusted host and reads no key. A step that was already running cannot be undone, but nothing after it starts; the receipt counters therefore stay true.

The grant interface is `SandboxProductReadGrantVerifier.verify(request)`. **This repository has no implementation of it and cannot have one:** it must be a trusted host that resolves each reference with its owning authority (the owner's permission, the account terms the owner actually accepted, the request-cost budget). A reference that merely exists is not authority; an operator-attested boolean is not a grant. `verify` must be free of external side effects, because the preflight and the client both call it.

### Transport

`createProdigiProductReadFetchPort` requests only the exact URL above with `redirect: "error"`, drops every non-2xx body unread and counts native bytes while streaming (cancelling past 1 MiB, before decoding). `createOneShotProdigiProductReadPort` wraps any port: it increments an attempt counter **synchronously before anything else**, refuses every second attempt and every request that is not exactly this URL, GET, the two expected header names and no body, and records what it actually forwarded (`attempts`, `dispatched`, `refused`, status, native bytes). Its snapshot is the request count of record, independent of how the client classifies a later invalid response.

The client gives the whole read (verifiers and secret source included, not only the port) a hard 15 s deadline (a constructor `timeoutMs` is capped at 30 s) that also settles the call when a custom port ignores the `AbortSignal`; the port's promise always has a handler, so a late rejection is never unhandled, and the single timer is cleared on every path. A 2xx other than 200, a declared or counted size over 1 MiB, and a UTF-8 length over 1 MiB are refused before `JSON.parse`. There is no retry, no redirect, no fallback host, SKU or method.

### Receipt

`projectProductReadObservation` keeps only: SKU, SHA-256 of the canonical decoded DTO, product dimensions, attribute names, the values of the attribute named `finish`, variant count, variants shipping to `US`, print-area names, and the distinct `default` print-area recommended pixel sizes (`defaultPrintAreaRecommendedPixelSizes`). The public reference documents `horizontalResolution` / `verticalResolution` as RECOMMENDED pixel dimensions: they are not a required bleed, template or customer print specification, and they are an observation only once a real response exists (the test fixture values are placeholders). It drops the description and every other free-text field.

`scripts/prodigi-sandbox-product-read.mjs` writes the receipt `prodigi-sandbox-product-read-receipt/1` to an absolute path **outside every git worktree**, created exclusively (`wx`, mode 0600) before the key is read or anything is sent. The path must be normalized, free of symlinks, not `.env`-adjacent and not yet existing; the file is re-checked after opening. It holds the references (opaque strings), the 40-hex source revision, the owner-packet digest, the request counts taken from the transport, the outcome (status, HTTP status, error code, `sideEffectState`, elapsed ms, native bytes), the observation above, and these fixed attestations: decision verifier `operator_attestation_only`, key presence `name_only_never_proof`, account access `NOT_ASSERTED_ONLY_OBSERVED_BY_THIS_ONE_READ`, account terms `NOT_VERIFIED_BY_THIS_RECEIPT`, request cost `UNKNOWN` (never zero), built artifact `LOADED_FROM_HASHED_BYTES_APPROVAL_IS_THE_TRUSTED_HOSTS_ONLY` (plus a top-level `builtArtifactSha256`), and `authorityIssued`, `quoteAuthority`, `orderAuthority`, `bundleEligible`, `trimOrTierApproval`, `customerApproval` all `false`. It never holds the key, a header, the raw body, an account or customer identifier, or any URL except the fixed origin. A receipt is validated before it is written; a crash after the open leaves an `in_flight_dispatch_unknown` record, not a clean slate.

### Command line

```sh
npm run build
node scripts/prodigi-sandbox-product-read.mjs \
  --decision-reference <ref> --owner-permission-reference <ref> \
  --account-terms-reference <ref> --request-cost-budget-reference <ref> \
  --source-revision <40 hex> --owner-packet-sha256 <64 hex> \
  --receipt-path /absolute/path/outside/git/receipt.json
```

This default mode is a **zero-request preflight**. It needs no key and no environment, reads no `.env`, contacts nothing and creates nothing. It prints the fixed request plan and every gate as `satisfied`, `attested_only`, `unverified`, `missing`, `invalid` or `unavailable`, lists the `missingGates`, and exits 0 only when none are missing (otherwise 2). Its `authorizesExecution` is always `false`. The selection is compiled in; `--sku`, `--country`, `--shipping`, a URL, a host or a key option do not exist and are refused as unknown options.

- **Built artifact (what will actually run).** `dist/` is git-ignored, so a clean HEAD says nothing about it. The command line therefore hashes a deterministic inventory of every regular file under `dist/` plus its own bytes (sorted `{path, size, sha256}` entries; symlinks, hard links, special files, unsafe names, depth or size beyond fixed limits, or a missing `dist/index.js` fail the gate) into a **candidate** `builtArtifactSha256`, and then imports the library **from those same in-memory bytes** through module hooks on a private URL scheme that contains the digest: nothing is read from `dist/` again, so there is no hash-then-import window, and a module that is not in the inventory, a bare package or a `file:` URL cannot be loaded. The digest is sent to the trusted host in the grant request; whether it is the digest the owner approved is the host's decision, never this file's (it does not compare it with a value it computed itself or was handed on argv). The preflight prints the candidate with `approval_pending`; it is not "reviewed" until an actual independent review of that exact source and current CI, and the gate `built_artifact_approved_by_trusted_host` stays `unverified` (blocking) without a host.
- **Untrusted preload.** Code-loading flags (`--import`, `--require`/`-r`, `--loader`, `--eval`, `--print`, `--inspect*`, ...) in `process.execArgv`, and at execute in `NODE_OPTIONS`, fail `no_untrusted_preload`. **Practical host assumptions, stated precisely:** the digest binds the code this process loads; it cannot defend against other code already running in the same process, a debugger or ptrace attached by the same user, or a native addon, and it reads the command-line controls (this file) from disk at run time rather than from the already-running module. The host must run the process without untrusted preloads and with a trusted Node binary.
- The report also lists `unverifiedAssertions` apart from the gates: the built artifact is not reviewed (approval pending), the compiled tuple is not verified by any authority (it is an operator attestation, and HEAD does not verify it), account access is not asserted, request cost is `UNKNOWN`, and no customer authority exists. `trustedHostInterface` spells out what a trusted host must implement and what is not authority.
- Provider's public statement that sandbox orders are not charged or fulfilled is a marketing/documentation sentence about orders. It says nothing about the cost of an API request or about this account's permission, and it is not adopted.
- **`decision_reference` is an operator attestation** of the owner-delegated decision (integration-evals 0003 R1-R3). It is the only attestation used, and it is not account proof, accepted terms or a cost approval.
- The three owner-action references stay `unverified` until a trusted host verifies them. `--source-revision` must equal the clean checked-out HEAD, which says nothing about `dist/`: that is the built-artifact gate above.
- `--execute --owner-approved` runs the same preflight and then the read, but only when a trusted host is supplied. **This command line supplies none**, so from it `--execute` always refuses with `trusted_host_grant_verifier` missing, zero requests, zero credential reads and no receipt. A host application that owns those authorities embeds `runProductRead(argv, { host })`, where `host.verifyProductReadGrant(request)` returns the grant described above. **Embedding contract:** `runProductRead`'s `deps` (`host`, `env`, `fetch`, `fs`, `git`, `execArgv`) is injection for a trusted embedding host and for tests; it is not reachable from argv or the environment, but a caller that supplies a stub `git`, `execArgv` or `fs` weakens the matching gate, which is acceptable only because that caller is the trusted host. **One-shot scope:** the one-call guarantee is per client and per transport wrapper, not a process-wide ledger. A host that calls `runProductRead` twice in one process with two receipt paths and two grants would make two requests; uniqueness across calls rests on the host's `singleUse` grant, which this repository cannot implement.
- **Key delivery.** The key is read only from `PRODIGI_SANDBOX_API_KEY`, only after every gate and after the receipt exists, through a one-name view of the environment. Export only that variable for the one process; never pass it in argv. `node --env-file` is refused (`no_whole_env_file_loading`) because it loads a whole `.env` before any gate.

### What a successful read would prove

Only that the decoder accepted one provider response for this exact SKU at that moment. It is not account proof beyond that one answer, not accepted terms, not a request-cost statement, not a quote, an order, an eligible production bundle, trim or customer-tier approval (R2's customer mapping stays open), and it does not make GLOBAL-PHO-4X6 the 4x2 diagnostic ticket.

## Tests

`npm run test:prodigi-sandbox` (also part of `npm test`) runs `tests/prodigi-sandbox-suite.mjs` in a child process with a credential-free environment (only `PATH` and temp-directory variables). The suite never reads `process.env` for credentials: every resolver receives an injected env, and a test plants a sentinel `PRODIGI_SANDBOX_API_KEY` in `process.env` and asserts it never reaches a request.

`tests/prodigi-sandbox-network-guard.mjs` is preloaded with `node --import`, before any `dist/` module loads. It makes `fetch`, `http`/`https` `request`/`get`, `net.connect`/`createConnection`, `net.Socket.prototype.connect` and `tls.connect` throw and counts each attempt. The runner pins the case IDs and fails if a case is missing, renamed or reordered. It reports the measured `externalProviderCalls` and fails unless that value is 0. This is an in-process guard, not OS-level network denial. The cases include 403, a pre-aborted signal, a throwing response getter, an oversized streamed body, the smoke script refusing to run without `--owner-approved`, and the product read: the fixed route and every gate, the trusted grant, status and redirect handling without retry, oversize bodies refused before parsing, a port that ignores the abort signal, the one-shot transport, the command-line preflight (spawned with an empty environment) and receipt races. The product-read cases live in `tests/prodigi-sandbox-product-read-cases.mjs`; the in-process ones drive `runProductRead` with a fake trusted host, a fake `fetch` and an injected environment, so none can reach Prodigi. The fixtures in `tests/prodigi-sandbox-fixtures.mjs` are synthetic and shaped from the public reference (checked 2026-10-11). They are **not recordings** of sandbox traffic.

## Owner decision (2026-10-12)

The owner delegated this decision on 2026-10-12. Rows R1-R3 of integration-evals decision 0003 ([PR #39](https://github.com/Jevelopers-neatHack-2026/integration-evals/pull/39); `planning/decisions/0003-owner-delegated-decisions-2026-10-12.md` once merged; delegation recorded on [getticketstub.com#27](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/issues/27#issuecomment-6116953222)) record it.

- **Sandbox validation SKU:** `GLOBAL-PHO-4X6`. A C-type silver-halide photo print, 102 x 152 mm (4 x 6 in), lustre. Prodigi's public [C-types page](https://www.prodigi.com/products/prints-and-posters/photo-prints/c-types/), checked 2026-10-12 with no API call, lists it as fulfilled in the US. That page lists lustre, gloss and metallic for the product family, not per SKU, so only the product-details read confirms lustre for this SKU. `GLOBAL-PHO-4X6-PRO` (UK and US) is a fitting alternative. 4X6 was chosen for its wider fulfilment.
- **Validation print spec:** one `default` print area, landscape 6 x 4 in, full bleed at 300 dpi (1800 x 1200 px), sRGB JPG, finish lustre, sizing `fillPrintArea`. Bleed, safe area and the stub layout are print-production's template (PP-03, print-production #6).
- **Not decided: the customer-facing mapping.** getticketstub.com sells the `print` tier as matte, foil or holo, in Classic stub (2 x 5.5 in) or Stamp (2 x 3 in). Lustre is not matte, this SKU has no foil or holo, and the customer would receive a 6 x 4 sheet rather than a trimmed stub. That mapping remains an open product decision.
- **Destination and shipping:** `US`, `Standard`.

This names the SKU, destination and shipping that items 1 and 3 below ask for. It is **not** an approval to run the smoke command, and it is not account evidence. The authenticated read, print-production's roster and template acceptance, and the real `SandboxDecisionVerifier` remain open. The read confirms the attribute key and value for the finish and the US `shipsTo`.

## Not done (needs owner approval)

0. **The authenticated product read.** The route, the gates and the zero-request preflight are implemented ([above](#sandbox-product-read-global-pho-4x6)); the request itself is not executed. It still needs the explicit owner permission naming it, the actually accepted account terms, a per-request cost budget, a trusted host that verifies those references, a reviewed merged source revision and a receipt location outside git. This is the preferred first observation; it does not need a quote.
1. **One authenticated sandbox quote or read.** This needs explicit owner approval. The SKU, destination and shipping method are named in the [owner decision](#owner-decision-2026-10-12): `GLOBAL-PHO-4X6`, `US`, `Standard`. The command makes exactly one request and never creates an order:

   ```sh
   npm run build
   node --env-file=.env scripts/prodigi-sandbox-smoke.mjs --owner-approved \
     --decision-reference <owner-decision-ref> --sku <SKU> --country <CC> --shipping <Budget|Standard|StandardPlus|Express|Overnight> \
     [--currency USD] [--copies 1] [--attributes '{"<attr>":"<value>"}']
   ```

   The script's verifier is an operator attestation, not product or account evidence. Output is sanitized: it contains no key, recipient or raw body.
2. **Confirm wire details from that read:** amount representation (string versus number), `totalTax`/`totalCost` presence and tax basis, accepted `shippingMethod` casing for quotes (the adapter sends the documented lowercase values; the docs' own quote example uses `Budget`, so try PascalCase first if the quote fails with `validationFailed`), and the outcome casing. Replace synthetic fixtures with sanitized recordings.
3. **Print-production approval** of one SKU and print specification, destination and shipping method, and a real `SandboxDecisionVerifier` that resolves that evidence.
4. **A sandbox order-create test**, under separate owner approval. Then update the provider matrix's per-operation `implementation` and `accountTested` fields, and `sandboxAdapter`, with the evidence.
5. Cancellation, runtime `ProviderAdapter` wiring and live mode remain out of scope. Callback intake and authenticated reconciliation are covered in [Prodigi callbacks](prodigi-callbacks.md). They are offline-only and disabled by default.


### R45-01: approval before candidate module evaluation

The product-read CLI now inventories candidate bytes without importing `dist/`.
Preflight never loads candidate modules, even with a valid trusted-host grant.
Execute first checks all gates using built-in-only bootstrap validation of the
host's exact grant, including independently approved source/artifact/packet values.
Only after that approval does it import the captured hashed bytes. The client
revalidates its own grant immediately before credential access. Approval does not
come from a validator supplied by the candidate it would authorize.

Module-resolution failures can only be observed after approved loading; inventory
path/size/link failures are still refused before asking the host. Loading failure
returns `REFUSED_APPROVED_ARTIFACT_UNLOADABLE` with no receipt/key/provider request.
Tests include a real top-level candidate marker: absent for hostless/approved
preflight and denied execution; present after approved loading through injected
fake fetch. Existing late-continuation, strict-grant, hashed-byte and zero-network
controls remain. This repairs the local ordering defect only. Independent review,
PR45/current-main reconciliation (including the existing PR52 proposal), real host
permission/account terms/request budget, and actual sandbox evidence remain open.
