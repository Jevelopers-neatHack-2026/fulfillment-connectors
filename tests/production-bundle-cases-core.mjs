// SIMULATED ONLY. Cases: provenance, anchor, bytes, owner, attribution.
// Every case runs the REAL owner 0.9.7 verifier over the real print-production corpus bytes (or owner-built re-commitments of
// them). Passing proves the consumer against the owner's unaccepted development candidate; it is not acceptance of anything.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as bundle from "../dist/production-bundle.js";
import * as contract from "../dist/production-bundle-contract.js";
import * as ownerWrapper from "../dist/production-bundle-owner.js";
import * as f from "./production-bundle-fixtures.mjs";

export const criterion = (report, id) => report.criteria.find((item) => item.id === id);
export const states = (report) => Object.fromEntries(report.criteria.map((item) => [item.id, `${item.state}${item.code === null ? "" : `:${item.code}`}`]));
const enc = (text) => new TextEncoder().encode(text);
const sha = f.sha256Tagged;

export async function runGate(world, request = {}, gateOverrides = {}, method = "checkBeforeSubmit") {
  const gate = f.createGate(world, gateOverrides);
  return gate[method](f.gateRequest(request));
}
export function baselineWorld() {
  const world = f.createWorld();
  f.publishFromBaseline(world);
  return world;
}
const ctxSignal = () => new AbortController().signal;
export const portContext = (limits = {}) => ({ limits: { ...bundle.PRODUCTION_BUNDLE_DEFAULT_LIMITS, ...limits }, signal: ctxSignal() });

/** An issued anchor for the real baseline, resolved through the fixture ports exactly as the gate does. */
export async function issuedAnchor(world = baselineWorld(), bundleDigest = f.BUNDLE_HASH) {
  const resolved = await bundle.resolveTrustAnchor({ trustedScope: f.SCOPE, bundleDigest }, { publication: world.publication, bytes: world.bytes }, portContext());
  assert.equal(resolved.ok, true, JSON.stringify(resolved));
  return resolved.anchor;
}
export const filesOf = (map) => [...map].map(([filename, bytes]) => ({ filename, bytes: f.clone(bytes) }));
export const validateFiles = (files, anchor, extra = {}) => bundle.validateProductionBundleBytes({ files }, anchor, { clock: f.frozenClock, consumerRevision: "0123456789abcdef0123456789abcdef01234567", ...extra });

export function register(define) {
  // ---- provenance -------------------------------------------------------------------------------------------
  define("provenance.generated-pins-all-64-plus-corpus", () => {
    const pins = new Map(f.provenance.pins.map((pin) => [pin.path, pin]));
    assert.equal(f.provenance.pins.length, 65);
    assert.deepEqual(f.provenance.counts, { regularFiles: 65, receiptEntries: 64, byKind: { "corpus-json": 1, baseline: 8, control: 1, variant: 55 } });
    const baseline = f.baseline();
    for (const [name, bytes] of baseline.files) {
      const pin = pins.get(`bundle/${name}`);
      assert.equal(pin.sha256, f.sha256Hex(bytes), name); assert.equal(pin.size, bytes.length, name); assert.equal(pin.kind, "baseline");
    }
    const control = pins.get("bundle/trusted-commitment.json");
    assert.equal(control.sha256, f.sha256Hex(baseline.commitmentBytes)); assert.equal(control.kind, "control");
    assert.equal(pins.get("CORPUS.json").sha256, f.sha256Hex(baseline.corpusBytes));
    // CORPUS.json's own baseline inventory and control inventory agree with the independently generated pins (cross-check only).
    for (const entry of f.corpus.baseline_inventory) assert.equal(pins.get(`bundle/${entry.name}`).sha256, entry.sha256);
    assert.equal(f.corpus.control_inventory[0].sha256, control.sha256);
    assert.equal(f.provenance.trustedCommitment.sha256, control.sha256);
  });

  define("provenance.variants-derived-55-in-memory", () => {
    const pins = new Map(f.provenance.pins.map((pin) => [pin.path, pin]));
    let derived = 0;
    for (const id of f.VARIANT_IDS) {
      for (const [name, bytes] of f.deriveVariant(id)) {
        const pin = pins.get(`variants/${id}/${name}`);
        assert.ok(pin, `${id}/${name}`);
        assert.equal(pin.sha256, f.sha256Hex(bytes), `${id}/${name}`); assert.equal(pin.size, bytes.length);
        derived += 1;
      }
    }
    assert.equal(derived, 55);
    assert.equal(f.provenance.extraBin.literal, "pp16-extra");
    assert.equal(f.provenance.extraBin.length, 10);
    assert.equal(f.provenance.extraBin.sha256, f.sha256Hex(f.EXTRA_BIN));
  });

  define("provenance.synthetic-flags-and-null-finance", () => {
    for (const source of [f.provenance, f.corpus]) {
      assert.equal(source.synthetic, true); assert.equal(source.accepted, false); assert.equal(source.handoffEligible, false);
      assert.equal(source.finance_receipt, null); assert.equal(source.canonical_usage_intake, "unavailable"); assert.deepEqual(source.usage_refs, []);
    }
    // The producer's own receipt (FC issue 10, comment 6120259654): final selected source, actual Linux run, artifact and digests.
    assert.equal(f.provenance.producer.revision, "01a7b13813b27e5b925b1363543c2577e860ffff");
    assert.equal(f.provenance.producer.linuxRun, 38216826905);
    assert.equal(f.provenance.producer.artifactId, 11733229451);
    assert.equal(f.provenance.producer.artifactZipSha256, "eb9af5b9aae788561d2a7f8f67f3fce579cb53323751856e079f8c77db4d0300");
    assert.equal(f.provenance.producer.corpusJsonSha256, "d3e5560d1f7030ac4bf1d7164530a1137234acd1ebedd39043c356bf5604949f");
    assert.equal(f.provenance.sharedContractsPin.archive_sha256, contract.OWNER_PACKAGE_PIN.archiveSha256);
    assert.equal(f.provenance.sharedContractsPin.integrity, contract.OWNER_PACKAGE_PIN.integrity);
    assert.equal(f.provenance.sharedContractsPin.accepted, false);
    assert.equal(f.provenance.sharedContractsPin.source_revision, contract.OWNER_PACKAGE_PIN.sourceRevision);
  });

  define("provenance.spec-hash-derived-not-typed", async () => {
    const manifest = f.baselineManifest;
    const preflight = JSON.parse(new TextDecoder().decode(f.baseline().files.get("preflight.json")));
    const derived = manifest.spec_ref.content_hash;
    assert.equal(preflight.body.spec_ref.content_hash, derived);
    assert.equal(f.provenance.manifestRefs.spec_ref.content_hash, derived);
    assert.ok(derived.startsWith("sha256:0c273edf"));
    assert.ok(!JSON.stringify(f.provenance).includes("0c273eda"));
    const report = await runGate(baselineWorld());
    assert.deepEqual(report.specRef, { state: "declared_by_manifest_unverified", contentHash: derived });
  });

  define("provenance.new-source-crossbound-to-manifest-corpus-receipt-and-owner-pin", async () => {
    const revision = f.provenance.producer.revision;
    // Every place that names the producer source agrees, and none of them is the superseded one.
    assert.equal(f.baselineManifest.producer.source_revision, revision);
    assert.equal(f.corpus.production_revision, revision);
    assert.notEqual(revision, f.provenance.supersedes.producerRevision);
    assert.equal(f.provenance.supersedes.producerRevision, "300f997c87e36077a93dd1c4951420878a5c847c");
    // The owner package is unchanged: the same pin is recorded by the corpus and by this repository.
    assert.equal(f.corpus.shared_contracts_pin.version, contract.OWNER_PACKAGE_PIN.version);
    assert.equal(f.corpus.shared_contracts_pin.source_revision, contract.OWNER_PACKAGE_PIN.sourceRevision);
    assert.equal(f.corpus.shared_contracts_pin.archive_sha256, contract.OWNER_PACKAGE_PIN.archiveSha256);
    assert.equal(f.corpus.shared_contracts_pin.integrity, contract.OWNER_PACKAGE_PIN.integrity);
    assert.equal(f.provenance.supersedes.sharedContractsPinUnchanged, true);
    // Bundle identity: corpus summary, manifest, host-anchored commitment and the consumer's report are one and the same bundle.
    assert.equal(f.corpus.manifest.bundle_hash, f.BUNDLE_HASH); assert.equal(f.corpus.manifest.bundle_id, f.BUNDLE_REF.id);
    assert.equal(f.baselineManifest.bundle_hash, f.BUNDLE_HASH); assert.equal(f.baselineManifest.bundle_id, f.BUNDLE_REF.id);
    assert.equal(f.provenance.bundle.hash, f.BUNDLE_HASH);
    assert.notEqual(f.BUNDLE_HASH, f.provenance.supersedes.bundle.hash);
    const report = await runGate(baselineWorld());
    assert.equal(report.bundle.hash, f.BUNDLE_HASH); assert.equal(report.bundle.id, f.BUNDLE_REF.id);
    assert.equal(report.anchor.commitmentSha256, f.sha256Tagged(f.baseline().commitmentBytes));
    assert.equal(report.anchor.commitmentSha256, `sha256:${f.provenance.trustedCommitment.sha256}`);
    assert.equal(report.specRef.contentHash, f.baselineManifest.spec_ref.content_hash);
    // The corpus's historic word "accepted" for the valid variant is an integrity expectation only; it is never an approval here.
    const valid = f.corpus.variants.find((variant) => variant.id === "valid");
    assert.equal(valid.expected, "accepted"); assert.equal(valid.ownerVerifier.detail, "integrity=passed;eligibility=blocked");
    assert.deepEqual({ verdict: report.verdict, eligibility: report.eligibility, accepted: report.accepted, handoffEligible: report.handoffEligible, authorityIssued: report.authorityIssued },
      { verdict: "integrity_passed_blocked", eligibility: "blocked", accepted: false, handoffEligible: false, authorityIssued: false });
    assert.equal(f.corpus.accepted, false); assert.equal(f.corpus.handoffEligible, false);
  });

  define("provenance.superseded-input-recorded-by-digest-with-computed-delta", () => {
    const old = f.provenance.supersedes;
    assert.equal(old.artifactId, 11727293834); assert.equal(old.linuxRun, 38205370188);
    assert.equal(old.artifactZipSha256, "c92b8571ef6fe646284eec7b810ccf669651075124a98494409b64abe4fdc43d");
    assert.equal(old.corpusJsonSha256, "0d8422683915890b15607724c25420326d97be0676651df8f88673e36395bef9");
    assert.match(old.provenanceSha256, /^[0-9a-f]{64}$/);
    assert.match(old.source, /^git:60e075da382de6d6388f2320b0c95d374b0007ea:/);
    // The computed delta covers every path exactly once, equals the producer receipt's own claim, and the unchanged files are the outputs.
    const paths = f.provenance.pins.map((pin) => pin.path).sort();
    assert.deepEqual([...old.delta.changed, ...old.delta.unchanged].sort(), paths);
    assert.equal(old.deltaMatchesReceiptChangesFromEarlierCorpus, true);
    assert.equal(old.delta.changed.length, 40); assert.equal(old.delta.unchanged.length, 25);
    for (const name of ["output.pdf", "output.png", "output.svg"]) assert.ok(old.delta.unchanged.includes(`bundle/${name}`), name);
    for (const name of ["manifest.json", "detached.json", "lineage.json", "preflight.json", "archive.zip", "trusted-commitment.json"]) assert.ok(old.delta.changed.includes(`bundle/${name}`), name);
    assert.ok(old.delta.changed.includes("CORPUS.json"));
    // The in-tree superseded files are byte copies of the old artifact, recorded by digest, and are the OLD bundle.
    const dir = new URL("./fixtures/production-bundle/superseded/", import.meta.url);
    assert.deepEqual(old.keptFiles.map((kept) => kept.path), ["detached.json", "manifest.json", "trusted-commitment.json"]);
    for (const kept of old.keptFiles) {
      const bytes = new Uint8Array(readFileSync(new URL(kept.path, dir)));
      assert.equal(f.sha256Hex(bytes), kept.sha256, kept.path); assert.equal(bytes.length, kept.size);
    }
    const oldManifest = JSON.parse(readFileSync(new URL("manifest.json", dir), "utf8"));
    assert.equal(oldManifest.bundle_hash, old.bundle.hash); assert.equal(oldManifest.producer.source_revision, old.producerRevision);
    assert.notEqual(oldManifest.bundle_hash, f.BUNDLE_HASH);
  });

  // ---- anchor -----------------------------------------------------------------------------------------------
  define("anchor.resolved-only-from-scope-and-digest", async () => {
    const world = baselineWorld();
    const report = await runGate(world, { quote: undefined, envelopeBundle: { hostile: "x" } });
    assert.equal(report.verdict, "integrity_passed_blocked");
    assert.deepEqual(world.calls.resolve.map((call) => call.keys), ["bundleDigest,signal,trustedScope"]);
    assert.deepEqual(world.calls.resolve[0], { tenantId: f.SCOPE.tenantId, projectId: f.SCOPE.projectId, bundleDigest: f.BUNDLE_HASH, keys: "bundleDigest,signal,trustedScope" });
    for (const call of world.calls.read) assert.equal(call.keys, "byteHash,filename,maxLength,role,signal,trustedScope");
    // Another scope resolves nothing: the publication source is keyed by scope + digest and the consumer reads no bytes.
    const other = baselineWorld();
    const unpublished = await runGate(other, { trustedScope: { tenantId: f.SCOPE.tenantId, projectId: "123e4567-e89b-42d3-a456-0000000000ff" } });
    assert.equal(unpublished.verdict, "integrity_failed");
    assert.equal(criterion(unpublished, "anchor_resolution").code, "BUNDLE_UNPUBLISHED");
    assert.equal(other.calls.read.length, 0);
  });

  define("anchor.envelope-cannot-choose-anchor-hash-or-provenance", async () => {
    const reference = await runGate(baselineWorld());
    const hostile = {
      ...f.BUNDLE_REF, commitment: { length: 1, sha256: sha(enc("x")) }, anchor: { sha256: sha(enc("y")) }, provenance: { kind: "accepted" },
      expected: sha(enc("z")), policy: { critical: [] }
    };
    const world = baselineWorld();
    const report = await runGate(world, { envelopeBundle: hostile, expectedSha256: sha(enc("q")), anchor: { x: 1 }, provenance: { kind: "accepted" }, policy: { critical: [] } });
    assert.equal(report.reportDigest, reference.reportDigest);
    assert.equal(report.anchor.provenance.kind, "development_fixture");
    assert.equal(world.calls.resolve.length, 1);
    assert.equal(world.calls.resolve[0].keys, "bundleDigest,signal,trustedScope");
    // An owner-shaped reference that disagrees with the lookup digest fails before any port is touched.
    const mismatch = baselineWorld();
    const failed = await runGate(mismatch, { envelopeBundle: { ...f.BUNDLE_REF, content_hash: sha(enc("other")) } });
    assert.equal(criterion(failed, "anchor_resolution").code, "ENVELOPE_REFERENCE_MISMATCH");
    assert.equal(mismatch.calls.resolve.length + mismatch.calls.read.length, 0);
  });

  define("anchor.caller-supplied-anchor-object-rejected", async () => {
    const anchor = await issuedAnchor();
    const files = filesOf(f.baseline().files);
    const ok = validateFiles(files, anchor);
    assert.equal(ok.verdict, "integrity_passed_blocked");
    for (const forged of [{ ...anchor }, structuredClone({ ...anchor, commitment: anchor.commitment }), Object.create(anchor), JSON.parse(JSON.stringify(anchor))]) {
      const report = validateFiles(filesOf(f.baseline().files), forged);
      assert.equal(report.verdict, "integrity_failed");
      assert.equal(criterion(report, "anchor_resolution").code, "ANCHOR_NOT_ISSUED");
      assert.equal(criterion(report, "owner_integrity").state, "not_observed");
    }
    assert.equal(bundle.isIssuedTrustAnchor(anchor), true);
    assert.equal(bundle.isIssuedTrustAnchor({ ...anchor }), false);
  });

  define("anchor.hash-and-length-before-parse", async () => {
    const garbage = enc("{ this is not json");
    const pinOf = (bytes) => ({ length: bytes.length, sha256: sha(bytes) });
    // Matching pin + unparseable bytes: the hash passes and ONLY THEN does parsing fail.
    const parsed = baselineWorld();
    parsed.bundles.set(f.BUNDLE_HASH, { files: new Map(), commitmentBytes: garbage, pin: pinOf(garbage) });
    assert.equal(criterion(await runGate(parsed), "anchor_resolution").code, "COMMITMENT_PARSE_FAILED");
    // Wrong pin + the same unparseable bytes: the pin check fires first, so parsing never ran.
    const pinned = baselineWorld();
    pinned.bundles.set(f.BUNDLE_HASH, { files: new Map(), commitmentBytes: garbage, pin: { length: garbage.length, sha256: sha(enc("not the commitment")) } });
    pinned.hooks.read = async (request, dflt) => (request.role === "commitment" ? { status: "found", bytes: f.clone(garbage) } : dflt());
    assert.equal(criterion(await runGate(pinned), "anchor_resolution").code, "COMMITMENT_PIN_MISMATCH");
    // One byte of the real commitment flipped: same length, wrong hash.
    const flipped = baselineWorld();
    flipped.hooks.read = async (request, dflt) => {
      const result = await dflt();
      if (request.role === "commitment") result.bytes[10] ^= 1;
      return result;
    };
    assert.equal(criterion(await runGate(flipped), "anchor_resolution").code, "COMMITMENT_PIN_MISMATCH");
    // Different length: rejected on length before any hashing.
    const longer = baselineWorld();
    longer.hooks.read = async (request, dflt) => {
      const result = await dflt();
      return request.role === "commitment" ? { status: "found", bytes: new Uint8Array([...result.bytes, 32]) } : result;
    };
    assert.equal(criterion(await runGate(longer), "anchor_resolution").code, "SNAPSHOT_REJECTED");
    const shorter = baselineWorld();
    shorter.hooks.read = async (request, dflt) => {
      const result = await dflt();
      return request.role === "commitment" ? { status: "found", bytes: result.bytes.slice(0, -1) } : result;
    };
    assert.equal(criterion(await runGate(shorter), "anchor_resolution").code, "COMMITMENT_LENGTH_MISMATCH");
  });

  define("anchor.forged-eligibility-commitment-rejected-by-pin", async () => {
    const realText = new TextDecoder().decode(f.baseline().commitmentBytes);
    // Same byte length as the real commitment, so only the pin can tell them apart.
    const forgedText = realText.replace('"handoff_eligible": false', '"handoff_eligible": true ').replace('"state": "blocked"', '"state":"eligible"');
    assert.notEqual(forgedText, realText);
    assert.equal(forgedText.length, realText.length);
    const forgedBytes = enc(forgedText);
    assert.equal(JSON.parse(forgedText).eligibility.state, "eligible");
    const store = baselineWorld();
    store.hooks.read = async (request, dflt) => (request.role === "commitment" ? { status: "found", bytes: f.clone(forgedBytes) } : dflt());
    const rejected = await runGate(store);
    assert.equal(criterion(rejected, "anchor_resolution").code, "COMMITMENT_PIN_MISMATCH");
    assert.equal(store.calls.read.length, 1);
    // Even a host that pins the forged bytes cannot raise anything: the owner ignores the field and the report stays blocked.
    const pinned = f.createWorld();
    f.publishFromBaseline(pinned, f.baseline().files, forgedBytes);
    const report = await runGate(pinned);
    assert.equal(report.verdict, "integrity_passed_blocked");
    assert.equal(report.eligibility, "blocked"); assert.equal(report.handoffEligible, false); assert.equal(report.authorityIssued, false); assert.equal(report.accepted, false);
    assert.ok(report.openCriticalCodes.includes("OWNER_ACCEPTANCE_PENDING"));
    assert.equal(criterion(report, "owner_eligibility").state, "blocked");
  });

  define("anchor.superseded-commitment-and-manifest-cannot-bind-the-new-bundle", async () => {
    const dir = new URL("./fixtures/production-bundle/superseded/", import.meta.url);
    const oldFile = (name) => new Uint8Array(readFileSync(new URL(name, dir)));
    const oldCommitment = oldFile("trusted-commitment.json");
    const pinOf = (bytes) => ({ length: bytes.length, sha256: sha(bytes) });
    assert.equal(oldCommitment.length, f.baseline().commitmentBytes.length, "same length, so only the pin can tell the two commitments apart");
    // (a) The host pins the NEW commitment but the byte store serves the OLD one: rejected by the pin, before parsing.
    const swapped = baselineWorld();
    swapped.hooks.read = async (request, dflt) => (request.role === "commitment" ? { status: "found", bytes: f.clone(oldCommitment) } : dflt());
    assert.equal(criterion(await runGate(swapped), "anchor_resolution").code, "COMMITMENT_PIN_MISMATCH");
    // (b) The host (wrongly) pins the OLD commitment under the NEW digest: the commitment's own bundle_ref disagrees with the lookup digest.
    const crossed = f.createWorld();
    crossed.bundles.set(f.BUNDLE_HASH, { files: f.baseline().files, commitmentBytes: oldCommitment, pin: pinOf(oldCommitment) });
    const crossedReport = await runGate(crossed);
    assert.equal(criterion(crossedReport, "anchor_resolution").code, "COMMITMENT_BUNDLE_MISMATCH");
    assert.equal(crossed.calls.read.length, 1);
    // (c) Asking for the OLD bundle hash against a host that only published the new bundle resolves nothing.
    const oldDigest = f.provenance.supersedes.bundle.hash;
    const unpublished = baselineWorld();
    const lookup = await runGate(unpublished, { bundleDigest: oldDigest });
    assert.equal(criterion(lookup, "anchor_resolution").code, "BUNDLE_UNPUBLISHED"); assert.equal(unpublished.calls.read.length, 0);
    // (d) An envelope that names the old bundle while the command digest names the new one is refused before any port.
    const mismatch = baselineWorld();
    const refused = await runGate(mismatch, { envelopeBundle: { ...f.BUNDLE_REF, content_hash: oldDigest } });
    assert.equal(criterion(refused, "anchor_resolution").code, "ENVELOPE_REFERENCE_MISMATCH"); assert.equal(mismatch.calls.resolve.length, 0);
    // (e) Under the NEW anchor, the OLD manifest and OLD detached file (same lengths) are caught as integrity failures and named.
    const anchor = await issuedAnchor();
    for (const name of ["manifest.json", "detached.json"]) {
      const files = f.baseline().files; files.set(name, oldFile(name));
      assert.equal(files.get(name).length, f.baseline().files.get(name).length);
      const report = validateFiles(filesOf(files), anchor);
      assert.equal(report.verdict, "integrity_failed", name); assert.equal(criterion(report, "owner_integrity").state, "failed", name);
      assert.deepEqual(report.diagnostic.attribution.problems, [`hash-mismatch:${name}`], name);
      assert.equal(report.unchanged, true);
    }
    // (f) The control: the new bundle through the new anchor still passes.
    assert.equal((await runGate(baselineWorld())).verdict, "integrity_passed_blocked");
  });

  define("anchor.unpublished-fails", async () => {
    const world = f.createWorld();
    const report = await runGate(world);
    assert.equal(report.verdict, "integrity_failed");
    assert.equal(criterion(report, "anchor_resolution").code, "BUNDLE_UNPUBLISHED");
    assert.equal(report.anchor, null); assert.equal(report.bundle, null);
    assert.equal(world.calls.read.length, 0);
    for (const bad of ["not-a-digest", "sha256:abc", ""]) {
      const fresh = baselineWorld();
      const failed = await runGate(fresh, { bundleDigest: bad });
      assert.equal(criterion(failed, "anchor_resolution").code, "BUNDLE_DIGEST_INVALID");
      assert.equal(fresh.calls.resolve.length, 0);
    }
  });

  define("anchor.digest-mismatch-fails", async () => {
    const lying = baselineWorld();
    lying.hooks.resolve = async (request, dflt) => ({ ...(await dflt()), bundleDigest: sha(enc("someone else")) });
    assert.equal(criterion(await runGate(lying), "anchor_resolution").code, "PUBLICATION_DIGEST_MISMATCH");
    // A pinned commitment whose own bundle_ref disagrees with the requested digest.
    const other = structuredClone(f.baselineCommitment);
    other.bundle_ref.content_hash = sha(enc("different bundle"));
    const otherBytes = enc(`${JSON.stringify(other, null, 2)}\n`);
    const mismatched = f.createWorld();
    f.publishFromBaseline(mismatched, f.baseline().files, otherBytes, f.BUNDLE_HASH);
    const report = await runGate(mismatched);
    assert.equal(criterion(report, "anchor_resolution").code, "COMMITMENT_BUNDLE_MISMATCH");
    assert.equal(mismatched.calls.read.length, 1);
  });

  define("anchor.provenance-development-fixture-upgrades-nothing", async () => {
    const report = await runGate(baselineWorld());
    assert.equal(report.anchor.provenance.kind, "development_fixture");
    for (const item of report.criteria.filter((entry) => entry.critical && entry.state !== "failed")) {
      if (["anchor_resolution", "byte_custody", "owner_integrity", "observed_geometry_consistency"].includes(item.id)) continue;
      assert.ok(!item.state.startsWith("verified"), `${item.id} must not be verified by a fixture anchor`);
    }
    const accepted = baselineWorld();
    accepted.hooks.resolve = async (request, dflt) => ({ ...(await dflt()), provenance: { kind: "accepted", digest: f.FIXTURE_PROVENANCE_DIGEST } });
    assert.equal(criterion(await runGate(accepted), "anchor_resolution").code, "PUBLICATION_RESULT_INVALID");
    const unsigned = baselineWorld();
    unsigned.hooks.resolve = async (request, dflt) => ({ ...(await dflt()), provenance: { kind: "development_fixture", digest: "nope" } });
    assert.equal(criterion(await runGate(unsigned), "anchor_resolution").code, "PUBLICATION_PIN_INVALID");
  });

  define("anchor.corpus-control-inventory-crosscheck-only", async () => {
    // The consumer never loads CORPUS.json. A host that publishes a DIFFERENT commitment serialization is resolved by its own pin,
    // whatever CORPUS.control_inventory says.
    const recommitted = f.recommit();
    const world = f.createWorld();
    f.publishFromBaseline(world, recommitted.files, recommitted.commitmentBytes, recommitted.bundleHash);
    assert.notEqual(recommitted.pin.sha256, f.corpus.control_inventory[0].sha256);
    const report = await runGate(world, { bundleDigest: recommitted.bundleHash });
    assert.equal(report.verdict, "integrity_passed_blocked");
    assert.equal(report.anchor.commitmentSha256, recommitted.pin.sha256);
    for (const file of ["production-bundle.ts", "production-bundle-contract.ts", "production-bundle-owner.ts"]) {
      const code = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      assert.ok(!code.includes("CORPUS"), `${file}: no code path reads CORPUS`);
    }
  });

  define("anchor.control-json-cap-is-consumer-resource-bound-and-parse-overflow-mapped", async () => {
    const cap = ownerWrapper.ownerLimits().manifestBytes;
    for (const length of [cap + 1, 0, -1, 1.5]) {
      const world = baselineWorld();
      world.hooks.resolve = async (request, dflt) => { const published = await dflt(); return { ...published, commitment: { ...published.commitment, length } }; };
      const report = await runGate(world);
      assert.equal(criterion(report, "anchor_resolution").code, "PUBLICATION_PIN_INVALID", String(length));
      assert.equal(world.calls.read.length, 0);
    }
    // Deeply nested JSON inside the cap: parsed or rejected, but never thrown out of the gate.
    const depth = 1_000_000;
    const deep = enc(`{"contract":"ProductionBundleRef","x":${"[".repeat(depth)}${"]".repeat(depth)}}`);
    assert.ok(deep.length <= cap);
    const world = f.createWorld();
    world.bundles.set(f.BUNDLE_HASH, { files: new Map(), commitmentBytes: deep, pin: { length: deep.length, sha256: sha(deep) } });
    const report = await runGate(world);
    assert.equal(report.verdict, "integrity_failed");
    assert.match(criterion(report, "anchor_resolution").code, /^(COMMITMENT_PARSE_FAILED|OWNER_[A-Z_]+)$/);
    const source = readFileSync(new URL("../src/production-bundle.ts", import.meta.url), "utf8");
    assert.match(source, /CONSUMER resource bound borrowed from the owner's manifest ceiling; it is not an owner\/canonical rule/);
  });

  // ---- bytes ------------------------------------------------------------------------------------------------
  define("bytes.content-addressed-read-uses-owner-byte-hash", async () => {
    const world = baselineWorld();
    await runGate(world);
    const [commitmentRead, ...fileReads] = world.calls.read;
    assert.equal(commitmentRead.role, "commitment");
    assert.equal(commitmentRead.byteHash, sha(f.baseline().commitmentBytes));
    assert.equal(fileReads.length, 8);
    for (const read of fileReads) {
      const descriptor = f.baselineCommitment.file_set.find((entry) => entry.filename === read.filename);
      assert.ok(descriptor, read.filename);
      assert.equal(read.role, "file"); assert.equal(read.byteHash, descriptor.byte_hash);
    }
    assert.deepEqual(fileReads.map((read) => read.filename).sort(), [...f.BASELINE_NAMES].sort());
  });

  define("bytes.maxlength-honored-and-wrong-length-rejected-before-hash", async () => {
    const world = baselineWorld();
    await runGate(world);
    for (const read of world.calls.read.filter((entry) => entry.role === "file")) {
      assert.equal(read.maxLength, f.baselineCommitment.file_set.find((entry) => entry.filename === read.filename).byte_size);
    }
    assert.equal(world.calls.read[0].maxLength, f.baseline().commitmentBytes.length);
    const longer = baselineWorld();
    longer.hooks.read = async (request, dflt) => {
      const result = await dflt();
      return request.filename === "output.png" ? { status: "found", bytes: new Uint8Array([...result.bytes, 0]) } : result;
    };
    const report = await runGate(longer);
    assert.equal(criterion(report, "byte_custody").code, "BYTE_LENGTH_MISMATCH");
    assert.equal(criterion(report, "owner_integrity").state, "not_observed");
    assert.deepEqual(report.owner.codes, []);
    assert.deepEqual(report.diagnostic.attribution.problems, ["length-mismatch:output.png"]);
  });

  define("bytes.missing-file-fails", async () => {
    const world = baselineWorld();
    world.hooks.read = async (request, dflt) => (request.filename === "lineage.json" ? { status: "missing" } : dflt());
    const report = await runGate(world);
    assert.equal(report.verdict, "integrity_failed");
    assert.equal(criterion(report, "byte_custody").code, "BYTE_MISSING");
    assert.equal(criterion(report, "owner_integrity").state, "not_observed");
    assert.deepEqual(report.diagnostic.attribution.problems, ["missing:lineage.json"]);
  });

  define("bytes.extra-file-fails", async () => {
    const anchor = await issuedAnchor();
    const files = filesOf(f.baseline().files); files.push({ filename: "extra.bin", bytes: f.clone(f.EXTRA_BIN) });
    const report = validateFiles(files, anchor);
    assert.equal(report.verdict, "integrity_failed");
    assert.equal(criterion(report, "owner_integrity").state, "failed");
    assert.deepEqual(report.diagnostic.attribution.problems, ["extra:extra.bin"]);
    // Through the host byte source an unanchored name is simply never requested.
    const world = baselineWorld(); world.bundles.get(f.BUNDLE_HASH).files.set("extra.bin", f.clone(f.EXTRA_BIN));
    const gated = await runGate(world);
    assert.equal(gated.verdict, "integrity_passed_blocked");
    assert.ok(!world.calls.read.some((read) => read.filename === "extra.bin"));
  });

  define("bytes.store-throw-fails-closed", async () => {
    const reading = baselineWorld();
    reading.hooks.read = async (request, dflt) => { if (request.filename === "output.svg") throw new Error("store down"); return dflt(); };
    const a = await runGate(reading);
    assert.equal(criterion(a, "byte_custody").code, "BYTE_SOURCE_FAILED"); assert.equal(a.verdict, "integrity_failed");
    const resolving = baselineWorld();
    resolving.hooks.resolve = async () => { throw new Error("publication down"); };
    assert.equal(criterion(await runGate(resolving), "anchor_resolution").code, "PUBLICATION_SOURCE_FAILED");
    const commitment = baselineWorld();
    commitment.hooks.read = async (request, dflt) => { if (request.role === "commitment") throw new Error("down"); return dflt(); };
    assert.equal(criterion(await runGate(commitment), "anchor_resolution").code, "BYTE_SOURCE_FAILED");
    const malformed = baselineWorld();
    malformed.hooks.read = async (request, dflt) => (request.filename === "output.pdf" ? "not a result" : dflt());
    assert.equal(criterion(await runGate(malformed), "byte_custody").code, "SNAPSHOT_REJECTED");
  });

  // ---- owner ------------------------------------------------------------------------------------------------
  const expectedProblems = (id) => f.corpus.variants.find((variant) => variant.id === id).expectedProblems;

  define("owner.valid-integrity-passed-eligibility-blocked", async () => {
    assert.deepEqual(f.ownerVerifyDirect(f.baseline().files, f.baselineCommitment), { ok: true, integrity: "passed", eligibility: "blocked" });
    const anchor = await issuedAnchor();
    const report = validateFiles(filesOf(f.baseline().files), anchor);
    assert.equal(report.verdict, "integrity_passed_blocked");
    assert.equal(criterion(report, "owner_integrity").state, "verified_owner");
    assert.deepEqual(report.owner, { package: "@jevelopers/shared-contracts", version: "0.9.7", archiveSha256: contract.OWNER_PACKAGE_PIN.archiveSha256, integrity: contract.OWNER_PACKAGE_PIN.integrity, accepted: false, codes: [] });
    assert.equal(criterion(report, "owner_eligibility").code, "OWNER_ACCEPTANCE_PENDING");
    assert.equal(report.unchanged, true);
  });

  for (const [caseId, variantId] of [["owner.tampered-payload", "tampered-payload"], ["owner.tampered-manifest", "tampered-manifest"], ["owner.tampered-detached", "tampered-detached"],
    ["owner.missing-payload", "missing-payload"], ["owner.missing-manifest", "missing-manifest"], ["owner.extra-file", "extra-file"]]) {
    define(caseId, async () => {
      const anchor = await issuedAnchor();
      const files = f.deriveVariant(variantId);
      assert.deepEqual(f.ownerVerifyDirect(files, f.baselineCommitment), { ok: false, code: "INTEGRITY_FAILURE" });
      const report = validateFiles(filesOf(files), anchor);
      assert.equal(report.verdict, "integrity_failed");
      assert.equal(criterion(report, "owner_integrity").state, "failed");
      assert.deepEqual(report.owner.codes, ["INTEGRITY_FAILURE"]);
      // The sealed attribution uses the producer's own vocabulary and matches its recorded expectation for the same variant.
      assert.deepEqual(report.diagnostic.attribution.problems, expectedProblems(variantId));
      assert.equal(report.diagnostic.attribution.authoritative, false);
      assert.equal(report.unchanged, true, "owner failure must not mutate the private copies");
      // Through the host byte source (a lying store serves the variant bytes under the anchored names).
      const world = baselineWorld();
      const store = world.bundles.get(f.BUNDLE_HASH).files;
      for (const name of [...store.keys()]) if (!files.has(name)) store.delete(name);
      for (const [name, bytes] of files) if (store.has(name)) store.set(name, bytes);
      const gated = await runGate(world);
      if (variantId === "extra-file") assert.equal(gated.verdict, "integrity_passed_blocked");
      else {
        assert.equal(gated.verdict, "integrity_failed");
        assert.deepEqual(gated.diagnostic.attribution.problems, expectedProblems(variantId));
      }
    });
  }

  define("owner.flip-and-truncate-each-of-8-files", async () => {
    const anchor = await issuedAnchor();
    for (const name of f.BASELINE_NAMES) {
      const flipped = f.baseline().files; const bytes = flipped.get(name); bytes[bytes.length >> 1] ^= 0x55;
      const a = validateFiles(filesOf(flipped), anchor);
      assert.equal(a.verdict, "integrity_failed", `flip ${name}`);
      assert.deepEqual(a.diagnostic.attribution.problems, [`hash-mismatch:${name}`], `flip ${name}`);
      assert.ok(a.owner.codes.length > 0 || criterion(a, "byte_custody").state === "failed");
      const truncated = f.baseline().files; truncated.set(name, truncated.get(name).slice(0, -1));
      const b = validateFiles(filesOf(truncated), anchor);
      assert.equal(b.verdict, "integrity_failed", `truncate ${name}`);
      assert.deepEqual(b.diagnostic.attribution.problems, [`length-mismatch:${name}`], `truncate ${name}`);
    }
  });

  define("owner.colliding-traversal-duplicate-names", async () => {
    const anchor = await issuedAnchor();
    const cases = {
      caseCollision: [...filesOf(f.baseline().files), { filename: "OUTPUT.PNG", bytes: f.clone(f.baseline().files.get("output.png")) }],
      traversal: [...filesOf(f.baseline().files).filter((file) => file.filename !== "lineage.json"), { filename: "../lineage.json", bytes: f.clone(f.baseline().files.get("lineage.json")) }],
      duplicate: [...filesOf(f.baseline().files), { filename: "output.png", bytes: f.clone(f.baseline().files.get("output.png")) }]
    };
    // Independent of the consumer's own pre-copy pass: the OWNER itself rejects each of the three lists.
    for (const [label, files] of Object.entries(cases)) {
      const direct = ownerWrapper.ownerVerifyBundle(files, f.baselineCommitment, ownerWrapper.toOwnerScope(f.SCOPE));
      assert.equal(direct.ok, false, `${label}: the owner verifier rejects it directly`);
    }
    for (const [label, files] of Object.entries(cases)) {
      const report = validateFiles(files, anchor);
      assert.equal(report.verdict, "integrity_failed", label);
      if (label === "traversal") {
        assert.equal(criterion(report, "owner_integrity").state, "failed", label);
      } else {
        // A case-insensitive duplicate name is now refused by the no-copy first pass, before anything is copied or handed to the owner.
        assert.equal(criterion(report, "byte_custody").code, "SNAPSHOT_REJECTED", label);
        assert.ok(report.diagnostic.reasons.includes("SNAPSHOT_DUPLICATE_FILENAME"), label);
        assert.equal(criterion(report, "owner_integrity").state, "not_observed", label);
      }
    }
    const traversal = validateFiles(cases.traversal, anchor);
    assert.ok(traversal.diagnostic.attribution.problems.includes("extra:unsafe-name"));
    assert.ok(traversal.diagnostic.attribution.problems.includes("missing:lineage.json"));
  });

  define("owner.scope-snake-case-mapping", async () => {
    assert.deepEqual(ownerWrapper.toOwnerScope({ tenantId: "t", projectId: "p" }), { tenant_id: "t", project_id: "p" });
    // The owner rejects the runtime's camelCase scope: that is why the explicit mapper is mandatory.
    const owner = await import("@jevelopers/shared-contracts/production-operations");
    const direct = owner.verifyProductionBundleFiles(filesOf(f.baseline().files), { trusted_commitment: f.baselineCommitment, scope: { tenantId: f.SCOPE.tenantId, projectId: f.SCOPE.projectId } });
    assert.equal(direct.ok, false); assert.equal(direct.errors[0].code, "NOT_FOUND");
    const report = await runGate(baselineWorld());
    assert.equal(report.verdict, "integrity_passed_blocked");
  });

  define("owner.wrong-scope", async () => {
    const other = { tenantId: f.SCOPE.tenantId, projectId: "123e4567-e89b-42d3-a456-0000000000ff" };
    const world = f.createWorld({ ignoreScope: true });
    f.publishFromBaseline(world);
    const report = await runGate(world, { trustedScope: other });
    assert.equal(report.verdict, "integrity_failed");
    assert.equal(criterion(report, "anchor_resolution").state, "verified_local", "pre-validation is structural and does not check scope");
    assert.equal(criterion(report, "owner_integrity").state, "failed");
    assert.deepEqual(report.owner.codes, ["NOT_FOUND"]);
    assert.equal(report.diagnostic.attribution, "unattributed");
  });

  define("owner.commitment-in-file-list-rejected", async () => {
    const anchor = await issuedAnchor();
    const files = [...filesOf(f.baseline().files), { filename: "trusted-commitment.json", bytes: f.clone(f.baseline().commitmentBytes) }];
    const report = validateFiles(files, anchor);
    assert.equal(report.verdict, "integrity_failed");
    assert.equal(criterion(report, "owner_integrity").state, "failed");
    assert.ok(report.diagnostic.attribution.problems.includes("extra:trusted-commitment.json"));
  });

  define("owner.commitment-prevalidated-before-any-budget-read", async () => {
    const mutations = {
      fileSetNotArray: (ref) => { ref.file_set = "x"; },
      byteSizeString: (ref) => { ref.file_set[0].byte_size = "766686"; },
      byteSizeHuge: (ref) => { ref.file_set[0].byte_size = 2 ** 53; },
      wrongContract: (ref) => { ref.contract = "ProductionBundle"; }
    };
    for (const [label, mutate] of Object.entries(mutations)) {
      const ref = structuredClone(f.baselineCommitment); mutate(ref);
      const bytes = enc(JSON.stringify(ref));
      const world = f.createWorld();
      world.bundles.set(f.BUNDLE_HASH, { files: new Map(), commitmentBytes: bytes, pin: { length: bytes.length, sha256: sha(bytes) } });
      const report = await runGate(world);
      const code = criterion(report, "anchor_resolution").code;
      assert.match(code, /^OWNER_/, `${label}: ${code}`);
      assert.equal(world.calls.read.length, 1, `${label}: no payload read after a failed pre-validation`);
    }
  });

  define("owner.commitment-prevalidation-structural-not-scope", () => {
    const wrongScope = ownerWrapper.toOwnerScope({ tenantId: f.SCOPE.tenantId, projectId: "123e4567-e89b-42d3-a456-0000000000ff" });
    const camel = { tenantId: f.SCOPE.tenantId, projectId: f.SCOPE.projectId };
    assert.equal(ownerWrapper.ownerPreValidateCommitment(f.baselineCommitment, wrongScope).ok, true, "pre-validation does not check scope");
    assert.equal(ownerWrapper.ownerPreValidateCommitment(f.baselineCommitment, camel).ok, true);
    const verdict = ownerWrapper.ownerVerifyBundle(filesOf(f.baseline().files), f.baselineCommitment, wrongScope);
    assert.deepEqual(verdict, { ok: false, codes: ["NOT_FOUND"] });
    assert.equal(ownerWrapper.ownerVerifyBundle(filesOf(f.baseline().files), f.baselineCommitment, ownerWrapper.toOwnerScope(f.SCOPE)).ok, true);
  });

  define("owner.all-owner-throws-caught-typed", () => {
    const scope = ownerWrapper.toOwnerScope(f.SCOPE);
    const hostile = new Proxy({}, { get() { throw new Error("boom"); }, ownKeys() { throw new Error("boom"); }, getPrototypeOf() { throw new Error("boom"); } });
    assert.deepEqual(ownerWrapper.ownerVerifyBundle(filesOf(f.baseline().files), hostile, scope), { ok: false, codes: ["OWNER_THREW"] });
    assert.deepEqual(ownerWrapper.ownerVerifyBundle(new Proxy([], { get() { throw new Error("boom"); } }), f.baselineCommitment, scope), { ok: false, codes: ["OWNER_THREW"] });
    assert.deepEqual(ownerWrapper.ownerVerifyBundle([{ filename: "manifest.json", get bytes() { throw new Error("boom"); } }], f.baselineCommitment, scope), { ok: false, codes: ["OWNER_THREW"] });
    assert.deepEqual(ownerWrapper.ownerPreValidateCommitment(hostile, scope).ok, false);
    assert.equal(ownerWrapper.ownerSafeFilename({ toString() { throw new Error("boom"); } }), false);
  });

  // ---- attribution ------------------------------------------------------------------------------------------
  define("attribution.only-after-owner-failure", async () => {
    const anchor = await issuedAnchor();
    const pass = validateFiles(filesOf(f.baseline().files), anchor);
    assert.equal(pass.diagnostic?.attribution, undefined);
    const fail = validateFiles(filesOf(f.deriveVariant("tampered-payload")), anchor);
    assert.ok(fail.diagnostic.attribution);
    const unreached = baselineWorld();
    unreached.hooks.resolve = async () => ({ status: "unpublished" });
    assert.equal((await runGate(unreached)).diagnostic?.attribution, undefined, "no anchored roster, no attribution");
  });

  define("attribution.names-file-from-anchored-file-set", async () => {
    const anchor = await issuedAnchor();
    for (const id of ["tampered-payload", "tampered-manifest", "tampered-detached", "missing-payload", "missing-manifest", "extra-file"]) {
      const report = validateFiles(filesOf(f.deriveVariant(id)), anchor);
      assert.deepEqual(report.diagnostic.attribution.problems, expectedProblems(id), id);
    }
    const two = f.baseline().files; two.get("output.svg")[3] ^= 1; two.delete("preflight.json");
    const report = validateFiles(filesOf(two), anchor);
    assert.deepEqual([...report.diagnostic.attribution.problems].sort(), ["hash-mismatch:output.svg", "missing:preflight.json"]);
  });

  define("attribution.unattributed-when-hashes-agree", async () => {
    // A ZIP that does not verify but whose whole-file bytes agree with the anchored descriptor: roster and hashes agree.
    const garbageArchive = enc("not a zip but committed as one");
    const recommitted = f.recommit({ archiveBytes: garbageArchive });
    const world = f.createWorld();
    f.publishFromBaseline(world, recommitted.files, recommitted.commitmentBytes, recommitted.bundleHash);
    const report = await runGate(world, { bundleDigest: recommitted.bundleHash });
    assert.equal(report.verdict, "integrity_failed");
    assert.equal(criterion(report, "owner_integrity").state, "failed");
    assert.equal(report.diagnostic.attribution, "unattributed");
  });

  define("attribution.absent-on-pass", async () => {
    const report = await runGate(baselineWorld());
    assert.equal(report.verdict, "integrity_passed_blocked");
    assert.ok(report.diagnostic === undefined || report.diagnostic.attribution === undefined);
    assert.equal(JSON.stringify(report).includes("attribution"), false);
  });

  define("attribution.removal-changes-no-verdict", async () => {
    const anchor = await issuedAnchor();
    const report = validateFiles(filesOf(f.deriveVariant("tampered-payload")), anchor);
    const stripped = structuredClone(report);
    delete stripped.diagnostic.attribution;
    if (Object.keys(stripped.diagnostic).length === 0) delete stripped.diagnostic;
    stripped.reportDigest = contract.computeReportDigest(stripped);
    const validated = contract.validateGateReport(stripped, { bundleDigest: f.BUNDLE_HASH });
    assert.equal(validated.ok, true);
    assert.equal(validated.report.verdict, report.verdict);
    assert.deepEqual(validated.report.criteria, report.criteria);
    assert.deepEqual(validated.report.openCriticalCodes, report.openCriticalCodes);
    assert.deepEqual(validated.report.owner.codes, report.owner.codes);
    // Rewriting the attribution to claim another file changes nothing about the verdict either.
    const rewritten = structuredClone(report);
    rewritten.diagnostic.attribution = { authoritative: false, problems: ["missing:output.png"] };
    rewritten.reportDigest = contract.computeReportDigest(rewritten);
    const again = contract.validateGateReport(rewritten, { bundleDigest: f.BUNDLE_HASH });
    assert.equal(again.ok, true); assert.equal(again.report.verdict, "integrity_failed");
  });

  define("attribution.never-parses-manifest-zip-detached", () => {
    const descriptors = f.baselineCommitment.file_set.map((entry) => ({ filename: entry.filename, role: entry.role, byteSize: entry.byte_size, byteHash: entry.byte_hash, cap: entry.byte_size }));
    // Garbage that no parser could accept, but the sizes and hashes of which agree with the descriptors: nothing to attribute.
    const files = f.baselineCommitment.file_set.map((entry) => ({ filename: entry.filename, bytes: f.baseline().files.get(entry.filename) }));
    assert.equal(bundle.attributeFailure(descriptors, files), "unattributed");
    const garbageManifest = files.map((file) => file.filename === "manifest.json" ? { filename: file.filename, bytes: new Uint8Array(file.bytes.length).fill(0x7b) } : file);
    assert.deepEqual(bundle.attributeFailure(descriptors, garbageManifest).problems, ["hash-mismatch:manifest.json"]);
    const source = readFileSync(new URL("../src/production-bundle.ts", import.meta.url), "utf8");
    const body = source.slice(source.indexOf("export function attributeFailure"), source.indexOf("// 6. Evaluation and report building"));
    assert.ok(!/JSON\.parse|TextDecoder|inflate|zlib|verifyProductionZip|parseProductionCanonicalBytes/.test(body), "attribution must not parse the manifest, ZIP or detached file");
  });
}
