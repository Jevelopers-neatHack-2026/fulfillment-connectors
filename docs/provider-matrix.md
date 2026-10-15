# FC-02 provider and environment matrix

- **Matrix version:** `fulfillment-provider-environment-matrix/1`
- **Official documentation checked:** 2026-10-10
- **Provider documentation revision:** unknown; the inspected Prodigi reference does not expose an immutable source revision. The dated observations below are not an accepted provider specification.
- **Release readiness:** blocked. No provider adapter, accepted SKU, account test, producer/consumer conformance, or sandbox evidence is present. No provider call was made.

This matrix distinguishes documented interface metadata, local fixture behavior, account-tested behavior, and implemented adapter behavior. A documentation example, configured product string, simulator fixture, or passing local matrix suite cannot select a product or establish account access.

## Matrix

| Provider | Mode | API and endpoint | Credential class | Product, destination, shipping | Operation evidence | Account and implementation evidence |
| --- | --- | --- | --- | --- | --- | --- |
| Deterministic simulator | `simulated` | Local fixture only; network is forbidden | None | Not applicable | Local runtime/contract fixtures only | Not a supplier simulator or provider conformance test; no external adapter |
| Prodigi | `sandbox` | v4.0 documentation observed; policy allowlist is `https://api.sandbox.prodigi.com/v4.0` | Sandbox-class only; no key may be supplied to this policy | **Unknown.** Print-production has not approved a SKU/specification, destination country, or shipping method. No example SKU is selected. | Quote, order creation, product details, and order retrieval are documented; an offline-fixture-tested sandbox adapter covers quote, order creation and order retrieval, and a fixed-selection product-details read, with no account test. Cancellation is conditional. Callback authenticity is not established by the inspected reference. | Account access is unknown and untested; sandbox is not release-ready |
| Prodigi | `live` | Disabled; no live endpoint is allowlisted | Live-class credentials are rejected | Not selected | Excluded from v1 and not authorized | No live adapter, credential, test, or activity |
| Other providers | Sandbox or live | Deferred; no endpoint is allowlisted | None | Not selected | No support claimed | Deferred |

The official reference describes Prodigi API v4, sandbox and live environments, environment-specific credentials, and the `X-API-Key` header. The public FAQ says sandbox orders are not charged or fulfilled and confirms that sandbox and live keys differ. These facts describe the provider interface only; they do not show this repository has credentials or a working integration. ([Prodigi v4 API reference](https://www.prodigi.com/print-api/docs/reference/), [Prodigi Print API FAQ](https://www.prodigi.com/faq/print-api/))

The reference documents the following v4 paths, which are recorded as metadata. Quote, submit and status are callable only through the offline-tested sandbox adapter once the policy returns `sandbox_call_permitted`; none has been called against an account:

| Operation | Documented method and path | Evidence status |
| --- | --- | --- |
| Quote | `POST /v4.0/quotes` | Documented; account behavior and quote expiry remain unverified |
| Submit | `POST /v4.0/Orders` | Documented; offline-tested sandbox adapter only; no authorized test order |
| Status retrieval | `GET /v4.0/orders/{prodigi_order_id}` | Documented; offline-tested sandbox adapter only; no account read |
| Product details | `GET /v4.0/products/{sku}` | Documented; offline-tested sandbox method for the single owner-delegated validation SKU (`GLOBAL-PHO-4X6`, `US`, `Standard`) only; needs a trusted owner-action grant; never sent to Prodigi; proves no account access, terms or cost |
| Product details | `GET /v4.0/products/{sku}` | Documented endpoint; this project made no product request |
| Cancel | `POST /v4.0/orders/{prodigi_order_id}/actions/cancel` | Conditional on provider action availability and order state; excluded from the initial FC-02 sandbox slice |
| Callback | CloudEvents callback payload | Interface documented; authenticity/signature requirements were not established in the inspected reference |

The reference says its optional idempotency key is scoped to a provider account and retained indefinitely. This is not an application authorization claim or proof that the implementation is safe to retry after an ambiguous result. `merchantReference` is not the provider's duplicate authority. Cancellation availability and refund behavior depend on order state. An order marked `Complete` has received shipping notifications for all items; that status is not delivery confirmation. ([Prodigi API reference: idempotency and order actions](https://www.prodigi.com/print-api/docs/reference/#orders), [order completion](https://www.prodigi.com/print-api/docs/reference/#8-order-completion))

The docs show product details can describe dimensions, attributes, shipping destinations, and print-area resolutions. They also describe general JPG/PNG/PDF support and product-dependent asset sizing, including default central cropping for images and PDF processing at the received size. These general descriptions do not specify a selected SKU, variant, material, dimensions, destination, shipping method, or approved file specification. All remain unknown pending print-production review. ([Prodigi product details](https://www.prodigi.com/print-api/docs/reference/#get-product-details), [asset sizing](https://www.prodigi.com/print-api/docs/reference/#image-resizing), [FAQ](https://www.prodigi.com/faq/print-api/))

## Fail-closed policy

`evaluateProviderPolicy()` defaults to `simulated`, rejects any endpoint or credential class in that mode, and records no network or credential access. It accepts no live or unknown mode, provider, credential class, hostname, endpoint path, or operation. The only sandbox endpoint base recognized by the policy is the exact HTTPS Prodigi v4 sandbox base above. Sandbox preconditions also require an explicit `sandbox` credential-class binding, the requested operation, SKU, destination, shipping choice, and a decision reference that an injected `SandboxDecisionVerifier` resolves.

The verifier is a private adapter-facing trust port, not an accepted shared schema. A future authorized implementation must independently check the print-production product/specification and destination/shipping approval plus sandbox-account access and ensure they match the request. An ordinary configuration string is not evidence. This repository has no such verifier or account binding. It has an offline-tested Prodigi sandbox adapter and secret-reference resolver that have never been run against an account. Even when a private test verifier returns a matching fixture, policy reports only `sandbox_prerequisites_verified` with `providerCallPermitted: false` unless the request names the offline-tested sandbox adapter (`adapterId: PRODIGI_SANDBOX_ADAPTER_ID`). Only then does it return `sandbox_call_permitted` with `providerCallPermitted: true` and `providerAdapterImplemented: true`. Any other `adapterId` is blocked as `invalid_configuration`, and simulated mode rejects the field. The Prodigi sandbox adapter (`docs/prodigi-sandbox.md`) dispatches only on `sandbox_call_permitted`. The matrix's `sandboxAdapter` entry records this adapter as `offline_fixture_tested` and `accountTested: false`; the per-operation `implementation` fields stay `not_implemented` until sandbox evidence exists. Test evidence cannot establish real product or account approval.

The matrix does not define a competing product catalogue, purchase authorization, finance ledger, or canonical shared schema. No credential material is accepted by the policy input or returned in assessment output. Future adapter work must resolve a sandbox-class secret only after the environment and owner evidence checks pass, and must never fall back to live mode, endpoints, or credentials.

## Executable evidence

Build and run both local suites, then write the FC-02 matrix assessment:

```sh
npm test
./scripts/verify-fulfillment --suite provider-matrix --mode simulated --evidence-dir evidence/FC-02
```

The provider-matrix suite covers the offline default, missing or mismatched sandbox credential class, live/unknown modes, endpoint host/path mismatches, unsupported providers and operations, missing owner-evidence references, mismatched verifier results, and secret-safe failures. It performs no provider calls and reads no credentials. A successful suite status means the local policy fixtures passed. Its JSON assessment remains `completion: partial`, `fc02_1: partial_documented_matrix`, `fc02_2: blocked_pending_owner_product_and_account_evidence`, `sandboxReady: false`, and `liveEnabled: false`.

## Closure gates

FC-02.1 is partially documented only. Closure still requires the immutable provider documentation revision or a dated reviewed snapshot, exact selected product and API constraints, and reviewed operation semantics. The official reference does not establish a quote-expiry guarantee, callback authenticity policy, or selected-product/destination lead time.

FC-02.2 remains blocked until print-production and the sandbox account owner provide sanitized, reviewable evidence for one actual SKU and print specification, a suitable destination and shipping choice, and confirmed sandbox account access. A compatible sandbox credential binding, implemented adapter, authorized account tests, and evidence review are also required. Until then, sandbox and release gates must fail. Live remains disabled and requires a separate future authorization.
