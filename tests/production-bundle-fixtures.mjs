// SIMULATED ONLY. Fixtures for the ProductionBundle consumer suite.
// Real bytes: the print-production Linux corpus (run 38216826905, artifact 11733229451) at 01a7b13. Synthetic, unaccepted,
// (It supersedes the earlier run 38205370188 / artifact 11727293834 at 300f997, recorded in provenance.json `supersedes`.)
// handoffEligible:false. Nothing here is an approved bundle, an authority, or a production publication record.
//
// Test-only helpers in this file (NOT production code and never importable from src/):
//  - deriveVariant(): builds the producer's variants in memory from the baseline;
//  - recommit(): builds a fully re-committed synthetic bundle using ONLY owner-exported helpers
//    (canonicalJson / hashBytes / productionBundleContentHash / productionPayloadSetHash) plus a stored-ZIP writer;
//  - createWorld(): fixture implementations of the host publication source and byte source, with call logs and hooks.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { crc32 } from "node:zlib";
import { FulfillmentConnectorRuntime } from "../dist/index.js";
import { createProductionBundleGate } from "../dist/production-bundle.js";
import { simulatorQuoteTermsFingerprint } from "../dist/simulator.js";
import { MOCK_AUTHORIZATION, createMockHarness, envelope, makeQuoteCommand } from "./mock-fixtures.mjs";

export const FIXTURE_DIR = new URL("./fixtures/production-bundle/", import.meta.url);
const read = (relative) => new Uint8Array(readFileSync(new URL(relative, FIXTURE_DIR)));
const enc = (text) => new TextEncoder().encode(text);
export const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const sha256Tagged = (bytes) => `sha256:${sha256Hex(bytes)}`;

export const BASELINE_NAMES = Object.freeze(["archive.zip", "detached.json", "lineage.json", "manifest.json", "output.pdf", "output.png", "output.svg", "preflight.json"]);
export const FIXTURE_PROVENANCE_DIGEST = sha256Tagged(enc("fixture-publication-port/development_fixture"));

const owner = await import("@jevelopers/shared-contracts/production-operations");
const ownerRoot = await import("@jevelopers/shared-contracts");

export const provenance = JSON.parse(new TextDecoder().decode(read("provenance.json")));
export const corpus = JSON.parse(new TextDecoder().decode(read("CORPUS.json")));

const baselineFiles = new Map(BASELINE_NAMES.map((name) => [name, read(`baseline/${name}`)]));
const commitmentBytes = read("control/trusted-commitment.json");
export const baselineManifest = JSON.parse(new TextDecoder().decode(baselineFiles.get("manifest.json")));
export const baselineCommitment = JSON.parse(new TextDecoder().decode(commitmentBytes));
export const BUNDLE_HASH = baselineCommitment.bundle_ref.content_hash;
export const SCOPE = Object.freeze({ tenantId: baselineManifest.tenant_id, projectId: baselineManifest.project_id });
export const OWNER_SCOPE = Object.freeze({ tenant_id: baselineManifest.tenant_id, project_id: baselineManifest.project_id });
export const BUNDLE_REF = Object.freeze({
  contract: "ProductionBundle", schema_version: "2.0.0", id: baselineCommitment.bundle_ref.id,
  revision: baselineCommitment.bundle_ref.revision, content_hash: BUNDLE_HASH
});
export const clone = (bytes) => new Uint8Array(bytes);
export const frozenClock = Object.freeze({ now: () => 1_760_000_000_000 });

/** Fresh copies of the committed baseline each call, so a test can never contaminate another. */
export function baseline() {
  return {
    files: new Map([...baselineFiles].map(([name, bytes]) => [name, clone(bytes)])),
    commitmentBytes: clone(commitmentBytes),
    manifest: structuredClone(baselineManifest),
    commitment: structuredClone(baselineCommitment),
    corpusBytes: read("CORPUS.json")
  };
}

const flipLast = (bytes) => { const out = clone(bytes); out[out.length - 1] ^= 1; return out; };
export const EXTRA_BIN = enc("pp16-extra");

/** The producer's variants, rebuilt in memory from the baseline with the producer's documented mutations. */
export function deriveVariant(id) {
  const files = new Map([...baseline().files]);
  switch (id) {
    case "valid": break;
    case "tampered-payload": files.set("lineage.json", flipLast(files.get("lineage.json"))); break;
    case "tampered-manifest": files.set("manifest.json", flipLast(files.get("manifest.json"))); break;
    case "tampered-detached": files.set("detached.json", flipLast(files.get("detached.json"))); break;
    case "missing-payload": files.delete("lineage.json"); break;
    case "missing-manifest": files.delete("manifest.json"); break;
    case "extra-file": files.set("extra.bin", clone(EXTRA_BIN)); break;
    default: throw new Error(`unknown variant ${id}`);
  }
  return files;
}
export const VARIANT_IDS = Object.freeze(["valid", "tampered-payload", "tampered-manifest", "tampered-detached", "missing-payload", "missing-manifest", "extra-file"]);

// ---------------------------------------------------------------------------------------------------------
// Test-only stored-ZIP writer + owner-helper-only re-commit
// ---------------------------------------------------------------------------------------------------------

export function storedZip(entries) {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const locals = []; const centrals = []; let offset = 0;
  for (const { name, bytes } of sorted) {
    const nb = Buffer.from(name, "ascii"); const crc = crc32(bytes);
    const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(0, 6); l.writeUInt16LE(0, 8); l.writeUInt16LE(0, 10); l.writeUInt16LE(0x2821, 12);
    l.writeUInt32LE(crc, 14); l.writeUInt32LE(bytes.length, 18); l.writeUInt32LE(bytes.length, 22); l.writeUInt16LE(nb.length, 26); l.writeUInt16LE(0, 28);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(0x0314, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0, 8); c.writeUInt16LE(0, 10); c.writeUInt16LE(0, 12); c.writeUInt16LE(0x2821, 14);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(bytes.length, 20); c.writeUInt32LE(bytes.length, 24); c.writeUInt16LE(nb.length, 28); c.writeUInt16LE(0, 30); c.writeUInt16LE(0, 32); c.writeUInt16LE(0, 34); c.writeUInt16LE(0, 36); c.writeUInt32LE(0x81a40000, 38); c.writeUInt32LE(offset, 42);
    locals.push(l, nb, Buffer.from(bytes)); centrals.push(Buffer.concat([c, nb])); offset += 30 + nb.length + bytes.length;
  }
  const cd = Buffer.concat(centrals); const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(sorted.length, 8); e.writeUInt16LE(sorted.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, e]));
}

/**
 * Builds a complete, self-consistent synthetic bundle after applying `mutate`: every hash comes from owner helpers.
 * `mutate.payload` replaces payload bytes; `mutate.manifest(manifest)` edits declared descriptors before re-hashing.
 */
export function recommit(mutate = {}) {
  const base = baseline();
  const payload = Object.fromEntries(["output.svg", "output.png", "output.pdf", "preflight.json", "lineage.json"].map((name) => [name, base.files.get(name)]));
  const detached0 = JSON.parse(new TextDecoder().decode(base.files.get("detached.json")));
  const manifest = structuredClone(base.manifest);
  for (const [name, bytes] of Object.entries(mutate.payload ?? {})) payload[name] = bytes;
  for (const file of manifest.files) { file.byte_hash = ownerRoot.hashBytes(payload[file.filename]); file.byte_size = payload[file.filename].length; }
  if (mutate.manifest) mutate.manifest(manifest);
  manifest.composition.render_hash = manifest.files.find((file) => file.filename === "output.svg").byte_hash;
  manifest.lineage_ref = { ...manifest.lineage_ref, content_hash: manifest.files.find((file) => file.role === "lineage").byte_hash };
  manifest.bundle_hash = owner.productionBundleContentHash(manifest);
  const manifestBytes = enc(ownerRoot.canonicalJson(manifest));
  const manifestDescriptor = { ...detached0.manifest, byte_hash: ownerRoot.hashBytes(manifestBytes), byte_size: manifestBytes.length };
  const zipBytes = mutate.archiveBytes ?? storedZip([...Object.entries(payload).map(([name, bytes]) => ({ name, bytes })), { name: "manifest.json", bytes: manifestBytes }]);
  const archiveDescriptor = { ...detached0.archive, byte_hash: ownerRoot.hashBytes(zipBytes), byte_size: zipBytes.length };
  const detached = {
    ...detached0, bundle_ref: { ...detached0.bundle_ref, content_hash: manifest.bundle_hash }, manifest: manifestDescriptor, archive: archiveDescriptor,
    lineage_hash: manifest.lineage_ref.content_hash, payload_set_hash: owner.productionPayloadSetHash(manifest.files)
  };
  const detachedBytes = enc(ownerRoot.canonicalJson(detached));
  const commitment = structuredClone(base.commitment);
  commitment.bundle_ref.content_hash = manifest.bundle_hash;
  commitment.detached_ref.content_hash = ownerRoot.hashBytes(detachedBytes);
  commitment.file_set = base.commitment.file_set.map((descriptor) => {
    if (descriptor.role === "manifest") return { ...descriptor, byte_hash: manifestDescriptor.byte_hash, byte_size: manifestDescriptor.byte_size };
    if (descriptor.role === "archive") return { ...descriptor, byte_hash: archiveDescriptor.byte_hash, byte_size: archiveDescriptor.byte_size };
    if (descriptor.role === "detached") return { ...descriptor, byte_hash: ownerRoot.hashBytes(detachedBytes), byte_size: detachedBytes.length };
    return structuredClone(manifest.files.find((file) => file.filename === descriptor.filename));
  });
  const files = new Map([...Object.entries(payload), ["manifest.json", manifestBytes], ["archive.zip", zipBytes], ["detached.json", detachedBytes]]);
  const commitmentBytesOut = enc(`${JSON.stringify(commitment, null, 2)}\n`);
  return { files, manifest, commitment, commitmentBytes: commitmentBytesOut, bundleHash: manifest.bundle_hash, pin: { length: commitmentBytesOut.length, sha256: sha256Tagged(commitmentBytesOut) } };
}

export const ownerVerifyDirect = (files, commitment) => {
  const result = owner.verifyProductionBundleFiles([...files].map(([filename, bytes]) => ({ filename, bytes: clone(bytes) })), { trusted_commitment: commitment, scope: OWNER_SCOPE });
  return result.ok ? { ok: true, integrity: result.value.integrity, eligibility: result.value.eligibility } : { ok: false, code: result.errors[0].code };
};

export const ownerLimitsDirect = owner.productionArchiveLimits;
export const ownerHelpers = Object.freeze({ canonicalJson: ownerRoot.canonicalJson, hashBytes: ownerRoot.hashBytes, productionBundleContentHash: owner.productionBundleContentHash, productionPayloadSetHash: owner.productionPayloadSetHash });

// ---------------------------------------------------------------------------------------------------------
// Fixture host ports (publication source + byte source) with call logs and per-test hooks
// ---------------------------------------------------------------------------------------------------------

export function publishFromBaseline(world, files = baseline().files, commitmentBytesIn = clone(commitmentBytes), bundleHash = BUNDLE_HASH) {
  world.bundles.set(bundleHash, { files, commitmentBytes: commitmentBytesIn, pin: { length: commitmentBytesIn.length, sha256: sha256Tagged(commitmentBytesIn) } });
  return bundleHash;
}

export function createWorld(options = {}) {
  const calls = { resolve: [], read: [] };
  const world = {
    calls,
    bundles: new Map(),
    hooks: { resolve: null, read: null },
    publication: {
      async resolve(request) {
        calls.resolve.push({ tenantId: request.trustedScope.tenantId, projectId: request.trustedScope.projectId, bundleDigest: request.bundleDigest, keys: Object.keys(request).sort().join(",") });
        const dflt = async () => {
          const entry = world.bundles.get(request.bundleDigest);
          if (entry === undefined || (options.ignoreScope !== true && (request.trustedScope.tenantId !== SCOPE.tenantId || request.trustedScope.projectId !== SCOPE.projectId))) return { status: "unpublished" };
          return { status: "published", bundleDigest: request.bundleDigest, commitment: { length: entry.pin.length, sha256: entry.pin.sha256 }, provenance: { kind: "development_fixture", digest: FIXTURE_PROVENANCE_DIGEST } };
        };
        return world.hooks.resolve === null ? dflt() : world.hooks.resolve(request, dflt);
      }
    },
    bytes: {
      async read(request) {
        calls.read.push({ role: request.role, filename: request.filename, byteHash: request.byteHash, maxLength: request.maxLength, keys: Object.keys(request).sort().join(",") });
        const dflt = async () => {
          for (const entry of world.bundles.values()) {
            if (request.role === "commitment") { if (entry.pin.sha256 === request.byteHash) return { status: "found", bytes: clone(entry.commitmentBytes) }; continue; }
            const bytes = entry.files.get(request.filename);
            if (bytes !== undefined && bundleOwns(entry, request)) return { status: "found", bytes: clone(bytes) };
          }
          return { status: "missing" };
        };
        return world.hooks.read === null ? dflt() : world.hooks.read(request, dflt);
      }
    }
  };
  return world;
}

// A fixture store resolves a file read through the bundle whose anchored commitment names that exact (filename, byteHash).
// Tampered variants are served under the anchored filename on purpose (a lying store): the consumer must not rely on honesty.
function bundleOwns(entry, request) {
  try {
    const commitment = JSON.parse(new TextDecoder().decode(entry.commitmentBytes));
    return commitment.file_set.some((descriptor) => descriptor.filename === request.filename && descriptor.byte_hash === request.byteHash);
  } catch { return false; }
}

export function createGate(world, overrides = {}) {
  return createProductionBundleGate({
    publication: world.publication, bytes: world.bytes, clock: frozenClock,
    consumerRevision: "0123456789abcdef0123456789abcdef01234567",
    ...overrides
  });
}

export function gateRequest(overrides = {}) {
  const bundleDigest = overrides.bundleDigest ?? BUNDLE_HASH;
  return {
    trustedScope: SCOPE, bundleDigest, providerId: "simulated-provider", runtimeMode: "simulated", transportMode: "simulated",
    quote: { quoteId: "q", currency: "USD", totalMinor: 1, expiresAt: "2099-01-01T00:00:00.000Z", productionBundleDigest: bundleDigest, termsFingerprint: "t" },
    // The envelope reference follows the digest by default, as a well-formed command would. Tests that want a disagreement pass it explicitly.
    envelopeBundle: { ...BUNDLE_REF, content_hash: bundleDigest }, ...overrides
  };
}

/** Terms source built from the REAL manifest, labelled development_fixture: proves the comparison, authorizes nothing. */
export function termsSourceFor(manifest, overrides = {}) {
  const strip = (value) => value.slice(7);
  const terms = {
    orderRef: "ord_FIXTURE_0001", sku: null, options: { variantId: "v", material: "m", finish: "f", size: "s", quantity: 1 },
    quote: { id: "q", amountMinor: 1, currency: "USD" }, destination: { ref: "dst_FIXTURE_ref_0001", digest: "a".repeat(64) },
    design: { versionId: "v_fx", designHash: "b".repeat(64), artHash: "c".repeat(64), factsHash: strip(manifest.composition.facts_hash), compositionHash: strip(manifest.composition.composition_hash) },
    approvalId: manifest.approval_ref.id, capabilityVersion: "2026-10-11.1"
  };
  const calls = [];
  return {
    calls,
    async resolve(request) {
      calls.push(request);
      if (overrides.result !== undefined) return typeof overrides.result === "function" ? overrides.result(request) : overrides.result;
      return { status: "bound", terms: { ...terms, ...(overrides.terms ?? {}), design: { ...terms.design, ...(overrides.design ?? {}) } }, provenance: { kind: "development_fixture", digest: `sha256:${"d".repeat(64)}` } };
    }
  };
}

// ---------------------------------------------------------------------------------------------------------
// Counting runtime harness: every injected port is wrapped so a test can prove which ports were (not) touched.
// ---------------------------------------------------------------------------------------------------------

const ALL_SHAPES = ["operation_envelope", "capability", "print_specification", "preflight_report", "production_bundle", "fulfillment_quote", "order_authorization", "shipment_observation", "operation_result", "budget_reservation", "fulfillment_usage"];

export function forgedAcceptedBinding(contracts, shape) {
  const base = contracts.binding(shape);
  return { ...base, state: "accepted", schemaVersion: "1.0.0", sourceRevision: "forged-test-only-never-accepted", fixtureDigest: `sha256:${"e".repeat(64)}` };
}

export function createGateRuntime(options = {}) {
  const base = createMockHarness({ ...(options.mock ?? {}) });
  const order = [];
  const counters = { inbound: 0, outbound: 0, claim: 0, revalidate: 0, persistenceGet: 0, persistenceClaim: 0, persistenceSave: 0, budget: 0, usage: 0, metering: 0, transport: 0, adapter: {} };
  const tick = (name) => { order.push(name); };
  const bindingFor = (shape) => options.forgeAllBindingsAccepted === true ? forgedAcceptedBinding(base.contracts, shape)
    : options.bindingOverrides?.[shape] !== undefined ? { ...base.contracts.binding(shape), ...options.bindingOverrides[shape] } : base.contracts.binding(shape);
  const contracts = {
    binding: bindingFor,
    async validateInbound(request) { counters.inbound += 1; tick("inbound"); return base.contracts.validateInbound(request); },
    async validateOutbound(request) { counters.outbound += 1; tick("outbound"); return base.contracts.validateOutbound(request); }
  };
  const runtimeMode = options.runtimeOptions?.mode ?? "simulated";
  const baseDescriptor = base.simulator.adapter.descriptor;
  const descriptor = runtimeMode === "sandbox" ? { ...baseDescriptor, supportedModes: ["simulated", "sandbox"] } : baseDescriptor;
  const adapter = { descriptor };
  for (const method of ["quote", "preflight", "validateBeforeSubmit", "submit", "getStatus", "observeShipment", "cancel"]) {
    adapter[method] = async (...args) => {
      counters.adapter[method] = (counters.adapter[method] ?? 0) + 1; tick(`adapter.${method}`);
      if (method === "submit" && options.doubleTransport === true) {
        // An adapter that makes two transport requests inside one submit (a retry): the recheck must run before EACH.
        await args[1].transport.request({ operation: "submit", method: "POST", path: "/fixture/first-attempt", body: {} });
      }
      return base.simulator.adapter[method](...args);
    };
  }
  const baseVerifier = base.dependencies.authorizationVerifier;
  const authorizationVerifier = {
    async verifyAndClaim(check) { counters.claim += 1; tick("auth.claim"); return baseVerifier.verifyAndClaim(check); },
    ...(options.withoutRevalidation === true ? {} : {
      async revalidateBeforeDispatch(check, claim) {
        counters.revalidate += 1; tick("auth.revalidate");
        if (options.revalidate !== undefined) return options.revalidate(check, claim, counters.revalidate);
        return { status: "dispatchable" };
      }
    })
  };
  const transportMode = options.transportMode ?? runtimeMode;
  const transportRequests = [];
  const transport = {
    mode: transportMode,
    async request(request) {
      counters.transport += 1; tick("transport");
      if (transportMode !== "simulated") throw new Error("non-simulated transport must never be reached in these tests");
      transportRequests.push(request);
      if (options.onTransport !== undefined) await options.onTransport(request, counters.transport);
      if (request.path === "/fixture/first-attempt") return {};
      return base.simulator.transport.request(request);
    }
  };
  const persistence = {
    async getSubmitAttempt(...args) { counters.persistenceGet += 1; tick("persistence.get"); return base.dependencies.persistence.getSubmitAttempt(...args); },
    async claimSubmitAttempt(...args) { counters.persistenceClaim += 1; tick("persistence.claim"); return base.dependencies.persistence.claimSubmitAttempt(...args); },
    async saveSubmitAttempt(...args) { counters.persistenceSave += 1; return base.dependencies.persistence.saveSubmitAttempt(...args); }
  };
  const budgetClient = { async authorize(...args) { counters.budget += 1; tick("budget"); return base.dependencies.budgetClient.authorize(...args); } };
  const usageSink = { async record(...args) { counters.usage += 1; return base.dependencies.usageSink.record(...args); } };
  const observations = [];
  const metering = base.dependencies.metering === undefined ? undefined : async (scope) => {
    counters.metering += 1; tick("metering");
    const recorder = await base.dependencies.metering(scope);
    return {
      isConfiguredFor: (...args) => recorder.isConfiguredFor(...args),
      recordObservation: async (input) => { observations.push(input); return recorder.recordObservation(input); },
      replayPending: (...args) => recorder.replayPending(...args)
    };
  };
  const dependencies = {
    contracts, transport, clock: base.dependencies.clock, persistence, authorizationVerifier, budgetClient, usageSink,
    ...(metering === undefined ? {} : { metering }),
    ...(options.gate === undefined ? {} : { productionBundleGate: options.gate })
  };
  const runtime = new FulfillmentConnectorRuntime(adapter, dependencies, options.runtimeOptions);
  return { runtime, counters, order, base, dependencies, adapter, observations, transportRequests };
}

export function totalPortCalls(counters) {
  return counters.inbound + counters.outbound + counters.claim + counters.revalidate + counters.persistenceGet + counters.persistenceClaim + counters.persistenceSave +
    counters.budget + counters.usage + counters.metering + counters.transport + Object.values(counters.adapter).reduce((sum, value) => sum + value, 0);
}

export function bundleSubmitCommand(quoteResult, bundleHash = BUNDLE_HASH, bundleRef = BUNDLE_REF, overrides = {}) {
  const quote = {
    quoteId: quoteResult.providerQuoteId, currency: quoteResult.currency, totalMinor: quoteResult.totalMinor, expiresAt: quoteResult.expiresAt, productionBundleDigest: bundleHash,
    termsFingerprint: simulatorQuoteTermsFingerprint({ providerQuoteId: quoteResult.providerQuoteId, totalMinor: quoteResult.totalMinor, currency: quoteResult.currency, expiresAt: quoteResult.expiresAt, productionBundleDigest: bundleHash })
  };
  return {
    productionBundle: bundleRef, productionBundleDigest: bundleHash, quote, authorizationEnvelope: MOCK_AUTHORIZATION, amountMinor: quoteResult.totalMinor,
    currency: quoteResult.currency, idempotencyKey: "bundle-key-1", requestFingerprint: "bundle-request-fingerprint-1", ...overrides
  };
}

/** Quote (unchanged operation) then submit, through the counting runtime. Returns the quote response and the submit command. */
export async function prepareBundleSubmit(harness, bundleHash = BUNDLE_HASH, bundleRef = BUNDLE_REF, overrides = {}) {
  const quote = await harness.runtime.quote(envelope(makeQuoteCommand(bundleRef, { fixture: "synthetic-destination" }, 1), SCOPE), SCOPE);
  return { quote, command: bundleSubmitCommand(quote.value, bundleHash, bundleRef, overrides) };
}

export { envelope as envelopeFor };
export const wrapEnvelope = (command) => envelope(command, SCOPE);
