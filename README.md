<a href="https://github.com/Jevelopers-neatHack-2026/fulfillment-connectors">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/banner-night.svg">
    <img alt="fulfillment-connectors — Supplier quotes, submissions and status. TicketStub banner showing a route line linking a stub, a parcel and a status node." src="docs/assets/readme/banner-day.svg" width="100%">
  </picture>
</a>

# fulfillment-connectors

Provider-neutral TypeScript runtime for TicketStub supplier quotes, order submission attempts and status observations.

<p>
  <a href="https://github.com/Jevelopers-neatHack-2026"><img alt="TicketStub ecosystem" src="https://img.shields.io/badge/TicketStub-ecosystem-E4572E?style=flat-square&labelColor=17140F"></a>
  <a href="#status"><img alt="Status: local foundation candidate, simulated mode only" src="https://img.shields.io/badge/status-local%20foundation-B4693E?style=flat-square&labelColor=17140F"></a>
  <a href=".node-version"><img alt="Node.js 24.21.0" src="https://img.shields.io/badge/node-24.21.0-26302A?style=flat-square&labelColor=17140F"></a>
  <a href="package.json"><img alt="TypeScript 6.0.3" src="https://img.shields.io/badge/typescript-6.0.3-7CC6D2?style=flat-square&labelColor=17140F"></a>
</p>

[Status](#status) · [Architecture and ownership](#architecture-and-ownership) · [Quickstart](#quickstart) · [Configuration](#configuration) · [Checks](#checks) · [Repository structure](#repository-structure) · [Docs](#docs) · [Related](#related-repositories)

## Status

`main` holds a **local worker-runtime foundation candidate** tested with deterministic private fixtures. It does not complete [FC-01](https://github.com/Jevelopers-neatHack-2026/fulfillment-connectors/issues/3) or close any other FC issue.

Implemented local surfaces (package entry points are distinguished below):

- **Runtime (FC-01).** `FulfillmentConnectorRuntime` with typed adapter operations, injected ports and typed `ConnectorError` side-effect states. Modes are `simulated` (default) and `sandbox` (disabled until accepted pins exist); `liveModeSupported` is always false. See [runtime](docs/runtime.md).
- **Security helpers (FC-11).** Provider-neutral helpers for scoped reference access, payload minimization, safe diagnostics, injected secret and asset ports, tombstones (with a versioned tombstone fingerprint keyring, see [key management](docs/key-management.md)) and callback hints, with synthetic policy fixtures. They are not wired to an adapter or the submit path. See [security](docs/security.md).
- **Private fixture slices.** Offline provider matrix (FC-02, [provider matrix](docs/provider-matrix.md)), catalog normalizer (FC-03, [catalog](docs/catalog.md)), quote normalizer (FC-04, [quotes](docs/quotes.md)), local JSON attempt store (partial FC-06, [attempt store](docs/attempt-store.md)) and metering outbox (FC-10, [metering](docs/metering.md)). Their formats are private development shapes, not shared contracts.
- **Order-authorization consumer (FC-05, partial).** The package root exports a simulated development consumer of the application's pinned `ticketstub.order-authorization/1` port. It reconciles ambiguous claims and revalidates the exact trusted terms immediately before dispatch through injected ports. Tests use a fake issuer/transport and frozen producer fixtures; real issuer integration and canonical binding remain pending. See [order authorization](docs/order-authorization.md).
- **Prodigi Product Details wire decoder.** The package exports a pure private response projection and relative path helper, covered by synthetic offline fixtures. It performs no HTTP request, product selection, or orderability decision; issue 15's full acceptance still includes the supported cancellation outcome. See [Product Details](docs/prodigi-product-details.md).
- **ProductionBundle consumer (FC-08, partial).** The separate `./production-bundle` entry point provides an offline validator over the exact owner `@jevelopers/shared-contracts` 0.9.7 byte verifier and the real print-production corpus bytes, behind a frozen critical-criteria table. The runtime retains a fail-closed `submit` gate. The best verdict is `integrity_passed_blocked`: owner byte integrity only, eligibility blocked, no approval, acceptance or authority minted. Every non-simulated `submit` is refused before any port is touched. See [ProductionBundle consumer](docs/production-bundle.md).
- **Prodigi v4 sandbox adapter and secret-reference resolver (offline-tested only).** `ProdigiSandboxClient` maps the private quote request and a private order-create input to `POST /v4.0/quotes`, `POST /v4.0/Orders` and `GET /v4.0/orders/{id}` on `https://api.sandbox.prodigi.com/v4.0`, and projects PII-free observations. Requests are refused unless sandbox calls are explicitly enabled, an owner sandbox decision verifies and a sandbox credential resolves. `createEnvServerSecretSource` resolves the reference `prodigi/sandbox/api-key` to `PRODIGI_SANDBOX_API_KEY` at call time; live bindings are refused and there is no `PRODIGI_API_KEY` binding. No request has been sent to Prodigi. See [Prodigi sandbox](docs/prodigi-sandbox.md).
- **Prodigi callback intake and authenticated reconciliation (offline-tested only).** Prodigi documents unsigned CloudEvents callbacks, so `ProdigiCallbackReconciler` treats a callback only as an untrusted "go look" hint. A callback must present a host-held URL capability token (resolved through the secret-reference port, with a rotation slot), carry a `com.prodigi.order.*` type and the sandbox `source`, and name an order the application tracks. The host gets a 2xx only when an authenticated read that started after the callback was received (on our own clock) has been applied, or when a pending record that owes such a read is persisted in the store and owned by a durable job. Reads are single-flight per order (callbacks that arrive during a read join the next one), with a per-order interval that coalesces bursts and a read limiter that is fair per tenant. Deferred jobs retry with jittered backoff (about 1 h with a durable scheduler), and exhaustion emits `reconcile_abandoned` at least once to a hook (required with a durable scheduler) for the poller. Workers sharing a store must be clock-synchronized within `workerClockSkewMs`. Callbacks are disabled by default and live is refused. See [Prodigi callbacks](docs/prodigi-callbacks.md).
- **Bounded PNG byte inspection (FC-08, partial).** `inspectPngBytes` reports exact input-byte hash/length and limited facts for one static RGB8 noninterlaced PNG profile, with CRC and bounded zlib checks. Six synthetic renderer PNGs are diagnostic only and have `handoffEligible: false`; unsupported formats/profiles fail closed. This does not validate a production bundle, canonical binding, print eligibility, approval, or dispatch. See [PNG inspection](docs/png-inspection.md).
- **Status inbox (FC-07, partial).** `LocalStatusStore` records scoped status observations, a derived projection, conflicts, poll work and an at-least-once outbox in the private `fc-status-store/2` format (format 1 is rejected). Its mapping, polling and correction policies, trusted-lookup port and outbox are development fixtures. The local commit marker detects some inconsistent loss but cannot authenticate a coordinated rollback or complete directory loss. [Issue 13](https://github.com/Jevelopers-neatHack-2026/fulfillment-connectors/issues/13) stays open: the shared-contracts #27 mapping, authenticated provider lookup and callbacks, application consumer conformance, and finance, sandbox and release acceptance are pending. See [status](docs/status.md).
- **Quote comparison (FC-09, partial).** `comparePrivateQuotes` projects two or more private quote snapshots, preserves exact source terms and reports unknown or incompatible bases. It does not rank, choose a provider or submit an order. Currentness uses one captured trusted clock value, so a consumer must recheck at use time. [Issue 14](https://github.com/Jevelopers-neatHack-2026/fulfillment-connectors/issues/14) stays open: the shared-contracts #25 mapping and application consumer review are pending. See [comparison](docs/comparison.md).

Compiled for local tests but not exported: the deterministic simulator (FC-02-MOCK), which drives simulated provider behavior, restart snapshots and the durable metering outbox with synthetic ports. See [simulator](docs/simulator.md).

Blocked, and not claimed here:

- **No production provider adapter.** The Prodigi v4 sandbox adapter is untested against an account; no SKU, destination or shipping method has been approved, and no sandbox call has been made ([FC-02-SANDBOX](https://github.com/Jevelopers-neatHack-2026/fulfillment-connectors/issues/15)).
- **No accepted upstream schema pins.** Every cross-repository payload is owned by shared-contracts, which has not yet accepted or published a schema version ([ownership table](docs/runtime.md#cross-repository-payload-ownership)).
- **Integrated adoption remains incomplete.** Scoped offline ProductionBundle and authorization fixture results do not establish accepted application/production/Finance wiring, genuine customer authority or a provider sandbox transaction.
- **No live mode.** No live endpoint is allowlisted and live-class credentials are rejected. FC-11 has no production encryption, secret manager, pinned transport, callback authentication or durable replay store.

Sandbox, live and release readiness are false for every slice, and sandbox and release verification fail closed. Acceptance criteria FUL-01 to FUL-04 and LIVE-03 stay planned in [integration-evals](docs/architecture/ACCEPTANCE.md).

The [FC-EPIC](https://github.com/Jevelopers-neatHack-2026/fulfillment-connectors/issues/1)
tracks remaining implementation, and the [FC-12 release gate](https://github.com/Jevelopers-neatHack-2026/fulfillment-connectors/issues/16)
requires separate mock and authorized sandbox evidence.

## Architecture and ownership

The application owns customer authorization and the commercial order lifecycle.
`FulfillmentConnectorRuntime` consumes trusted terms, package validation, authorization,
budget and persistence ports, then delegates eligible work to a provider adapter.
Local attempt records, metering and status projections retain external observations;
they do not create a second application order model or financial ledger.

| Boundary | Responsibility |
| --- | --- |
| Application → connector | Exact order terms, customer authorization and current dispatch-time revalidation |
| Production → connector | Immutable artifact bundle and provider requirements; integrity is separate from eligibility |
| Connector → provider | Normalized catalog/quote/submission/status operations through explicit modes and gates |
| Connector → Finance | Attributable attempt/usage signals and external budget ports; Finance owns reservations and accounting |
| Connector → integration-evals | Revision-bound evidence with simulated, captured and actual provider results distinguished |

The [runtime guide](docs/runtime.md) lists injected ports and canonical payload owners.
Current local fixture implementations are available for development; external boundary
acceptance remains subject to the status limitations above.

## Quickstart

Requires Node.js 24.21.0 ([`.node-version`](.node-version), `engines`) and npm 11.19.0 (`packageManager`). The one runtime dependency is the vendored owner package `@jevelopers/shared-contracts` 0.9.7 (`vendor/shared-contracts/jevelopers-shared-contracts-0.9.7.tgz`, a `file:` dependency that is imported by the `./production-bundle` and development-only `./development-capability` entry points, never by the package root). Dev dependencies are TypeScript 6.0.3 and `@types/node`.

```sh
git clone https://github.com/Jevelopers-neatHack-2026/fulfillment-connectors.git
cd fulfillment-connectors
npm ci      # locked install; may need registry access
npm test    # builds dist/ and runs all 16 existing local fixture suites plus the development capability consumer and quote-store checks
```

No test calls a provider or another repository.

The development capability consumer and its limitations are documented in [the catalog guide](docs/catalog.md#development-canonical-consumer).

There is no standalone HTTP server or `npm start` script. Consumers import the compiled
ESM package and supply their runtime ports. To build without running suites, use
`npm run build`; this invokes TypeScript using [tsconfig.json](tsconfig.json).

## Configuration

Local tests require no environment file, provider key or account. Provider endpoints,
policies, credentials and authorization are separate boundaries; selecting a mode alone
does not grant permission to dispatch.

| Configuration | Purpose |
| --- | --- |
| [`.node-version`](.node-version), [`package.json`](package.json), [`package-lock.json`](package-lock.json) | Exact runtime, npm and dependency versions |
| [`src/provider-matrix.ts`](src/provider-matrix.ts) | Provider/environment policy and disabled live routes |
| Injected runtime ports | Trusted authorization, terms, budget, attempt persistence, metering, transport and clock; see [runtime](docs/runtime.md) |
| `prodigi/sandbox/api-key` → `PRODIGI_SANDBOX_API_KEY` | Optional server-side sandbox secret reference, resolved only at call time by the [secret resolver](src/prodigi-secrets.ts) |
| `evidence/FC-*` | Generated simulated verifier receipts; git-ignored and scoped to each documented suite |

Do not put credential values in documentation or fixtures. Actual sandbox smoke
execution requires the separately approved decision and limits in the
[sandbox guide](docs/prodigi-sandbox.md); it is outside the local quickstart.

## Checks

Each `verify:*` script runs `scripts/verify-fulfillment` in simulated mode against the built package, prints a JSON result and writes `result.json` to the listed (git-ignored) evidence directory. Run `npm run build` or `npm test` first. The verifier exits nonzero on any failure, including a Node version other than 24.21.0.

| Command | Suite | Evidence directory |
| --- | --- | --- |
| `npm run verify:contract` | Runtime contract fixtures (FC-01) | `evidence/FC-01` |
| `npm run verify:provider-matrix` | Offline provider matrix policy (FC-02) | `evidence/FC-02` |
| `npm run verify:mock` | Deterministic simulator and outbox | `evidence/FC-02-MOCK` |
| `npm run verify:catalog` | Catalog normalization (FC-03) | `evidence/FC-03` |
| `npm run verify:quote` | Quote normalization (FC-04) | `evidence/FC-04` |
| `npm run verify:attempt-store` | Local attempt store (FC-06, partial) | `evidence/FC-06-ATTEMPT-STORE` |
| `npm run verify:metering` | Metering and outbox (FC-10) | `evidence/FC-10` |
| `npm run verify:security` | Security policy helpers (FC-11) | `evidence/FC-11` |
| `npm run verify:status` | Status inbox (FC-07, partial) | `evidence/FC-07-STATUS` |
| `npm run verify:comparison` | Quote comparison (FC-09, partial) | `evidence/FC-09-COMPARISON` |
| `npm run verify:prodigi-product-details` | Private Product Details wire fixtures | `evidence/FC-PRODIGI-PRODUCT-DETAILS` |
| `npm run verify:png-inspection` | Bounded private PNG byte-observation fixtures (FC-08, partial) | `evidence/FC-08-10-PNG` |
| `npm run verify:order-authorization` | Simulated order-authorization consumer and dispatch revalidation | `evidence/FC-ORDER-AUTH` |
| `npm run verify:package` | ProductionBundle consumer over the owner package and the real corpus bytes (FC-08, partial: owner integrity only, critical criteria blocked) | `evidence/FC-08` |

Single suites: `npm run test:catalog` (needs an existing build); `test:quote`, `test:attempt-store`, `test:status`, `test:comparison`, `test:prodigi-product-details`, `test:png-inspection`, `test:order-authorization`, `test:package`, `test:prodigi-sandbox` and `test:prodigi-callbacks` build first. The owner-gated `scripts/prodigi-sandbox-smoke.mjs` is never run by tests or CI ([Prodigi sandbox](docs/prodigi-sandbox.md#not-done-needs-owner-approval)). `--suite sandbox` and `--suite release` always fail until an adapter, accepted pins and conformance evidence exist. The [`foundation-ci`](.github/workflows/ci.yml) workflow runs the pinned toolchain check, the owner-package pre-check, `npm ci`, `npm test` and all 14 `verify:*` commands with read-only permissions and no secrets. The PNG wrapper writes only its fixed git-ignored `evidence/FC-08-10-PNG/result.json` path and rejects a substituted or symlinked evidence location; the `package` wrapper does the same for `evidence/FC-08`. Result fields and blockers: [runtime](docs/runtime.md#runtime-and-commands).

The repository has no separate lint/format script. `npm run build` performs TypeScript
checking and emits `dist/`; the test and verifier scripts provide the behavioral checks.

## Repository structure

| Path | Contents |
| --- | --- |
| [`src/`](src/) | Runtime, provider helpers, authorization consumer, package validation, local persistence and exported types |
| [`scripts/`](scripts/) | Build-independent suite drivers, simulated verification and explicitly gated owner smoke tools |
| [`tests/`](tests/) | Deterministic synthetic suites and pinned producer inputs |
| [`docs/`](docs/) | Per-component runbooks, ownership and acceptance limits |
| [`vendor/shared-contracts/`](vendor/shared-contracts/) | Exact immutable development archive consumed only by the ProductionBundle entry point |
| [`.github/workflows/`](.github/workflows/) | Pinned local-foundation CI and repository graph workflow |

The [order-authorization fixture README](tests/fixtures/order-authorization/README.md)
is an unchanged producer document copied from a pinned application revision. Its commands
and server descriptions refer to that producer checkout; use this repository's
`test:order-authorization` / `verify:order-authorization` scripts for connector checks.
Its [provenance manifest](tests/fixtures/order-authorization/provenance.json) must continue
to match the original bytes.

## Docs

| Doc | Covers |
| --- | --- |
| [Runtime](docs/runtime.md) | FC-01 boundary, ports, payload ownership, criterion audit, verification commands |
| [Security](docs/security.md) | FC-11 helpers and what they do not provide |
| [Provider matrix](docs/provider-matrix.md) | FC-02 Prodigi observations versus local fixtures |
| [Simulator](docs/simulator.md) · [Catalog](docs/catalog.md) · [Quotes](docs/quotes.md) | Private fixture shapes and evidence limits |
| [Attempt store](docs/attempt-store.md) · [Metering](docs/metering.md) | Local persistence, outbox and finance boundaries |
| [Status](docs/status.md) · [Comparison](docs/comparison.md) | FC-07 status inbox and FC-09 quote comparison: private shapes and evidence limits |
| [Prodigi sandbox](docs/prodigi-sandbox.md) | Prodigi v4 sandbox adapter, secret references, gates and pending owner steps |
| [Prodigi callbacks](docs/prodigi-callbacks.md) | Prodigi callback trust model, replay and ordering rules, polling reconciliation |
| [Product Details](docs/prodigi-product-details.md) | Prodigi private wire fields, decoder behavior and evidence limits |
| [ProductionBundle consumer](docs/production-bundle.md) | FC-08 offline validator over the exact owner package, the fail-closed `submit` gate, criteria, limits and what stays blocked |
| [Order authorization](docs/order-authorization.md) | Simulated claim/lookup/revalidation consumer, trusted terms, dispatch checks and frozen producer fixtures |
| [PNG inspection](docs/png-inspection.md) · [Key management](docs/key-management.md) | Bounded byte observations and tombstone fingerprint keyring requirements |
| [Ownership](docs/architecture/OWNERSHIP.md) · [Acceptance view](docs/architecture/ACCEPTANCE.md) | Repository responsibilities and selected master criteria |

Architecture: [architecture kit v1.0](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/blob/main/docs/architecture-kit/v1.0/README.md) and the [central implementation plan](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/blob/main/docs/planning/implementation-plan.md). They describe intended boundaries; they do not establish completed product functionality, passing implementation tests, connected sponsor tools or live financial activity.

## Related repositories

- [shared-contracts](https://github.com/Jevelopers-neatHack-2026/shared-contracts): owns every cross-repository payload schema this runtime validates against.
- [print-production](https://github.com/Jevelopers-neatHack-2026/print-production): print specifications and production bundles.
- [cost-intelligence](https://github.com/Jevelopers-neatHack-2026/cost-intelligence): usage intake and the budget reservation authority.
- [getticketstub.com](https://github.com/Jevelopers-neatHack-2026/getticketstub.com): customer authorization and the order lifecycle.
- [integration-evals](https://github.com/Jevelopers-neatHack-2026/integration-evals): master acceptance checklist and cross-component evidence.

## Contributing

Follow [AGENTS.md](AGENTS.md) and the [organization contribution guidance](https://github.com/Jevelopers-neatHack-2026/.github/blob/main/CONTRIBUTING.md). Use a focused branch, neutral issue references and independent review of the exact diff. Commit only synthetic fixtures and no provider credentials or delivery addresses; verifier output under `evidence/` is git-ignored. Preserve frozen producer fixtures and their provenance hashes.

## License

No repository license file is present. The vendored owner package and copied fixtures
retain their own provenance; do not infer a project-wide license.
