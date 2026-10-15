# FC-03 private catalog normalization

`src/catalog.ts` adds a read-only, offline catalog normalizer for the FC-03.1–3 development slice. Its `connector-development-catalog/1` input and `connector-development-catalog-snapshot/1` output are private connector shapes. They are not canonical shared-contracts schemas, accepted pins, Prodigi claims, account evidence, or a substitute for the upstream capability/print-spec decisions. Shared-contracts #4 owns that schema. The draft producer request at shared-contracts PR #31 is still pending; this module intentionally does not propose or publish a competing schema.

The `CatalogSource` port exposes only `readCatalogSnapshot()`. `discoverCatalogSnapshot()` calls it once and normalizes an owned copy. There is no provider URL, credential, fetch implementation, quote/order operation, artifact builder, purchase action, or product substitution. The current fixtures use synthetic provider names and cannot establish a selected SKU, destination, shipping method, provider account, or sandbox behavior. Print-production #6 compatibility review remains pending.

## Private field semantics

The local TypeScript API is `normalizeCatalogSnapshot(input: unknown): Promise<CatalogSnapshot>`, `discoverCatalogSnapshot(source: CatalogSource): Promise<CatalogSnapshot>`, `evaluateCatalogSelection(snapshot: CatalogSnapshot, input: unknown, now: string): CatalogSelectionResult`, and `validateCatalogSnapshotBoundary(snapshot: CatalogSnapshot, validator: ContractValidator, trustedScope: TrustedScope): Promise<BoundaryResult<unknown>>`. `CatalogSource` exposes only `readCatalogSnapshot(): Promise<unknown>`. These signatures describe this package's private development interface; shared-contracts #4 owns the canonical fields and boundary signatures.

Every constraint is explicitly `known`, `unknown`, or `unsupported`. Unknown mandatory constraints block eligibility. Unsupported means the source explicitly declares that capability unavailable; a request using it is rejected. A missing field, invalid value, or contradictory known value rejects the snapshot instead of becoming an empty/default capability.

| Private field | Meaning used by the local evaluator |
| --- | --- |
| `dimensions` | Fixed product width, height, and depth. Exact positive decimal strings plus one unit (`mm`, `cm`, or `in`). Selection dimensions must match exactly after normalization. |
| `minimumBleed` | Minimum bleed for each of top, right, bottom, and left. The selected declaration must meet or exceed every side. |
| `minimumSafeArea` | Minimum content-safe margin for all four sides. Selected margins must meet each minimum, and left+right and top+bottom must each remain strictly below the fixed dimensions. Equality leaves no content area and is ineligible. |
| `minimumResolutionDpi` | Positive integer effective resolution. Selection must meet or exceed it. |
| `surfaces` | Set of supported print surfaces; selection names one exact member. |
| `files` | MIME types and inclusive minimum/maximum file counts. Both format and count must fit. |
| `color` | Supported color-space and profile sets. The selection must name one of each. |
| `options`, `materials` | Provider-specific selectable identifiers. Every selected identifier must be present; at least one material must be selected. Options may be empty when the product has no selected extra options. |
| `personalization` | Supported modes and hard field/character limits, or an explicit unsupported state. No personalization content is sent or constructed here. |
| `destinations` | Country rules. A known empty region list means no region restriction; a non-empty list is an allowlist that requires one explicit matching region; unknown regions block; unsupported regional selection rejects a request that supplies a region. |
| `shipping` | Methods by country and optional region. An exact regional rule takes precedence; otherwise the country-wide rule applies. No matching route means ineligible. |
| `providerAttributes` | Bounded source-specific JSON metadata retained with the product. Sensitive-looking keys, URLs, email/phone-like values, unsafe numeric values, and oversized content are rejected. Attributes participate in spec identity because their semantics are provider-specific. |

Dimensions normalize to integer nanometres using `BigInt`; conversion never rounds. To keep every accepted conversion exact, dimension and inset values allow at most three fractional decimal places and only `mm`, `cm`, and `in`. Unsupported units, excess precision, non-decimal values, non-positive fixed dimensions, and values above two metres are rejected. Resolution, file counts, freshness durations, and JSON attribute numbers must be safe integers. Timestamps must be exact UTC ISO strings with millisecond precision. Provenance references are bounded, namespaced opaque identifiers rather than URLs or free text.

Set-valued fields and product/route rows are sorted before identity calculation, so source ordering does not create drift. Arrays inside opaque provider attributes preserve order because this private shape does not know whether a provider assigns order meaning. The limits are 200 products, 1 MB per input snapshot, 32 KB of provider attributes per product, 64 top-level provider-attribute keys, bounded strings/nesting, a 2,000-element maximum array length, and one-year maximum freshness.

## Identity and freshness

Each product has a deterministic `specIdentity` over provider/API identity, SKU and variant, availability, normalized constraints, and provider attributes. It excludes retrieval time, evidence mode, source reference, and catalog version. A material change to dimensions, bleed/safe area, resolution, surfaces, formats/counts, color/profile, options, materials, personalization, destination/shipping, availability, or provider attributes changes the selected product's identity.

`catalogContentIdentity` covers provider/API/catalog version, source reference/revision, and normalized products. It excludes retrieval time, freshness policy, and evidence mode. `snapshotIdentity` covers that content identity plus source capture metadata and freshness. Re-fetching byte-equivalent content at a later time therefore preserves content/spec identities while creating a distinct capture identity. Old snapshot objects are deeply frozen, separately owned copies and remain reproducible after the source object changes.

Selection evaluation requires an explicit current UTC time; it does not consult the wall clock. Freshness is inclusive at `freshUntil`: the exact expiry timestamp is accepted, and the next millisecond is stale. An invalid clock or a time before retrieval fails closed. A stale capture, removed/missing SKU, or changed bound spec requires catalog refresh, revalidation, re-quote, and new approval. A fresh capture metadata change with the same selected spec is re-evaluated against the current snapshot and does not by itself claim material drift. Incompatible dimensions, bleed/safe area, resolution, surface, file type/count, color/profile, options/materials/personalization, destination/region, or shipping return ineligible.

The identity strings and evidence fields are local integrity/provenance values. They do not prove that a source reference, revision, evidence mode, or provider statement is genuine. `synthetic_fixture`, `documentation_reference`, `account_observation`, and `unverified_import` are caller-supplied attribution labels only; fixture tests use `synthetic_fixture` exclusively.

## Boundary and evidence

`validateCatalogSnapshotBoundary()` delegates the private snapshot to the existing injected `ContractValidator` for the owned `capability` output boundary. It validates bounded own-data binding and result records, a literal boolean discriminator with exactly one branch, required success value, allowlisted failure codes, and one exact capability receipt with matching scope and schema major. It returns newly owned, frozen projections of approved success, receipt, or failure fields; malformed structures fail with a typed safe result. Canonical value validation stays delegated to the injected validator. A development fixture response remains a development fixture and cannot satisfy an accepted pin or producer/consumer conformance requirement. No canonical schema mapping or accepted shared-contract version exists in this change.

The local fixture mapping for a future owner review is:

| Future boundary concern | Private fields supplied here | Positive synthetic fixture | Negative synthetic assertion |
| --- | --- | --- | --- |
| Capability provenance and selected product | provider/API/catalog versions, source/revision/retrieval/evidence, SKU/variant/availability, provider attributes and three identities | alpha and beta snapshots retain separate source/version and opaque provider attributes | changed source revision changes content/capture identity; removed SKU is blocked without substitution |
| Print geometry and production safety | dimensions, minimum bleed, minimum safe area, effective resolution and surfaces | alpha 304.8 × 457.2 × 0.3 mm, 3 mm bleed, 5 mm safe area, 300 DPI, front | changed width drifts spec identity; insufficient bleed/safe area or exact dimensions fail |
| Artwork transport constraints | MIME types/counts, color spaces/profiles | alpha accepts one or two PDF/PNG files in its fixture profile | JPEG, three files, wrong profile, or low DPI fail |
| Product choices | option/material sets and personalization mode/limits | alpha matte paper with bounded variable text; beta explicitly has no personalization | changed option/material drifts identity; unsupported personalization request fails |
| Destination and delivery choices | country/region allowlists and region-aware shipping routes | alpha US-CA express and beta CA-BC economy | FR, US-TX, and overnight shipping fail |
| Canonical producer/consumer handoff | private snapshot delegated to the existing `capability` `ContractValidator` boundary | the fixture validator receives the capability boundary request | a missing-contract result is propagated; development fixture status stays non-accepted |

This is a semantic mapping from the accepted FC-03 field requirements to the future capability/print-spec boundary, not an assertion that print-production #6 has accepted these exact field names. The consumer's declared field/signature requirements and shared-contracts #4 canonical mapping remain review inputs; the fixture test does not claim producer/consumer conformance.

`tests/catalog-fixtures.mjs` contains two incompatible synthetic catalogs. `tests/catalog-suite.mjs` checks deterministic set handling, retrieval/content/spec identity separation, drift, freshness and clock failures including expiry equality, removed SKUs, unknown mandatory constraints, unsupported personalization, required allowlisted destination regions, region-specific shipping precedence, impossible safe-area equality/overflow and valid positive content area, format/color/option/material checks, exact units, strict untrusted catalog and boundary inputs, immutable ownership, malformed boundary result unions, projected receipt/failure fields, and delegated boundary behavior. The package root exports the private module and its TypeScript types; the package includes this document. Run the dedicated suite after building, or use the default test command:

```sh
node tests/catalog-suite.mjs
npm run test:catalog
npm test
```

The stable simulated evidence wrapper is `npm run verify:catalog` (or `./scripts/verify-fulfillment --suite catalog --mode simulated --evidence-dir evidence/FC-03`). A passing result means only that the private offline fixture checks passed. Its `catalogAssessment` is a local verification report, not a capability or print-spec schema; it records exact local check counts, keeps FC-03 completion partial, and reports the canonical shared-contracts pin and print-production #6 review as pending. Sandbox readiness remains false and separate from local producer checks; no provider, account, order, or artifact boundary is invoked. Invalid modes fail closed, and sandbox/live suites retain their existing prerequisite failures.

This is local simulated evidence only. It makes zero provider calls, has no live or sandbox account evidence, does not consume a ProductionBundle, does not mutate or construct approved artifacts, and does not close FC-03.1–3 or the dependent sandbox/release gates. Exact canonical fields, schema pin, accepted fixtures, and print-production #6 review remain upstream handoffs.


## Development canonical consumer

`@jevelopers/fulfillment-connectors/development-capability` exports
`discoverDevelopmentCapability(source, context)` for private offline development.
It uses the existing vendored shared-contracts 0.9.7 archive (source
`d432ad5c895a67155affeaa05cd8423c758d95c3`, SHA256
`771a9f565ea9df87a4c08e6e6d5ede422d2a5926182a95be082dc8ed7b8c4c43`).
This implements the previously pending single-capture mapping requested in
shared-contracts #32 and fulfillment #3/#8; the earlier private-only observations
above remain historical descriptions of the original catalog slice.

The source is read exactly once. `captureCatalogSnapshot` owns and freezes the raw
private input before normalization. The canonical owner's `adaptFulfillmentCatalogV1`
receives that same capture, independently supplied UUID tenant/project scope, and
an explicit UTC clock. The owner checks `FulfillmentCapabilitySnapshot/1.0.0` and
`PrintSpec/1.0.0`; canonical identities are recomputed by the owner and never copied
from private normalized hashes. The package root does not load the owner package.

Success returns both snapshots with `eligibility: not_established`. Missing trim,
printable, outer-frame and inset-basis geometry remain unknown. Source hashes and
caller evidence labels do not authenticate a supplier. Scope is host-owned; the
caller must authenticate it before invoking this development API. Invalid context
is refused before reading the source; malformed input/source errors and canonical
refusals produce only fixed safe codes. There are no quote, order or finance ports.
The legacy bundle/quote/authorization translations remain explicitly refused by
the pinned owner. No accepted boundary mapping or runtime dispatch gate is changed.

Run `npm run test:development-capability`. Its preloaded network guard covers all
Node outbound paths before module evaluation. Tests use the actual alpha/beta
source inputs through connector discovery and owner validators, check exact units,
separate identities, scope/tamper/drift/freshness, immutable capture, unknowns and
legacy refusals. These are consumer development checks, not a domain ACK or
release acceptance. Named producer/consumer review, accepted pins, print-production
#6 geometry/format agreement and genuine product/host authority remain pending.
The unrelated owner 0.9.7 byte-helper hold SC-PFB-PARENT-LEGACY009 remains unchanged;
this capability-only API never invokes those byte helpers.
