import assert from "node:assert/strict";
import {
  evaluateProviderPolicy,
  PRODIGI_SANDBOX_ADAPTER_ID,
  PRODIGI_SANDBOX_BASE_URL,
  PRODIGI_SANDBOX_OPERATION_ENDPOINTS,
  PROVIDER_ENVIRONMENT_MATRIX
} from "../dist/index.js";

const cases = [];

function successfulVerifier(overrides = {}) {
  let calls = 0;
  const verifier = {
    async verify(request) {
      calls += 1;
      return {
        ...request,
        productAndDestinationApproved: true,
        sandboxAccountAccessConfirmed: true,
        ...overrides
      };
    }
  };
  return { verifier, get calls() { return calls; } };
}

function sandboxInput(overrides = {}) {
  return {
    mode: "sandbox",
    providerId: "prodigi",
    endpoint: PRODIGI_SANDBOX_BASE_URL,
    operation: "quote",
    credentialClass: "sandbox",
    sku: "FIXTURE-ONLY-NOT-AN-APPROVED-SKU",
    destinationCountryCode: "US",
    shippingMethod: "fixture-only-shipping",
    decisionReference: "fixture-only-evidence-reference",
    ...overrides
  };
}

function assertNoEffects(result) {
  assert.equal(result.networkRequests, 0);
  assert.equal(result.credentialReads, 0);
  assert.equal(result.secretMaterialReturned, false);
  assert.equal(result.providerCallPermitted, false);
}

cases.push(["matrix records documentation separately from implementation and account evidence", async () => {
  assert.equal(PROVIDER_ENVIRONMENT_MATRIX.schemaVersion, "fulfillment-provider-environment-matrix/1");
  assert.equal(PROVIDER_ENVIRONMENT_MATRIX.checkedAt, "2026-10-10");
  assert.equal(PROVIDER_ENVIRONMENT_MATRIX.documentationRevision.startsWith("unknown"), true);
  assert.equal(PROVIDER_ENVIRONMENT_MATRIX.observedSnapshotDigest, null);
  assert.equal(PROVIDER_ENVIRONMENT_MATRIX.liveEnabled, false);
  assert.equal(PROVIDER_ENVIRONMENT_MATRIX.releaseReady, false);
  const prodigi = PROVIDER_ENVIRONMENT_MATRIX.providers.find((provider) => provider.providerId === "prodigi");
  assert.ok(prodigi);
  assert.equal(prodigi.status, "official_documentation_observed_only");
  assert.equal(prodigi.accountTested, false);
  assert.equal(prodigi.accountAccess, "unknown");
  assert.equal(prodigi.selectedSku, null);
  assert.equal(prodigi.selectedDestinationCountryCode, null);
  assert.equal(prodigi.selectedShippingMethod, null);
  assert.equal(prodigi.operations.cancel.documentation, "conditional");
  assert.equal(prodigi.operations.webhook.documentation, "not_established");
  assert.equal(prodigi.documentation.quoteExpiry.includes("No quote-expiry guarantee"), true);
  assert.equal(prodigi.operations.status.details.includes("not proof of delivery"), true);
  assert.deepEqual(prodigi.endpointAllowlist, [
    { operation: "quote", method: "POST", path: "/v4.0/quotes" },
    { operation: "submit", method: "POST", path: "/v4.0/Orders" },
    { operation: "status", method: "GET", path: "/v4.0/orders/{prodigi_order_id}" },
    { operation: "productDetails", method: "GET", path: "/v4.0/products/{sku}" }
  ]);
  assert.equal(prodigi.operations.productDetails.implementation, "not_implemented");
  assert.equal(prodigi.operations.productDetails.accountTested, false);
  assert.equal(prodigi.operations.productDetails.details.includes("never been sent to Prodigi"), true);
}]);

cases.push(["omitted mode selects an offline simulated path without endpoint or credential access", async () => {
  const result = await evaluateProviderPolicy();
  assert.equal(result.status, "simulated_offline");
  assert.equal(result.mode, "simulated");
  assert.equal(result.providerId, "deterministic-simulator");
  assertNoEffects(result);
}]);

cases.push(["simulated mode rejects provider endpoints and credential classes", async () => {
  const result = await evaluateProviderPolicy({ mode: "simulated", endpoint: PRODIGI_SANDBOX_BASE_URL, credentialClass: "sandbox" });
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.reasons, ["simulated_mode_must_be_offline"]);
  assertNoEffects(result);
}]);

cases.push(["missing sandbox credentials fail before the decision verifier or any external boundary", async () => {
  const fixture = successfulVerifier();
  const input = sandboxInput();
  delete input.credentialClass;
  const result = await evaluateProviderPolicy(input, fixture.verifier);
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.reasons, ["sandbox_credential_class_required"]);
  assert.equal(fixture.calls, 0);
  assertNoEffects(result);
}]);

cases.push(["live or unknown credential classes fail before the decision verifier", async () => {
  const fixture = successfulVerifier();
  for (const credentialClass of ["live", "unknown", null, 5]) {
    const result = await evaluateProviderPolicy(sandboxInput({ credentialClass }), fixture.verifier);
    assert.equal(result.status, "blocked");
    assert.deepEqual(result.reasons, ["sandbox_credential_class_required"]);
    assertNoEffects(result);
  }
  assert.equal(fixture.calls, 0);
}]);

cases.push(["only the exact Prodigi sandbox host is accepted", async () => {
  const fixture = successfulVerifier();
  const sentinel = "provider-matrix-secret-sentinel";
  for (const endpoint of [
    "https://api.prodigi.com/v4.0",
    "https://api.sandbox.prodigi.com.attacker.invalid/v4.0",
    "http://api.sandbox.prodigi.com/v4.0",
    `https://user:${sentinel}@api.sandbox.prodigi.com/v4.0`,
    "https://api.sandbox.prodigi.com:8443/v4.0",
    null,
    17,
    { host: "api.sandbox.prodigi.com" }
  ]) {
    const result = await evaluateProviderPolicy(sandboxInput({ endpoint }), fixture.verifier);
    assert.equal(result.status, "blocked");
    assert.deepEqual(result.reasons, ["sandbox_host_not_allowed"]);
    assert.equal(JSON.stringify(result).includes(sentinel), false);
    assertNoEffects(result);
  }
  assert.equal(fixture.calls, 0);
}]);

cases.push(["only the exact v4 base path is accepted", async () => {
  const fixture = successfulVerifier();
  for (const endpoint of [
    "https://api.sandbox.prodigi.com/v3.0",
    "https://api.sandbox.prodigi.com/v4.0/Orders",
    "https://api.sandbox.prodigi.com/v4.0/../v3.0",
    "https://api.sandbox.prodigi.com/v4.0?mode=live",
    "https://api.sandbox.prodigi.com/v4.0#fragment",
    "https://api.sandbox.prodigi.com/v4.0/"
  ]) {
    const result = await evaluateProviderPolicy(sandboxInput({ endpoint }), fixture.verifier);
    assert.equal(result.status, "blocked");
    assert.deepEqual(result.reasons, ["sandbox_path_not_allowed"]);
    assertNoEffects(result);
  }
  assert.equal(fixture.calls, 0);
}]);

cases.push(["live, unknown, non-string, and object modes fail before any verifier call", async () => {
  const fixture = successfulVerifier();
  for (const mode of ["live", "production", "unknown", null, 7, {}, ["sandbox"]]) {
    const result = await evaluateProviderPolicy(sandboxInput({ mode }), fixture.verifier);
    assert.equal(result.status, "blocked");
    assert.deepEqual(result.reasons, ["unsupported_mode"]);
    assertNoEffects(result);
  }
  assert.equal(fixture.calls, 0);
}]);

cases.push(["providers other than Prodigi remain unsupported and deferred", async () => {
  const fixture = successfulVerifier();
  const result = await evaluateProviderPolicy(sandboxInput({ providerId: "other-provider" }), fixture.verifier);
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.reasons, ["provider_not_supported"]);
  assert.equal(fixture.calls, 0);
  assertNoEffects(result);
}]);

cases.push(["cancel and callback operations remain outside the selected sandbox slice", async () => {
  const fixture = successfulVerifier();
  for (const operation of ["cancel", "webhook", "unknown", 7]) {
    const result = await evaluateProviderPolicy(sandboxInput({ operation }), fixture.verifier);
    assert.equal(result.status, "blocked");
    assert.deepEqual(result.reasons, ["sandbox_operation_not_in_scope"]);
    assertNoEffects(result);
  }
  assert.equal(fixture.calls, 0);
}]);

cases.push(["the product read is in scope only for the fixed owner-delegated selection and needs no account-access attestation", async () => {
  const selection = { operation: "productDetails", sku: "GLOBAL-PHO-4X6", destinationCountryCode: "US", shippingMethod: "Standard", decisionReference: "decision:fixture" };
  // Account access is what this first read tests, so an attestation of it is not required...
  const withoutAccount = successfulVerifier({ sandboxAccountAccessConfirmed: false });
  const permitted = await evaluateProviderPolicy(sandboxInput({ ...selection, adapterId: PRODIGI_SANDBOX_ADAPTER_ID }), withoutAccount.verifier);
  assert.equal(permitted.status, "sandbox_call_permitted");
  assert.deepEqual(permitted.sandboxRoute, { method: "GET", path: "/v4.0/products/{sku}" });
  assert.equal(permitted.networkRequests, 0);
  assert.equal(permitted.credentialReads, 0);
  // ...while the existing quote operation still requires it.
  const quote = await evaluateProviderPolicy(sandboxInput({ ...selection, operation: "quote", adapterId: PRODIGI_SANDBOX_ADAPTER_ID }), withoutAccount.verifier);
  assert.equal(quote.status, "blocked");
  assert.deepEqual(quote.reasons, ["decision_does_not_match_request"]);
  // ...but product approval is still required.
  const unapproved = successfulVerifier({ productAndDestinationApproved: false });
  const refused = await evaluateProviderPolicy(sandboxInput({ ...selection, adapterId: PRODIGI_SANDBOX_ADAPTER_ID }), unapproved.verifier);
  assert.deepEqual(refused.reasons, ["decision_does_not_match_request"]);
  // Any other SKU, destination or shipping method is refused before the verifier runs.
  const fixture = successfulVerifier();
  for (const override of [
    { sku: "GLOBAL-PHO-6X8" }, { sku: "global-pho-4x6" }, { sku: "GLOBAL-PHO-4X6 " }, { sku: "../GLOBAL-PHO-4X6" },
    { destinationCountryCode: "GB" }, { shippingMethod: "Express" }, { shippingMethod: "standard" }
  ]) {
    const result = await evaluateProviderPolicy(sandboxInput({ ...selection, ...override, adapterId: PRODIGI_SANDBOX_ADAPTER_ID }), fixture.verifier);
    assert.equal(result.status, "blocked");
    assert.deepEqual(result.reasons, ["product_read_selection_not_allowed"]);
    assert.equal(result.providerCallPermitted, false);
    assert.equal(result.sandboxRoute, null);
  }
  assert.equal(fixture.calls, 0);
  // The production host and the live credential class stay refused for this operation too.
  for (const override of [{ endpoint: "https://api.prodigi.com/v4.0" }, { credentialClass: "live" }]) {
    const result = await evaluateProviderPolicy(sandboxInput({ ...selection, ...override }), fixture.verifier);
    assert.equal(result.status, "blocked");
  }
  assert.equal(fixture.calls, 0);
}]);

cases.push(["unselected SKU, destination, shipping, or decision evidence fail closed", async () => {
  const fixture = successfulVerifier();
  const variants = [
    [{ sku: "" }, "selected_sku_required"],
    [{ sku: 42 }, "selected_sku_required"],
    [{ destinationCountryCode: "" }, "destination_required"],
    [{ destinationCountryCode: "usa" }, "destination_required"],
    [{ shippingMethod: "" }, "shipping_choice_required"],
    [{ decisionReference: "" }, "decision_reference_required"]
  ];
  for (const [overrides, reason] of variants) {
    const result = await evaluateProviderPolicy(sandboxInput(overrides), fixture.verifier);
    assert.equal(result.status, "blocked");
    assert.deepEqual(result.reasons, [reason]);
    assertNoEffects(result);
  }
  assert.equal(fixture.calls, 0);
}]);

cases.push(["a configured SKU string alone never substitutes for owner decision verification", async () => {
  const result = await evaluateProviderPolicy(sandboxInput());
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.reasons, ["decision_verifier_unavailable"]);
  assertNoEffects(result);
}]);

cases.push(["the decision verifier receives the exact provider, product, destination, shipping, and credential class", async () => {
  const received = [];
  const verifier = {
    async verify(request) {
      received.push(request);
      return {
        ...request,
        productAndDestinationApproved: true,
        sandboxAccountAccessConfirmed: true
      };
    }
  };
  for (const operation of ["quote", "submit", "status"]) {
    const result = await evaluateProviderPolicy(sandboxInput({ operation }), verifier);
    assert.equal(result.status, "sandbox_prerequisites_verified");
    assert.equal(result.sandboxPreconditionsSatisfied, true);
    assert.deepEqual(result.sandboxRoute, PRODIGI_SANDBOX_OPERATION_ENDPOINTS[operation]);
    assert.deepEqual(result.reasons, ["provider_adapter_not_implemented"]);
    assertNoEffects(result);
    assert.deepEqual(received.at(-1), {
      decisionReference: "fixture-only-evidence-reference",
      providerId: "prodigi",
      apiVersion: "v4.0",
      sku: "FIXTURE-ONLY-NOT-AN-APPROVED-SKU",
      destinationCountryCode: "US",
      shippingMethod: "fixture-only-shipping",
      credentialClass: "sandbox"
    });
  }
  assert.equal(received.length, 3);
}]);

cases.push(["a verifier result for a different product, destination, or shipping choice is rejected", async () => {
  for (const overrides of [
    { sku: "OTHER-SKU" },
    { destinationCountryCode: "CA" },
    { shippingMethod: "other-shipping" },
    { credentialClass: "live" },
    { decisionReference: "other-evidence" },
    { productAndDestinationApproved: false },
    { sandboxAccountAccessConfirmed: false }
  ]) {
    const fixture = successfulVerifier(overrides);
    const result = await evaluateProviderPolicy(sandboxInput(), fixture.verifier);
    assert.equal(result.status, "blocked");
    assert.deepEqual(result.reasons, ["decision_does_not_match_request"]);
    assert.equal(fixture.calls, 1);
    assertNoEffects(result);
  }
}]);

cases.push(["verifier errors become safe failures and do not leak the raw error", async () => {
  const sentinel = "sandbox-secret-test-sentinel";
  const result = await evaluateProviderPolicy(sandboxInput(), {
    async verify() { throw new Error(sentinel); }
  });
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.reasons, ["decision_unverified"]);
  assert.equal(JSON.stringify(result).includes(sentinel), false);
  assertNoEffects(result);
}]);

cases.push(["secret-like properties are rejected and never appear in policy output", async () => {
  const sentinel = "sandbox-secret-test-sentinel";
  let secretReads = 0;
  const input = sandboxInput();
  Object.defineProperty(input, "apiKey", {
    enumerable: true,
    get() {
      secretReads += 1;
      return sentinel;
    }
  });
  const result = await evaluateProviderPolicy(input);
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.reasons, ["invalid_configuration"]);
  assert.equal(secretReads, 0);
  assert.equal(JSON.stringify(result).includes(sentinel), false);
  assertNoEffects(result);
}]);

cases.push(["an invalid decision verifier object fails safely", async () => {
  const result = await evaluateProviderPolicy(sandboxInput(), null);
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.reasons, ["decision_verifier_unavailable"]);
  assertNoEffects(result);
}]);

cases.push(["sandbox prerequisite success still cannot call an unimplemented provider adapter", async () => {
  const fixture = successfulVerifier();
  const result = await evaluateProviderPolicy(sandboxInput(), fixture.verifier);
  assert.equal(result.status, "sandbox_prerequisites_verified");
  assert.equal(result.sandboxPreconditionsSatisfied, true);
  assert.equal(result.providerAdapterImplemented, false);
  assert.equal(result.providerCallPermitted, false);
  assert.deepEqual(result.reasons, ["provider_adapter_not_implemented"]);
  assertNoEffects(result);
}]);

cases.push(["only the named sandbox adapter reaches sandbox_call_permitted after full verification", async () => {
  const fixture = successfulVerifier();
  for (const operation of ["quote", "submit", "status"]) {
    const result = await evaluateProviderPolicy(sandboxInput({ operation, adapterId: PRODIGI_SANDBOX_ADAPTER_ID }), fixture.verifier);
    assert.equal(result.status, "sandbox_call_permitted");
    assert.equal(result.providerCallPermitted, true);
    assert.equal(result.providerAdapterImplemented, true);
    assert.deepEqual(result.sandboxRoute, PRODIGI_SANDBOX_OPERATION_ENDPOINTS[operation]);
    assert.deepEqual(result.reasons, []);
    assert.equal(result.networkRequests, 0);
    assert.equal(result.credentialReads, 0);
  }
  const unknown = await evaluateProviderPolicy(sandboxInput({ adapterId: "other-adapter" }), fixture.verifier);
  assert.equal(unknown.status, "blocked");
  assert.deepEqual(unknown.reasons, ["invalid_configuration"]);
  assertNoEffects(unknown);
  const unverified = await evaluateProviderPolicy(sandboxInput({ adapterId: PRODIGI_SANDBOX_ADAPTER_ID }), { async verify() { return undefined; } });
  assert.equal(unverified.status, "blocked");
  assertNoEffects(unverified);
  const simulated = await evaluateProviderPolicy({ mode: "simulated", adapterId: PRODIGI_SANDBOX_ADAPTER_ID });
  assert.deepEqual(simulated.reasons, ["simulated_mode_must_be_offline"]);
  assertNoEffects(simulated);
  const prodigi = PROVIDER_ENVIRONMENT_MATRIX.providers.find((provider) => provider.providerId === "prodigi");
  assert.equal(prodigi.sandboxAdapter.adapterId, PRODIGI_SANDBOX_ADAPTER_ID);
  assert.equal(prodigi.sandboxAdapter.accountTested, false);
  assert.equal(prodigi.operations.submit.implementation, "not_implemented");
}]);

export async function runProviderMatrixSuite() {
  const results = [];
  const originalFetch = globalThis.fetch;
  let outboundFetchCalls = 0;
  globalThis.fetch = async () => {
    outboundFetchCalls += 1;
    throw new Error("provider matrix suite must remain offline");
  };
  try {
    for (const [id, run] of cases) {
      try {
        await run();
        results.push({ id, status: "passed" });
      } catch {
        results.push({ id, status: "failed" });
      }
    }
    results.push({
      id: "the complete matrix suite made zero outbound fetch calls",
      status: outboundFetchCalls === 0 ? "passed" : "failed"
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  return results;
}
