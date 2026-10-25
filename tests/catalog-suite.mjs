import assert from "node:assert/strict";
import { evaluateCatalogSelection, discoverCatalogSnapshot, normalizeCatalogSnapshot, validateCatalogSnapshotBoundary } from "../dist/catalog.js";
import { catalogA, catalogB, copyCatalog, selectionFor } from "./catalog-fixtures.mjs";

const cases = [];
const add = (name, run) => cases.push([name, run]);
const now = "2026-10-10T10:30:00.000Z";
const freshCapture = (selection, snapshot) => ({
  ...selection,
  snapshotIdentity: snapshot.snapshotIdentity,
  catalogContentIdentity: snapshot.catalogContentIdentity,
  specIdentity: snapshot.products[0].specIdentity
});

add("incompatible synthetic providers normalize to distinct private snapshots and exact selection checks", async () => {
  const alpha = await normalizeCatalogSnapshot(catalogA);
  const beta = await normalizeCatalogSnapshot(catalogB);
  assert.equal(alpha.localFormat, "connector-development-catalog-snapshot/1");
  assert.notEqual(alpha.catalogContentIdentity, beta.catalogContentIdentity);
  assert.notEqual(alpha.products[0].specIdentity, beta.products[0].specIdentity);
  assert.equal(evaluateCatalogSelection(alpha, selectionFor(alpha), now).status, "eligible");
  const crossProvider = evaluateCatalogSelection(beta, selectionFor(alpha), now);
  assert.equal(crossProvider.status, "revalidation_required");
  assert.ok(crossProvider.reasons.includes("sku_not_found"));
  assert.deepEqual(crossProvider.requiredActions, ["refresh_catalog", "revalidate", "requote", "reapprove"]);
});

add("unordered capability sets and catalog rows do not change deterministic identities", async () => {
  const original = await normalizeCatalogSnapshot(catalogA);
  const reordered = copyCatalog();
  const product = reordered.products[0];
  product.constraints.files.value.types.reverse();
  product.constraints.color.value.spaces.reverse();
  product.constraints.color.value.profiles.reverse();
  product.constraints.options.value.reverse();
  product.constraints.materials.value.reverse();
  product.constraints.destinations.value.reverse();
  product.constraints.destinations.value[1].regions.value.reverse();
  product.constraints.shipping.value.reverse();
  const again = await normalizeCatalogSnapshot(reordered);
  assert.equal(original.products[0].specIdentity, again.products[0].specIdentity);
  assert.equal(original.catalogContentIdentity, again.catalogContentIdentity);
  assert.equal(original.snapshotIdentity, again.snapshotIdentity);
});

add("retrieval metadata changes capture identity but preserves catalog and specification identities", async () => {
  const first = await normalizeCatalogSnapshot(catalogA);
  const laterInput = copyCatalog();
  laterInput.source.retrievedAt = "2026-10-10T10:01:00.000Z";
  const later = await normalizeCatalogSnapshot(laterInput);
  assert.equal(first.products[0].specIdentity, later.products[0].specIdentity);
  assert.equal(first.catalogContentIdentity, later.catalogContentIdentity);
  assert.notEqual(first.snapshotIdentity, later.snapshotIdentity);
  const newSourceRevision = copyCatalog();
  newSourceRevision.source.revision = "revision:fixture-alpha-2";
  const revised = await normalizeCatalogSnapshot(newSourceRevision);
  assert.equal(first.products[0].specIdentity, revised.products[0].specIdentity);
  assert.notEqual(first.catalogContentIdentity, revised.catalogContentIdentity);
  assert.notEqual(first.snapshotIdentity, revised.snapshotIdentity);
});

add("dimension, option, material, and provider-specific attribute drift changes spec identity", async () => {
  const original = await normalizeCatalogSnapshot(catalogA);
  for (const mutate of [
    (input) => { input.products[0].constraints.dimensions.value.width = "305"; },
    (input) => { input.products[0].constraints.options.value.push("framed"); },
    (input) => { input.products[0].constraints.materials.value[0] = "paper-250gsm"; },
    (input) => { input.products[0].providerAttributes.finishCode = "M-03"; }
  ]) {
    const input = copyCatalog();
    mutate(input);
    const changed = await normalizeCatalogSnapshot(input);
    assert.notEqual(changed.products[0].specIdentity, original.products[0].specIdentity);
    assert.notEqual(changed.catalogContentIdentity, original.catalogContentIdentity);
    const result = evaluateCatalogSelection(changed, selectionFor(original), now);
    assert.equal(result.status, "revalidation_required");
    assert.deepEqual(result.requiredActions, ["revalidate", "requote", "reapprove"]);
    assert.ok(result.reasons.includes("spec_identity_changed"));
  }
});

add("stale, future-dated, and invalid-clock snapshots fail closed", async () => {
  const snapshot = await normalizeCatalogSnapshot(catalogA);
  const selection = selectionFor(snapshot);
  const stale = evaluateCatalogSelection(snapshot, selection, "2026-10-10T11:00:01.000Z");
  assert.equal(stale.status, "revalidation_required");
  assert.deepEqual(stale.requiredActions, ["refresh_catalog", "revalidate", "requote", "reapprove"]);
  assert.equal(evaluateCatalogSelection(snapshot, selection, "2026-10-10T11:00:00.000Z").status, "eligible");
  const future = evaluateCatalogSelection(snapshot, selection, "2026-10-10T09:59:59.000Z");
  assert.equal(future.status, "ineligible");
  assert.ok(future.reasons.includes("catalog_clock_before_retrieval"));
  assert.equal(evaluateCatalogSelection(snapshot, selection, "not-a-date").status, "ineligible");
  const badTimestamp = copyCatalog();
  badTimestamp.source.retrievedAt = "2026-02-30T10:00:00.000Z";
  await assert.rejects(normalizeCatalogSnapshot(badTimestamp), /Catalog snapshot is invalid/);
});

add("removed SKUs require revalidation and never substitute a nearby variant", async () => {
  const selectedSnapshot = await normalizeCatalogSnapshot(catalogA);
  const removedInput = copyCatalog();
  removedInput.products[0].availability = "removed";
  const removed = await normalizeCatalogSnapshot(removedInput);
  const result = evaluateCatalogSelection(removed, selectionFor(selectedSnapshot), now);
  assert.equal(result.status, "revalidation_required");
  assert.ok(result.reasons.includes("sku_removed"));
  assert.deepEqual(result.requiredActions, ["refresh_catalog", "revalidate", "requote", "reapprove"]);
});

add("a bound capture cannot carry a different content identity", async () => {
  const snapshot = await normalizeCatalogSnapshot(catalogA);
  const result = evaluateCatalogSelection(snapshot, { ...selectionFor(snapshot), catalogContentIdentity: `sha256:${"0".repeat(64)}` }, now);
  assert.equal(result.status, "revalidation_required");
  assert.ok(result.reasons.includes("snapshot_binding_mismatch"));
});

add("unknown mandatory print constraints make a fresh selection ineligible", async () => {
  const input = copyCatalog();
  input.products[0].constraints.files = { state: "unknown", reasonCode: "not_in_source" };
  const snapshot = await normalizeCatalogSnapshot(input);
  const result = evaluateCatalogSelection(snapshot, freshCapture(selectionFor(await normalizeCatalogSnapshot(catalogA)), snapshot), now);
  assert.equal(result.status, "ineligible");
  assert.ok(result.reasons.includes("unknown_mandatory_constraint"));
  assert.ok(result.details.includes("files:unknown"));
});

add("unsupported optional personalization permits no personalization and rejects a request", async () => {
  const beta = await normalizeCatalogSnapshot(catalogB);
  const plain = selectionFor(beta);
  assert.equal(plain.personalization, null);
  assert.equal(evaluateCatalogSelection(beta, plain, now).status, "eligible");
  const requested = evaluateCatalogSelection(beta, { ...plain, personalization: { mode: "variable_text", fields: [{ name: "title", characterCount: 10 }] } }, now);
  assert.equal(requested.status, "ineligible");
  assert.ok(requested.details.includes("personalization_unsupported"));
});

add("format/count, surface, color/profile, resolution, options, and materials are checked", async () => {
  const snapshot = await normalizeCatalogSnapshot(catalogA);
  const selection = selectionFor(snapshot);
  const mutations = [
    [{ fileType: "image/jpeg" }, "format_or_file_count_unsupported"],
    [{ fileCount: 3 }, "format_or_file_count_unsupported"],
    [{ surface: "back" }, "surface_unsupported"],
    [{ colorProfile: "fixture-srgb-v4" }, "color_or_profile_unsupported"],
    [{ colorSpace: "RGB" }, "color_or_profile_unsupported"],
    [{ effectiveResolutionDpi: 299 }, "resolution_below_minimum"],
    [{ options: ["gloss", "framed"] }, "option_unsupported"],
    [{ materials: ["canvas-300"] }, "material_unsupported"],
    [{ materials: [] }, "material_selection_missing"]
  ];
  for (const [override, expected] of mutations) {
    const result = evaluateCatalogSelection(snapshot, { ...selection, ...override }, now);
    assert.equal(result.status, "ineligible");
    assert.ok(result.details.includes(expected), `${expected} for ${JSON.stringify(override)}`);
  }
});

add("destination, region, and shipping constraints are checked independently", async () => {
  const snapshot = await normalizeCatalogSnapshot(catalogA);
  const selection = selectionFor(snapshot);
  for (const [override, expected] of [
    [{ destination: { countryCode: "FR" } }, "destination_country_unsupported"],
    [{ destination: { countryCode: "US", regionCode: "TX" } }, "destination_region_unsupported"],
    [{ shippingMethod: "overnight" }, "shipping_method_unsupported"]
  ]) {
    const result = evaluateCatalogSelection(snapshot, { ...selection, ...override }, now);
    assert.equal(result.status, "ineligible");
    assert.ok(result.details.includes(expected));
  }
  const missingRegion = evaluateCatalogSelection(snapshot, {
    ...selection, destination: { countryCode: "US" }, shippingMethod: "standard"
  }, now);
  assert.equal(missingRegion.status, "ineligible");
  assert.ok(missingRegion.details.includes("destination_region_required"));
  for (const [destination, shippingMethod] of [
    [{ countryCode: "US", regionCode: "CA" }, "standard"],
    [{ countryCode: "US", regionCode: "CA" }, "express"],
    [{ countryCode: "US", regionCode: "NY" }, "standard"],
    [{ countryCode: "GB" }, "tracked"]
  ]) {
    const allowed = evaluateCatalogSelection(snapshot, { ...selection, destination, shippingMethod }, now);
    assert.equal(allowed.status, "eligible");
  }
  const regionalPrecedence = evaluateCatalogSelection(snapshot, {
    ...selection, destination: { countryCode: "US", regionCode: "NY" }, shippingMethod: "express"
  }, now);
  assert.equal(regionalPrecedence.status, "ineligible");
  assert.ok(regionalPrecedence.details.includes("shipping_method_unsupported"));
  const input = copyCatalog();
  input.products[0].constraints.destinations.value[0].regions = { state: "unknown", reasonCode: "not_confirmed" };
  const unknown = await normalizeCatalogSnapshot(input);
  const unknownSelection = freshCapture(selection, unknown);
  const result = evaluateCatalogSelection(unknown, unknownSelection, now);
  assert.equal(result.status, "ineligible");
  assert.ok(result.reasons.includes("unknown_mandatory_constraint"));
});

add("bleed, safe-area, and exact fixed dimensions are checked without rounding", async () => {
  const snapshot = await normalizeCatalogSnapshot(catalogA);
  const selection = selectionFor(snapshot);
  const lowBleed = evaluateCatalogSelection(snapshot, { ...selection, bleed: { top: "2.999", right: "3", bottom: "3", left: "3", unit: "mm" } }, now);
  assert.equal(lowBleed.status, "ineligible");
  assert.ok(lowBleed.details.includes("bleed_below_minimum_top"));
  const lowSafe = evaluateCatalogSelection(snapshot, { ...selection, safeArea: { top: "5", right: "4.999", bottom: "5", left: "5", unit: "mm" } }, now);
  assert.equal(lowSafe.status, "ineligible");
  assert.ok(lowSafe.details.includes("safe_area_below_minimum_right"));
  const horizontalRoom = evaluateCatalogSelection(snapshot, {
    ...selection, safeArea: { top: "5", right: "150", bottom: "5", left: "150", unit: "mm" }
  }, now);
  const horizontalRoomEquivalent = evaluateCatalogSelection(snapshot, {
    ...selection, safeArea: { top: "0.5", right: "15", bottom: "0.5", left: "15", unit: "cm" }
  }, now);
  assert.equal(horizontalRoom.status, "eligible");
  assert.equal(horizontalRoomEquivalent.status, "eligible");
  const verticalRoom = evaluateCatalogSelection(snapshot, {
    ...selection, safeArea: { top: "220", right: "5", bottom: "220", left: "5", unit: "mm" }
  }, now);
  assert.equal(verticalRoom.status, "eligible");
  for (const [safeArea, expected] of [
    [{ top: "5", right: "152.4", bottom: "5", left: "152.4", unit: "mm" }, "safe_area_no_horizontal_content"],
    [{ top: "5", right: "160", bottom: "5", left: "160", unit: "mm" }, "safe_area_no_horizontal_content"],
    [{ top: "228.6", right: "5", bottom: "228.6", left: "5", unit: "mm" }, "safe_area_no_vertical_content"],
    [{ top: "230", right: "5", bottom: "230", left: "5", unit: "mm" }, "safe_area_no_vertical_content"]
  ]) {
    const impossible = evaluateCatalogSelection(snapshot, { ...selection, safeArea }, now);
    assert.equal(impossible.status, "ineligible");
    assert.ok(impossible.details.includes(expected));
  }
  const wrongDimensions = evaluateCatalogSelection(snapshot, { ...selection, dimensions: { width: "304.799", height: "457.2", depth: "0.3", unit: "mm" } }, now);
  assert.equal(wrongDimensions.status, "ineligible");
  assert.ok(wrongDimensions.details.includes("dimensions_mismatch"));
});

add("exact supported units canonicalize identically and unsupported precision is rejected", async () => {
  const metric = copyCatalog();
  metric.products[0].constraints.dimensions.value = { width: "25.4", height: "50.8", depth: "2.54", unit: "mm" };
  const imperial = copyCatalog(metric);
  imperial.products[0].constraints.dimensions.value = { width: "1", height: "2", depth: "0.1", unit: "in" };
  const first = await normalizeCatalogSnapshot(metric);
  const second = await normalizeCatalogSnapshot(imperial);
  assert.equal(first.products[0].specIdentity, second.products[0].specIdentity);
  const unsupportedPrecision = copyCatalog();
  unsupportedPrecision.products[0].constraints.dimensions.value.width = "304.8001";
  await assert.rejects(normalizeCatalogSnapshot(unsupportedPrecision), /Catalog snapshot is invalid/);
  const unsupportedUnit = copyCatalog();
  unsupportedUnit.products[0].constraints.dimensions.value.unit = "ft";
  await assert.rejects(normalizeCatalogSnapshot(unsupportedUnit), /Catalog snapshot is invalid/);
});

add("strict untrusted input rejects accessors, sparse arrays, contradictory bounds, and sensitive provider attributes", async () => {
  const accessor = copyCatalog();
  let getterCalled = false;
  Object.defineProperty(accessor.source, "retrievedAt", { enumerable: true, configurable: true, get() { getterCalled = true; return "2026-10-10T10:00:00.000Z"; } });
  await assert.rejects(normalizeCatalogSnapshot(accessor), /Catalog snapshot is invalid/);
  assert.equal(getterCalled, false);
  const sparse = copyCatalog();
  sparse.products = new Array(1);
  await assert.rejects(normalizeCatalogSnapshot(sparse), /Catalog snapshot is invalid/);
  const contradictory = copyCatalog();
  contradictory.products[0].constraints.minimumSafeArea.value = { top: "300", right: "300", bottom: "300", left: "300", unit: "mm" };
  await assert.rejects(normalizeCatalogSnapshot(contradictory), /Catalog snapshot is invalid/);
  const sensitiveKey = copyCatalog();
  sensitiveKey.products[0].providerAttributes.apiKey = "fixture-secret";
  await assert.rejects(normalizeCatalogSnapshot(sensitiveKey), /Catalog snapshot is invalid/);
  const unsafeValue = copyCatalog();
  unsafeValue.products[0].providerAttributes.documentation = "https://example.invalid/private?signature=abc";
  await assert.rejects(normalizeCatalogSnapshot(unsafeValue), /Catalog snapshot is invalid/);
  const addressValue = copyCatalog();
  addressValue.products[0].providerAttributes.description = "Ship to 42 Main Street";
  await assert.rejects(normalizeCatalogSnapshot(addressValue), /Catalog snapshot is invalid/);
  const secretValue = copyCatalog();
  secretValue.products[0].providerAttributes.transport = "Bearer abcdefghijklmnop";
  await assert.rejects(normalizeCatalogSnapshot(secretValue), /Catalog snapshot is invalid/);
});

add("injected reads occur once and snapshots own immutable copies", async () => {
  const raw = copyCatalog();
  let reads = 0;
  const snapshot = await discoverCatalogSnapshot({ async readCatalogSnapshot() { reads += 1; return raw; } });
  raw.products[0].constraints.dimensions.value.width = "999";
  raw.products[0].providerAttributes.finishCode = "changed";
  assert.equal(reads, 1);
  assert.equal(snapshot.products[0].constraints.dimensions.value.widthNm, "304800000");
  assert.equal(snapshot.products[0].providerAttributes.finishCode, "M-02");
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.products));
  assert.ok(Object.isFrozen(snapshot.products[0].constraints.dimensions.value));
});

add("catalog source method lookup failures publish only a sanitized error", async () => {
  const marker = new Error("synthetic-private-source-marker");
  let getterReads = 0;
  const accessor = Object.defineProperty({}, "readCatalogSnapshot", {
    get() { getterReads += 1; throw marker; }
  });
  const throwingProxy = new Proxy({}, { get() { throw marker; } });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (const source of [accessor, throwingProxy, revoked.proxy]) {
    await assert.rejects(discoverCatalogSnapshot(source), (error) => {
      assert.notEqual(error, marker);
      assert.ok(error instanceof TypeError);
      assert.equal(error.message, "Catalog source could not supply a supported private development capture.");
      assert.equal("cause" in error, false);
      return true;
    });
  }
  assert.equal(getterReads, 1);
});

add("catalog source captures one callable with its original receiver", async () => {
  let getterReads = 0;
  let calls = 0;
  const raw = copyCatalog();
  const source = {
    raw,
    get readCatalogSnapshot() {
      getterReads += 1;
      if (getterReads > 1) throw new Error("source method read twice");
      const read = async function () {
        calls += 1;
        assert.equal(this, source);
        return this.raw;
      };
      Object.defineProperty(read, "call", { get() { throw new Error("call property must not be read"); } });
      return read;
    }
  };
  const snapshot = await discoverCatalogSnapshot(source);
  assert.equal(getterReads, 1);
  assert.equal(calls, 1);
  assert.equal(snapshot.snapshotIdentity, (await normalizeCatalogSnapshot(raw)).snapshotIdentity);
});

add("catalog source retains prototype methods and sanitizes invocation failures", async () => {
  class Source {
    constructor() { this.raw = copyCatalog(); this.calls = 0; }
    async readCatalogSnapshot() { this.calls += 1; return this.raw; }
  }
  const source = new Source();
  assert.equal((await discoverCatalogSnapshot(source)).snapshotIdentity, (await normalizeCatalogSnapshot(source.raw)).snapshotIdentity);
  assert.equal(source.calls, 1);
  for (const failing of [
    { readCatalogSnapshot() { throw new Error("synthetic-private-source-marker"); } },
    { async readCatalogSnapshot() { throw new Error("synthetic-private-source-marker"); } },
    { readCatalogSnapshot: new Proxy(() => {}, { apply() { throw new Error("synthetic-private-source-marker"); } }) }
  ]) {
    await assert.rejects(discoverCatalogSnapshot(failing), {
      name: "TypeError", message: "Catalog source could not supply a supported private development capture."
    });
  }
  for (const invalid of [null, undefined, 1, "source", {}, { readCatalogSnapshot: null }]) {
    await assert.rejects(discoverCatalogSnapshot(invalid), {
      name: "TypeError", message: "A read-only catalog source is required."
    });
  }
});

add("canonical boundary delegation uses the existing validator and preserves pending fixture status", async () => {
  const snapshot = await normalizeCatalogSnapshot(catalogA);
  let captured;
  const validator = {
    binding: () => ({ shape: "capability", ownerRepository: "shared-contracts", upstreamIssue: "#4", state: "development_fixture", schemaVersion: "0.1.0", fixtureDigest: "sha256:fixture-only" }),
    async validateInbound() { throw new Error("not used"); },
    async validateOutbound(request) {
      captured = request;
      return { ok: true, value: { privateFixture: true }, receipts: [{ shape: "capability", schemaVersion: "0.1.0", tenantId: "tenant-a", projectId: "project-a" }] };
    }
  };
  const result = await validateCatalogSnapshotBoundary(snapshot, validator, { tenantId: "tenant-a", projectId: "project-a" });
  assert.equal(result.ok, true);
  assert.equal(captured.operation, "discover_capabilities");
  assert.deepEqual(captured.requiredShapes, ["capability"]);
  assert.equal(captured.value.localFormat, "connector-development-catalog-snapshot/1");
  assert.equal(validator.binding("capability").state, "development_fixture");
  const scopeMismatch = {
    ...validator,
    async validateOutbound() { return { ok: true, value: { privateFixture: true }, receipts: [{ shape: "capability", schemaVersion: "0.1.0", tenantId: "other", projectId: "project-a" }] }; }
  };
  assert.deepEqual(await validateCatalogSnapshotBoundary(snapshot, scopeMismatch, { tenantId: "tenant-a", projectId: "project-a" }), {
    ok: false, failure: { code: "scope_mismatch" }
  });
  const missing = {
    ...validator,
    async validateOutbound() { return { ok: false, failure: { code: "contract_missing" } }; }
  };
  const blocked = await validateCatalogSnapshotBoundary(snapshot, missing, { tenantId: "tenant-a", projectId: "project-a" });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.failure.code, "contract_missing");
});

add("canonical boundary projects owned success and allowlisted immutable failures", async () => {
  const snapshot = await normalizeCatalogSnapshot(catalogA);
  const scope = { tenantId: "tenant-a", projectId: "project-a" };
  const binding = {
    shape: "capability", ownerRepository: "shared-contracts", upstreamIssue: "#4", state: "development_fixture",
    schemaVersion: "0.1.0", fixtureDigest: "sha256:fixture-only"
  };
  const receipt = { shape: "capability", schemaVersion: "0.1.4", ...scope };
  const validatorFor = (result, bindingValue = binding) => ({
    binding: () => bindingValue,
    async validateInbound() { throw new Error("not used"); },
    async validateOutbound() { return result; }
  });

  const original = { ok: true, value: { nested: { fixture: "owned" } }, receipts: [receipt] };
  const accepted = await validateCatalogSnapshotBoundary(snapshot, validatorFor(original), scope);
  assert.equal(accepted.ok, true);
  assert.deepEqual(Object.keys(accepted), ["ok", "value", "receipts"]);
  assert.deepEqual(Object.keys(accepted.receipts[0]), ["shape", "schemaVersion", "tenantId", "projectId"]);
  original.value.nested.fixture = "mutated";
  original.receipts[0].tenantId = "other";
  assert.equal(accepted.value.nested.fixture, "owned");
  assert.equal(accepted.receipts[0].tenantId, "tenant-a");
  assert.ok(Object.isFrozen(accepted));
  assert.ok(Object.isFrozen(accepted.value.nested));
  assert.ok(Object.isFrozen(accepted.receipts[0]));

  const acceptedBinding = {
    shape: "capability", ownerRepository: "shared-contracts", upstreamIssue: "#4", state: "accepted",
    schemaVersion: "0.1.0", sourceRevision: "git:reviewed-source", fixtureDigest: "sha256:accepted-fixture"
  };
  assert.equal((await validateCatalogSnapshotBoundary(snapshot, validatorFor({ ok: true, value: null, receipts: [{ ...receipt, tenantId: "tenant-a" }] }, acceptedBinding), scope)).ok, true);

  for (const code of ["invalid_input", "contract_missing", "unsupported_schema_major", "scope_mismatch"]) {
    const result = await validateCatalogSnapshotBoundary(snapshot, validatorFor({ ok: false, failure: { code } }), scope);
    assert.deepEqual(result, { ok: false, failure: { code } });
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.failure));
  }
});

add("canonical boundary rejects malformed result unions and projects no raw response fields", async () => {
  const snapshot = await normalizeCatalogSnapshot(catalogA);
  const scope = { tenantId: "tenant-a", projectId: "project-a" };
  const binding = {
    shape: "capability", ownerRepository: "shared-contracts", upstreamIssue: "#4", state: "development_fixture",
    schemaVersion: "0.1.0", fixtureDigest: "sha256:fixture-only"
  };
  const receipt = { shape: "capability", schemaVersion: "0.1.0", ...scope };
  const validatorFor = (result) => ({
    binding: () => binding,
    async validateInbound() { throw new Error("not used"); },
    async validateOutbound() { return result; }
  });
  const malformed = [
    ["null result", null, "invalid_input"],
    ["array result", [], "invalid_input"],
    ["string result", "not-a-result", "invalid_input"],
    ["number result", 7, "invalid_input"],
    ["missing discriminator", { value: {}, receipts: [receipt] }, "invalid_input"],
    ["non-boolean discriminator", { ok: "false", value: {}, receipts: [receipt] }, "invalid_input"],
    ["missing success value", { ok: true, receipts: [receipt] }, "invalid_input"],
    ["missing failure", { ok: false }, "invalid_input"],
    ["invalid failure code", { ok: false, failure: { code: "not-a-code" } }, "invalid_input"],
    ["mixed success branch", { ok: true, value: {}, receipts: [receipt], failure: { code: "contract_missing" } }, "invalid_input"],
    ["mixed failure branch", { ok: false, failure: { code: "contract_missing" }, value: {}, receipts: [receipt] }, "invalid_input"],
    ["raw top-level failure field", { ok: false, failure: { code: "contract_missing" }, raw: "review-secret-marker" }, "invalid_input"],
    ["raw nested failure field", { ok: false, failure: { code: "contract_missing", raw: "review-secret-marker" } }, "invalid_input"],
    ["duplicate receipts", { ok: true, value: {}, receipts: [receipt, receipt] }, "invalid_input"],
    ["sparse receipts", { ok: true, value: {}, receipts: new Array(1) }, "invalid_input"],
    ["extra receipt field", { ok: true, value: {}, receipts: [{ ...receipt, raw: "review-secret-marker" }] }, "invalid_input"],
    ["null receipt", { ok: true, value: {}, receipts: [null] }, "invalid_input"],
    ["wrong receipt shape", { ok: true, value: {}, receipts: [{ ...receipt, shape: "print_specification" }] }, "invalid_input"],
    ["wrong receipt scope", { ok: true, value: {}, receipts: [{ ...receipt, tenantId: "other" }] }, "scope_mismatch"],
    ["wrong receipt schema major", { ok: true, value: {}, receipts: [{ ...receipt, schemaVersion: "1.0.0" }] }, "unsupported_schema_major"]
  ];
  for (const [name, raw, expectedCode] of malformed) {
    const result = await validateCatalogSnapshotBoundary(snapshot, validatorFor(raw), scope);
    assert.equal(result.ok, false, name);
    assert.equal(result.failure.code, expectedCode, name);
    assert.equal(JSON.stringify(result).includes("review-secret-marker"), false, name);
  }

  let resultGetterCalled = false;
  const accessorResult = { value: {}, receipts: [receipt] };
  Object.defineProperty(accessorResult, "ok", { enumerable: true, get() { resultGetterCalled = true; return true; } });
  const accessorFailure = await validateCatalogSnapshotBoundary(snapshot, validatorFor(accessorResult), scope);
  assert.equal(accessorFailure.ok, false);
  assert.equal(resultGetterCalled, false);
  const proxyResult = new Proxy({ ok: true, value: {}, receipts: [receipt] }, {
    ownKeys() { throw new Error("review-secret-marker"); }
  });
  const proxyFailure = await validateCatalogSnapshotBoundary(snapshot, validatorFor(proxyResult), scope);
  assert.equal(proxyFailure.ok, false);
  assert.equal(proxyFailure.failure.code, "invalid_input");
  assert.equal(JSON.stringify(proxyFailure).includes("review-secret-marker"), false);
  const symbolResult = { ok: true, value: {}, receipts: [receipt], [Symbol("unexpected")]: "review-secret-marker" };
  const symbolFailure = await validateCatalogSnapshotBoundary(snapshot, validatorFor(symbolResult), scope);
  assert.equal(symbolFailure.ok, false);
  assert.equal(symbolFailure.failure.code, "invalid_input");
  const symbolReceipt = { ...receipt, [Symbol("unexpected")]: "review-secret-marker" };
  const symbolReceiptFailure = await validateCatalogSnapshotBoundary(snapshot, validatorFor({ ok: true, value: {}, receipts: [symbolReceipt] }), scope);
  assert.equal(symbolReceiptFailure.ok, false);
  assert.equal(symbolReceiptFailure.failure.code, "invalid_input");
});

add("canonical boundary treats null, malformed, accessor-backed, and proxy bindings as missing", async () => {
  const snapshot = await normalizeCatalogSnapshot(catalogA);
  const scope = { tenantId: "tenant-a", projectId: "project-a" };
  const receipt = { shape: "capability", schemaVersion: "0.1.0", ...scope };
  const response = { ok: true, value: {}, receipts: [receipt] };
  const validatorFor = (binding) => ({
    binding: () => binding,
    async validateInbound() { throw new Error("not used"); },
    async validateOutbound() { return response; }
  });
  for (const [name, binding] of [
    ["null", null], ["array", []], ["primitive", "missing"],
    ["extra property", { shape: "capability", ownerRepository: "shared-contracts", upstreamIssue: "#4", state: "development_fixture", schemaVersion: "0.1.0", fixtureDigest: "sha256:fixture-only", raw: "review-secret-marker" }]
  ]) {
    const result = await validateCatalogSnapshotBoundary(snapshot, validatorFor(binding), scope);
    assert.equal(result.ok, false, name);
    assert.equal(result.failure.code, "contract_missing", name);
  }

  let bindingGetterCalled = false;
  const accessorBinding = {
    ownerRepository: "shared-contracts", upstreamIssue: "#4", state: "development_fixture",
    schemaVersion: "0.1.0", fixtureDigest: "sha256:fixture-only"
  };
  Object.defineProperty(accessorBinding, "shape", { enumerable: true, get() { bindingGetterCalled = true; return "capability"; } });
  const accessorFailure = await validateCatalogSnapshotBoundary(snapshot, validatorFor(accessorBinding), scope);
  assert.equal(accessorFailure.ok, false);
  assert.equal(accessorFailure.failure.code, "contract_missing");
  assert.equal(bindingGetterCalled, false);

  const proxyBinding = new Proxy({}, { ownKeys() { throw new Error("review-secret-marker"); } });
  const proxyFailure = await validateCatalogSnapshotBoundary(snapshot, validatorFor(proxyBinding), scope);
  assert.equal(proxyFailure.ok, false);
  assert.equal(proxyFailure.failure.code, "contract_missing");
  const symbolBinding = {
    shape: "capability", ownerRepository: "shared-contracts", upstreamIssue: "#4", state: "development_fixture",
    schemaVersion: "0.1.0", fixtureDigest: "sha256:fixture-only", [Symbol("unexpected")]: "review-secret-marker"
  };
  const symbolBindingFailure = await validateCatalogSnapshotBoundary(snapshot, validatorFor(symbolBinding), scope);
  assert.equal(symbolBindingFailure.ok, false);
  assert.equal(symbolBindingFailure.failure.code, "contract_missing");

  const throwingValidator = {
    binding() { throw new Error("review-secret-marker"); },
    async validateInbound() { throw new Error("not used"); },
    async validateOutbound() { throw new Error("not dispatched"); }
  };
  const thrownBinding = await validateCatalogSnapshotBoundary(snapshot, throwingValidator, scope);
  assert.deepEqual(thrownBinding, { ok: false, failure: { code: "contract_missing" } });
  assert.equal(JSON.stringify(thrownBinding).includes("review-secret-marker"), false);
});

export async function runCatalogSuite() {
  const results = [];
  for (const [name, run] of cases) {
    try {
      await run();
      results.push({ name, status: "passed" });
    } catch (error) {
      results.push({ name, status: "failed", detail: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  const results = await runCatalogSuite();
  for (const result of results) process.stdout.write(`${result.status.toUpperCase()} ${result.name}${result.detail ? `: ${result.detail}` : ""}\n`);
  const failed = results.filter((result) => result.status !== "passed");
  process.stdout.write(`Catalog normalization suite: ${results.length - failed.length}/${results.length} passed\n`);
  if (failed.length > 0) process.exitCode = 1;
}
