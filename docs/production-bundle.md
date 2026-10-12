# ProductionBundle consumer (FC-08)

`src/production-bundle.ts` is the offline validator for a print-production `ProductionBundle` (schema `2.0.0`) and `src/runtime.ts` fails closed on it. It consumes the **exact owner package** `@jevelopers/shared-contracts` 0.9.7 and re-implements none of it: inventory, hashes, canonical manifest, detached protocol, ZIP and payload-set verification are one call to the owner's `verifyProductionBundleFiles`.

**Status: simulated only, and not acceptance.** The owner package is an unaccepted development candidate (`accepted: false`, source revision `d432ad5c895a67155affeaa05cd8423c758d95c3`). The only bytes available are the producer's synthetic diagnostic corpus (`handoffEligible: false`, no Finance receipt). The best verdict this code can ever produce is **`integrity_passed_blocked`**: owner byte verification passed and eligibility is *blocked*. It is not a complete approved-package validator and it does not close issue 10, FC-08.1–3 or any parent criterion.

## D6: what may and may not be dispatched

D6 means **no approved, eligible, accepted or non-simulated dispatch** from an unaccepted corpus or blocked eligibility.

* A **non-simulated** `submit` (any runtime mode other than `simulated`, including `sandbox` with `sandboxEnabled` and every binding forged `accepted`) is refused with `bundle_invalid` / `not_dispatched` *before any injected port is touched* — before `ContractValidator.validateInbound`, the adapter, the gate, the authorization verifier, persistence, budget, metering or transport. Owner 0.9.7 cannot return an eligible state, so no non-simulated submit can be justified. The check is unconditional: it does not depend on a gate, a binding state or any configuration. Existing `mode_mismatch`, `sandbox_disabled`, `contract_missing`, `scope_mismatch` and `invalid_input` outcomes keep their codes and precedence because the pure half of `decode` still runs first. Only `submit` is affected; quote, preflight, status, shipment, cancel and discovery behave as before.
* A **simulated** runtime with a **simulated** transport may proceed only as an honestly labelled **no-effect simulation** after integrity passed. The response then carries `productionBundleEvidence` with `simulation: "no_effect_simulation"`, `eligibility: "blocked"`, `authorityIssued: false`, `accepted: false`, `handoffEligible: false` and the sorted open critical codes. Nothing is ever labelled approved, eligible or accepted.
* Once the `production_bundle` contract binding is `accepted`, a missing gate fails `contract_missing`, so a deployment cannot skip the gate by omission.

## Authority model

* **Trust anchor.** A host-injected `ProductionBundlePublicationSource` resolves a pin (`commitment.length`, `commitment.sha256`, provenance) from `trustedScope + bundleDigest` only. The commitment bytes are read through a host `ProductionBundleByteSource` (content-addressed by the pin), checked for **length then SHA-256 against the pin before they are parsed**, structurally pre-validated by the owner (`validateProductionResult("exportArtifactBundle", …)`, which does not check scope), and only then used to derive the read budget. `commitment.eligibility` and every "accepted"-looking field are never read for any decision. `CORPUS.json` is a cross-check in tests, never an input. The anchor's provenance is the literal `development_fixture` and upgrades no criterion.
* **The command envelope chooses nothing.** `productionBundleDigest` is the owner `bundle_ref.content_hash` and is only a lookup key. `command.productionBundle` is untrusted; an owner-shaped reference that disagrees with the digest fails the gate. No caller field selects an anchor, a hash, a provenance, a policy or a criterion.
* **No policy, flag or environment variable selects criteria.** Severity is the frozen `PRODUCTION_BUNDLE_CRITERIA` table. Gate options are resource bounds only.
* **No competing definitions.** The consumer never defines a canonical JSON form, a bundle schema, a ZIP reader or a verifier. It never calls the owner's eligibility, approval, authority, host-approval or preflight functions: the owner has no fulfillment audience, so any call would impersonate one or run on fixture context. Owner `eligible` is **intentionally unreachable** for any schema-valid input (`PREVIEW_UNKNOWN` / `LEGACY_UNREPRESENTABLE`, documented in the owner's `production-contracts.md` and `CHANGELOG.md`); this is not worked around.
* **The report is a derived observation**, never permission to modify files or to issue artwork or purchase approval.

## Flow

1. `createProductionBundleGate({ publication, bytes, terms?, clock, consumerRevision?, limits? })` returns a **frozen, branded** gate (the only kind the runtime accepts).
2. The runtime (`submit` only) derives `mode` and `transportMode` from its own state, then calls `gate.checkBeforeSubmit` before the adapter pre-submit, the claim, the budget and the metering write, and **re-validates the returned report** (exact keys, literal flags, the frozen criteria table, recomputed open critical codes, digests, provenance, the command-bound bundle hash) before it records anything.
3. Immediately before **every** transport request, including adapter retries, `recheckBeforeDispatch` re-resolves the anchor, re-reads every file with its `maxLength`, re-verifies with the owner and returns a digest set. The runtime then awaits the authorization revalidation as the **last** await and compares synchronously: a different set digest or bundle hash is `bundle_changed`. No new await sits between that comparison and the transport call.

## Immutable bytes and bounds

* Bytes are copied once into private buffers using **captured native intrinsics** (`%TypedArray%.prototype` and `ArrayBuffer.prototype` getters, `util.types` guards, a `set`-based copy of the exact intrinsic window). Proxies, `SharedArrayBuffer`, resizable or detached buffers, subclasses, cross-realm views, accessors and own-property shadows are rejected with a typed reason; no iterator, spread, `slice` or species is consulted. The owner, the PNG decoder and the digests see only the private copies. Digests are recorded before and after.
* Own shadows are rejected by a deny-list **derived at load time** from the intrinsic prototypes, checked by descriptor presence only. The dense index range is never enumerated, because enumerating a 40 MiB view's own keys costs about 1.3 GiB of heap (measured); a suite case runs a 40 MiB view under a 256 MiB heap cap and requires a heap delta far below 8 MiB.
* Budgets come from the owner's exported `productionArchiveLimits` and are enforced **before any copy**, on both entry points, with the same numbers: at most `outer_descriptors` (100) files, per-name caps (archive 40 MiB, manifest 4 MiB, detached 1 MiB, every other file the 8 MiB entry cap), a payload group of at most `payload_bytes` (32 MiB) and an aggregate of at most 77 MiB (40 + 4 + 1 + 32). They are enforced differently, because the two paths hold different things:
  * **Host gate (`createProductionBundleGate`).** The budget is derived from the owner-pre-validated, pin-checked commitment (`deriveBudgets`) before the first read, and every `ByteSource.read` carries `maxLength` equal to the anchored size. A host result is copied only after its intrinsic length passed that file's anchored role cap, and a length that differs from the anchored size is then a typed `BYTE_LENGTH_MISMATCH`; files are read one at a time, so at most one host result is in flight per validation.
  * **Public pure API (`validateProductionBundleBytes`, caller-supplied file list).** `snapshotProductionBundleFiles` runs a **no-copy first pass** over the whole list and allocates private copies only after that pass succeeded. The first pass reads the array length and each element through own data descriptors, rejects Proxies, accessors, holes and non-plain entries, rejects a **case-insensitive duplicate filename**, inspects each view through the captured native getters (exact `Uint8Array`, no own shadow, no `SharedArrayBuffer`, not resizable or detached, window inside the buffer, intrinsic length against its own per-name cap) and keeps running sums with safe-integer arithmetic against the aggregate and payload-group caps. The count limit is exactly the owner's 100 (the earlier undocumented `+8` slack is gone). A name not in the anchor gets the generic 8 MiB entry cap and counts toward the payload group, so an extra file is bounded and still reaches the owner, which rejects it with its own attribution. One buffer listed under many names counts once per entry, so it cannot amplify memory: the copies of an accepted list are bounded by 77 MiB. Every comparison is written to fail closed.
  * The typed rejections are `SNAPSHOT_COUNT`, `SNAPSHOT_DUPLICATE_FILENAME`, `SNAPSHOT_OVER_CAP`, `SNAPSHOT_AGGREGATE_OVER_CAP` and `SNAPSHOT_PAYLOAD_GROUP_OVER_CAP`, reported under `byte_custody: SNAPSHOT_REJECTED` before the owner is consulted.
  * `snapshot.skipShadowDenyList` is a test-only switch of the low-level helpers (it only drops the typed `own_shadow` diagnostic). It is not part of `ValidateBytesOptions`: the validators and the gate cannot be given it.
* Worst case: the gate, at the default semaphore width 2 and queue 32, holds about **308 MiB** of read buffers plus private copies (2 × 77 MiB × 2); the queue holds no bytes and a pre-submit snapshot is reduced to digests. The pure API holds at most one accepted list: its first pass copies nothing and an accepted list copies at most 77 MiB.

## Deadlines, abort and the host contract (PBR-25)

Every `resolve` and `read` runs under a **real wall-clock deadline** (`node:timers`), never the injected `Clock`, which fixtures may freeze (defaults: resolve 5 s, per file 15 s, whole validation 60 s; configurable within 1 ms to 120 s). The request carries an `AbortSignal`, aborted at the deadline. A late result is dropped (its bytes are not retained, a late rejection is swallowed) and the semaphore slot is released exactly once, so a stalled port cannot strand capacity.

**Limit:** a deadline releases the slot while the host's port operation may still be running. The memory bound assumes the host honours the `AbortSignal`: a late result is dropped by the consumer, but any allocation happens in the host.

## Criteria

Every report lists all 32 criteria in a fixed order. Dynamic ones are `verified_owner` / `verified_local` / `failed` / `not_observed`; the rest are constants.

* **Verified locally (synthetic corpus, integrity only):** anchor resolution, byte custody, owner integrity, observed geometry consistency, PNG pixels, PNG effective DPI (integer arithmetic from observed pixels and declared nanometres: 1200 px ÷ 4 in = exactly 300), PNG `pHYs` metadata consistency (`round(dpi / 0.0254)` — the integer encoding identity, not a tolerance; absent or unit 0 is `not_observed`), PDF/SVG signature.
* **Critical blocked:** owner eligibility (`OWNER_ACCEPTANCE_PENDING`), exact-preview approval, PrintSpec fit (files, surfaces, dimensions, bleed/safe/trim, options, personalization, materials/colour, minimum DPI), capability identity and version mapping, preflight vs capability, quote contract, stale spec, row scope, accepted pins, trusted-terms binding (a fixture match stays `TERMS_BINDING_FIXTURE_ONLY`; no source is `TERMS_SOURCE_ABSENT`), provider-fetched-bytes immutability.
* **Critical unsupported (no owner representation):** artifact access and expiry, rights and terms, destination resolution, provider quantity limit.
* **Not observed:** PDF and SVG geometry — taken from the owner-verified manifest, never compared with the bytes.

A known-invalid condition (for example an observed PNG that contradicts its declared geometry) is a **`failed` critical criterion** and fails the run; it is never downgraded.

## Fixtures and custody

* Corpus (preferred input): print-production `01a7b13813b27e5b925b1363543c2577e860ffff` (tree `82f3296bdb5dfb204245efa23f0a393c6438d266`), Linux run `38216826905`, artifact `11733229451`, archive sha256 `eb9af5b9…d0300`, `CORPUS.json` sha256 `d3e5560d…4949f`. The 65 files (8 baseline, 1 control commitment, 55 variant entries and `CORPUS.json`) were verified against the custody receipt; the baseline, control commitment and `CORPUS.json` are committed and the 55 variant files are derived in memory (`pp16-extra` is the 10-byte extra file). `tests/fixtures/production-bundle/provenance.json` is generated programmatically from the artifact bytes by `tests/production-bundle-provenance-tool.mjs`. The producer's `valid` variant is labelled `accepted` in its `CORPUS.json`; that historic word is an integrity expectation only and is never read as approval.
* Superseded input: the earlier corpus (`300f997…`, run `38205370188`, artifact `11727293834`) is recorded in `provenance.json` under `supersedes` by digest and source, with the per-path delta computed from bytes (40 files changed, 25 unchanged, the PNG/PDF/SVG outputs among the unchanged) and checked against the producer receipt's own claim. Its bytes are not deleted: they remain in the original artifact directory and in git history. Only its manifest, detached file and trusted commitment are kept in `tests/fixtures/production-bundle/superseded/`, for tests that prove the old commitment, manifest and bundle hash cannot bind the new bundle.
* Owner archive: `vendor/shared-contracts/jevelopers-shared-contracts-0.9.7.tgz`, sha256 `771a9f565ea9df87a4c08e6e6d5ede422d2a5926182a95be082dc8ed7b8c4c43`, integrity `sha512-P462b8thg20g5RknBzdDL5mfxpXF+kpodLPCGrTe3kmKXrw9YZ21x3E/PuGEp0aEOGoiBZlq5JB4Pktq+2lBPg==`, byte-identical to print-production's pin. It has no dependencies and no lifecycle scripts; CI checks the sha256 before `npm ci`.
* Owner engines are `>=22.23.3 <23 || >=24.21.0 <25`, so this repository moved to Node `24.21.0` and npm `11.19.0`. Nothing bypasses engine checks.
* Re-committed negatives are built in tests only from owner-exported helpers plus a test-only stored-ZIP writer, published through the fixture publication port, and the owner verifier is asserted to pass them before the consumer is asserted to fail them.

## Running

```sh
npm run build
./scripts/verify-fulfillment --suite package --mode simulated --evidence-dir evidence/FC-08
```

The verifier accepts only that directory. Its report carries the validator and version, the source revision (and whether the tree is dirty), the evaluation time, the owner pin, the anchor, the bundle, the declared spec ref, all criteria, the digests and the report digest.

## What is still external

Genuine issuer approval bound to an exact composed preview, real PrintSpec and capability bytes, accepted shared-contracts pins and bindings, an independent host publication record, a composed-preview bundle, a non-null row scope, a second spec revision, a host content-addressed/object-locked store contract and owner representations for artifact access, rights, destination resolution and quantity limits. Until they exist those criteria stay critical-blocked and the parent criteria stay open.
