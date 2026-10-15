import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { discoverDevelopmentCapability } from "../dist/capability-consumer.js";
import { captureCatalogSnapshot } from "../dist/catalog.js";
import { checkFulfillmentCapabilitySnapshot, checkPrintSpecBinding, translatePrintSpecToLegacy } from "@jevelopers/shared-contracts/capability";
import { validateContract, hashManifest } from "@jevelopers/shared-contracts";
import { catalogA, catalogB, copyCatalog } from "./catalog-fixtures.mjs";

const context = () => ({ trusted_scope: {
  tenant_id: "123e4567-e89b-42d3-a456-426614174001",
  project_id: "123e4567-e89b-42d3-a456-426614174002"
}, now: "2026-10-10T10:30:00.000Z" });
const source = (raw) => ({ async readCatalogSnapshot() { return raw; } });
const discover = (raw = copyCatalog(), ctx = context()) => discoverDevelopmentCapability(source(raw), ctx);
const success = async (raw = copyCatalog(), ctx = context()) => {
  const result = await discover(raw, ctx);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.eligibility, "not_established");
  return result;
};

test("exact existing owner archive and source fixtures are retained", () => {
  const bytes = readFileSync(new URL("../vendor/shared-contracts/jevelopers-shared-contracts-0.9.7.tgz", import.meta.url));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "771a9f565ea9df87a4c08e6e6d5ede422d2a5926182a95be082dc8ed7b8c4c43");
  const fixtures = JSON.parse(readFileSync(new URL(import.meta.resolve("@jevelopers/shared-contracts/compatibility/capability-source-fixtures.json")), "utf8"));
  assert.deepEqual(fixtures.alpha, catalogA);
  assert.deepEqual(fixtures.beta, catalogB);
});

for (const raw of [catalogA, catalogB]) test(`${raw.providerId}: actual discovery reads once and validates both owner shapes`, async () => {
  let reads = 0;
  const before = JSON.stringify(raw);
  const result = await discoverDevelopmentCapability({ async readCatalogSnapshot() {
    assert.equal(++reads, 1); return raw;
  } }, context());
  assert.equal(result.ok, true);
  const canonical = result.canonicalSnapshot;
  assert.equal(reads, 1);
  assert.equal(validateContract("FulfillmentCapabilitySnapshot", canonical).ok, true);
  assert.equal(validateContract("PrintSpec", canonical.products[0]).ok, true);
  assert.equal(canonical.source.input_hash, hashManifest(raw));
  assert.notEqual(canonical.capture_identity, result.privateSnapshot.snapshotIdentity);
  assert.notEqual(canonical.content_identity, result.privateSnapshot.catalogContentIdentity);
  assert.notEqual(canonical.products[0].spec_identity, result.privateSnapshot.products[0].specIdentity);
  assert.equal(canonical.source.evidence_mode, "synthetic_fixture");
  assert.equal(JSON.stringify(raw), before);
});

test("captured raw data is a deeply frozen owned copy", async () => {
  const raw = copyCatalog();
  const capture = await captureCatalogSnapshot(source(raw));
  assert.notEqual(capture.input, raw);
  raw.products[0].constraints.dimensions.value.width = "123";
  assert.equal(capture.input.products[0].constraints.dimensions.value.width, "304.8");
  assert.throws(() => { capture.input.products[0].sku = "changed"; }, TypeError);
  assert.throws(() => { capture.snapshot.products[0].sku = "changed"; }, TypeError);
});

test("host context is copied before source I/O and cannot be supplied by the source", async () => {
  const ctx = context();
  const expected = structuredClone(ctx);
  const result = await discoverDevelopmentCapability({ async readCatalogSnapshot() {
    ctx.trusted_scope.tenant_id = "123e4567-e89b-42d3-a456-426614174099";
    ctx.now = "2027-10-10T10:30:00.000Z";
    return catalogA;
  } }, ctx);
  assert.equal(result.ok, true);
  assert.equal(result.canonicalSnapshot.tenant_id, expected.trusted_scope.tenant_id);
  assert.equal(checkFulfillmentCapabilitySnapshot(result.canonicalSnapshot, expected).ok, true);
  assert.equal(checkFulfillmentCapabilitySnapshot(result.canonicalSnapshot, ctx).ok, false);
  const forged = copyCatalog();
  forged.tenant_id = ctx.trusted_scope.tenant_id;
  assert.deepEqual(await discover(forged), { ok: false, code: "capture_failed" });
});

test("invalid/getter/proxy scope and invalid clocks reject before a source read", async () => {
  let getterCalls = 0, reads = 0;
  const accessor = context();
  Object.defineProperty(accessor.trusted_scope, "tenant_id", { enumerable: true, get() { getterCalls++; return context().trusted_scope.tenant_id; } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const ctx of [null, {}, accessor, revoked.proxy, { ...context(), now: "2026-02-30T00:00:00.000Z" },
    { ...context(), now: "not-a-clock" }, { ...context(), trusted_scope: { tenant_id: "tenant-from-input", project_id: "project-from-input" } }]) {
    const result = await discoverDevelopmentCapability({ async readCatalogSnapshot() { reads++; return catalogA; } }, ctx);
    assert.deepEqual(result, { ok: false, code: "invalid_context" });
  }
  assert.equal(reads, 0); assert.equal(getterCalls, 0);
});

test("exact unit conversion preserves physical stock without inventing print geometry", async () => {
  const raw = copyCatalog();
  raw.products[0].constraints.dimensions.value = { width: "12", height: "18", depth: "0.001", unit: "in" };
  const result = await success(raw);
  const constraints = result.canonicalSnapshot.products[0].constraints;
  assert.equal(constraints.physical_dimensions.value.depth_nm, "25400");
  assert.equal(result.privateSnapshot.products[0].constraints.dimensions.value.depthNm, "25400");
  assert.equal(constraints.physical_dimensions.value.basis, "unspecified_physical_product");
  for (const geometry of Object.values(constraints.geometry)) assert.deepEqual(geometry, { state: "unknown", reason_code: "not_in_source" });
  assert.deepEqual(constraints.inset_geometry_basis, { state: "unknown", reason_code: "not_in_source" });
  assert.throws(() => { constraints.geometry.trim.state = "known"; }, TypeError);
});

test("freshness equality passes, next millisecond and pre-capture time refuse canonical output", async () => {
  await success(copyCatalog(), { ...context(), now: "2026-10-10T11:00:00.000Z" });
  for (const now of ["2026-10-10T11:00:00.001Z", "2026-10-10T09:59:59.999Z"]) {
    assert.deepEqual(await discover(copyCatalog(), { ...context(), now }), { ok: false, code: "canonical_rejected" });
  }
});

test("material drift changes both spec identities; recapture only preserves both specs", async () => {
  const first = await success();
  const changed = copyCatalog(); changed.products[0].constraints.dimensions.value.width = "305";
  const next = await success(changed);
  assert.notEqual(first.canonicalSnapshot.products[0].spec_identity, next.canonicalSnapshot.products[0].spec_identity);
  assert.notEqual(first.privateSnapshot.products[0].specIdentity, next.privateSnapshot.products[0].specIdentity);
  const refreshed = copyCatalog(); refreshed.source.retrievedAt = "2026-10-10T10:01:00.000Z";
  const later = await success(refreshed);
  assert.equal(first.canonicalSnapshot.products[0].spec_identity, later.canonicalSnapshot.products[0].spec_identity);
  assert.equal(first.canonicalSnapshot.content_identity, later.canonicalSnapshot.content_identity);
  assert.notEqual(first.canonicalSnapshot.capture_identity, later.canonicalSnapshot.capture_identity);
});

test("canonical binding rejects stale identities, cross-scope and tampered geometry", async () => {
  const { canonicalSnapshot: snapshot } = await success();
  const ctx = { ...context(), capture_identity: snapshot.capture_identity, content_identity: snapshot.content_identity };
  assert.equal(checkPrintSpecBinding(snapshot.products[0], snapshot, ctx).ok, true);
  assert.equal(checkPrintSpecBinding(snapshot.products[0], snapshot, { ...ctx, capture_identity: `sha256:${"0".repeat(64)}` }).ok, false);
  const tampered = structuredClone(snapshot);
  tampered.products[0].constraints.physical_dimensions.value.width_nm = "1";
  assert.equal(checkFulfillmentCapabilitySnapshot(tampered, context()).ok, false);
  const wrongScope = context(); wrongScope.trusted_scope.project_id = "123e4567-e89b-42d3-a456-426614174099";
  assert.equal(checkPrintSpecBinding(snapshot.products[0], snapshot, { ...ctx, ...wrongScope }).ok, false);
});

test("legacy bundle, quote and authorization translations remain refused", async () => {
  const { canonicalSnapshot } = await success();
  for (const [target, code] of [["ProductionBundle/1.0.0", "LEGACY_UNREPRESENTABLE"], ["FulfillmentQuote/1.0.0", "LEGACY_ADOPTION_PENDING"], ["OrderAuthorization/1.0.0", "LEGACY_UNREPRESENTABLE"]]) {
    const result = translatePrintSpecToLegacy(canonicalSnapshot.products[0], target);
    assert.equal(result.ok, false); assert.equal(result.errors[0].code, code);
  }
});

test("unsupported personalization and unknown constraints survive projection", async () => {
  const beta = await success(copyCatalog(catalogB));
  assert.equal(beta.canonicalSnapshot.products[0].constraints.personalization.state, "unsupported");
  const raw = copyCatalog(); raw.products[0].constraints.files = { state: "unknown", reasonCode: "not_in_source" };
  const result = await success(raw);
  assert.deepEqual(result.canonicalSnapshot.products[0].constraints.files, { state: "unknown", reason_code: "not_in_source" });
});

test("malformed raw data and source errors return safe refusals without leaking content", async () => {
  let reads = 0;
  const accessor = copyCatalog();
  Object.defineProperty(accessor, "providerId", { enumerable: true, get() { reads++; throw new Error("private-canary"); } });
  const version = copyCatalog(); version.localFormat = "connector-development-catalog/2";
  const precision = copyCatalog(); precision.products[0].constraints.dimensions.value.width = "0.0001";
  for (const raw of [accessor, version, precision, null, { secret: "private-canary" }]) {
    assert.deepEqual(await discover(raw), { ok: false, code: "capture_failed" });
  }
  assert.equal(reads, 0);
  const failed = await discoverDevelopmentCapability({ async readCatalogSnapshot() { throw new Error("private-canary"); } }, context());
  assert.deepEqual(failed, { ok: false, code: "capture_failed" });
});

test("all consumer cases made zero network attempts", () => {
  const guard = globalThis[Symbol.for("fulfillment-connectors.prodigi-sandbox.network-guard")];
  assert.equal(guard?.installed, true, "run with the network guard preloaded");
  assert.equal(guard.attempts, 0);
});
