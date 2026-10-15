// Cases for the owner-gated Prodigi sandbox product read (GET /v4.0/products/GLOBAL-PHO-4X6).
// Registered into tests/prodigi-sandbox-suite.mjs, so they run under the network guard with a
// fake credential only. Every request goes to an injected fake port or fake fetch; nothing here
// can reach Prodigi, and the key below is a fixture value.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createEnvServerSecretSource,
  createOneShotProdigiProductReadPort,
  createProdigiProductReadFetchPort,
  PRODIGI_SANDBOX_SECRET_BINDING,
  ProdigiSandboxClient,
  ProdigiSandboxError,
  projectProductReadObservation
} from "../dist/index.js";
import { runProductRead, validateProductReadReceipt, validateReceiptPath } from "../scripts/prodigi-sandbox-product-read.mjs";
import {
  FIXTURE_SANDBOX_KEY,
  fixtureGrantVerifier,
  fixtureVerifier,
  PRODUCT_READ_REFERENCES,
  PRODUCT_READ_SKU,
  PRODUCT_READ_URL,
  productDetailsResponse,
  productReadDecision,
  recordingHttp
} from "./prodigi-sandbox-fixtures.mjs";

const guardPath = fileURLToPath(new URL("./prodigi-sandbox-network-guard.mjs", import.meta.url));
const scriptPath = fileURLToPath(new URL("../scripts/prodigi-sandbox-product-read.mjs", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/u, "");
const REVISION = "1234567890abcdef1234567890abcdef12345678";
const PACKET_SHA = "c".repeat(64);

function newSecrets(events) {
  const source = createEnvServerSecretSource({ bindings: [PRODIGI_SANDBOX_SECRET_BINDING], env: { PRODIGI_SANDBOX_API_KEY: FIXTURE_SANDBOX_KEY } });
  const counter = { loads: 0 };
  return {
    counter,
    source: {
      async load(input) {
        counter.loads += 1;
        events?.push("secret.load");
        return source.load(input);
      }
    }
  };
}

function productClient({ http, grant, secrets = newSecrets().source, verifier = fixtureVerifier(), decision = productReadDecision, enabled = true, timeoutMs, now } = {}) {
  return new ProdigiSandboxClient({
    http: http.port ?? http,
    secrets,
    decision,
    decisionVerifier: verifier,
    ...(grant === null ? {} : { productReadGrantVerifier: grant ?? fixtureGrantVerifier() }),
    sandboxCallsEnabled: enabled,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(now === undefined ? {} : { now })
  });
}

async function rejectsWith(promise, code, sideEffectState, httpStatus) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ProdigiSandboxError, `expected ProdigiSandboxError, got ${error?.name}`);
    assert.equal(error.code, code);
    if (sideEffectState !== undefined) assert.equal(error.sideEffectState, sideEffectState);
    if (httpStatus !== undefined) assert.equal(error.httpStatus, httpStatus);
    const rendered = `${error.message}|${error.stack}|${JSON.stringify(error)}`;
    assert.equal(rendered.includes(FIXTURE_SANDBOX_KEY), false);
    return true;
  });
}

function goodRequest(signal = new AbortController().signal) {
  return { method: "GET", url: PRODUCT_READ_URL, headers: { "X-API-Key": FIXTURE_SANDBOX_KEY, Accept: "application/json" }, signal };
}

// Execute mode reads NODE_OPTIONS (a name, not a secret) before anything else; the key itself is the only other name.
const withoutNodeOptions = (log) => log.filter((entry) => entry !== "get:NODE_OPTIONS");

function countTimers() {
  return process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
}

function tempDirectory() {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "product-read-"));
}

function withTemp(run) {
  const directory = tempDirectory();
  return Promise.resolve().then(() => run(directory)).finally(() => fs.rmSync(directory, { recursive: true, force: true }));
}

export function registerProductReadCases(add) {
  // --- Client: route, gates, grant ------------------------------------------------------

  add("product-read.single-get-exact-url-headers-and-observation", async () => {
    const events = [];
    const grantCalls = [];
    const http = recordingHttp([{ body: productDetailsResponse() }]);
    const client = new ProdigiSandboxClient({
      http: { async send(request) { events.push("http.send"); return http.port.send(request); } },
      secrets: newSecrets(events).source,
      decision: productReadDecision,
      decisionVerifier: { async verify(request) { events.push("decision.verify"); return { ...request, productAndDestinationApproved: true, sandboxAccountAccessConfirmed: false }; } },
      productReadGrantVerifier: { async verify(request) { events.push("grant.verify"); return fixtureGrantVerifier({ calls: grantCalls }).verify(request); } },
      sandboxCallsEnabled: true
    });
    const details = await client.getProductDetails(PRODUCT_READ_REFERENCES);
    // Policy and the trusted grant are both resolved before the key is loaded and before the one request.
    assert.deepEqual(events, ["decision.verify", "grant.verify", "secret.load", "http.send"]);
    assert.equal(http.calls.length, 1);
    const call = http.calls[0];
    assert.equal(call.method, "GET");
    assert.equal(call.url, PRODUCT_READ_URL);
    assert.equal("body" in call && call.body !== undefined, false);
    assert.deepEqual(Object.keys(call.headers).sort(), ["Accept", "X-API-Key"]);
    assert.equal(call.headers["X-API-Key"], FIXTURE_SANDBOX_KEY);
    assert.equal(call.headers.Accept, "application/json");
    assert.equal(details.sku, PRODUCT_READ_SKU);
    assert.ok(Object.isFrozen(details));
    assert.equal(grantCalls.length, 1);
    assert.deepEqual(grantCalls[0], {
      operation: "productDetails", providerId: "prodigi", apiVersion: "v4.0", credentialClass: "sandbox",
      decisionReference: productReadDecision.decisionReference, sku: PRODUCT_READ_SKU, destinationCountryCode: "US", shippingMethod: "Standard",
      method: "GET", url: PRODUCT_READ_URL, maxProviderRequests: 1, maxRetries: 0, ...PRODUCT_READ_REFERENCES
    });
    const observation = projectProductReadObservation(details);
    assert.equal(observation.sku, PRODUCT_READ_SKU);
    assert.deepEqual(observation.finishAttributeValues, ["gloss", "lustre"]);
    assert.deepEqual(observation.attributeNames, ["finish"]);
    assert.equal(observation.variantCount, 2);
    assert.equal(observation.variantsShippingToUS, 1);
    assert.equal(observation.shipsToIncludesUS, true);
    assert.deepEqual(observation.printAreas, [{ name: "default", required: true }]);
    assert.deepEqual(observation.defaultPrintAreaRecommendedPixelSizes, [{ horizontal: 1800, vertical: 1200 }]);
    assert.deepEqual(observation.productDimensions, { width: 6, height: 4, units: "in" });
    assert.match(observation.decodedSha256, /^[a-f0-9]{64}$/u);
    assert.equal(projectProductReadObservation(details).decodedSha256, observation.decodedSha256);
    const changed = (await new ProdigiSandboxClient({
      http: recordingHttp([{ body: productDetailsResponse({ description: "other" }) }]).port, secrets: newSecrets().source, decision: productReadDecision,
      decisionVerifier: fixtureVerifier(), productReadGrantVerifier: fixtureGrantVerifier(), sandboxCallsEnabled: true
    }).getProductDetails(PRODUCT_READ_REFERENCES));
    assert.notEqual(projectProductReadObservation(changed).decodedSha256, observation.decodedSha256);
    // The receipt-safe projection never carries the provider's free text.
    assert.equal(JSON.stringify(observation).includes("SYNTHETIC-DESCRIPTION"), false);
    assert.equal(JSON.stringify(observation).includes("traceParent"), false);
  });

  add("product-read.each-gate-sends-nothing-and-loads-no-key", async () => {
    const scenarios = [
      ["disabled", () => ({ enabled: false }), "sandbox_calls_disabled"],
      ["no grant verifier", () => ({ grant: null }), "grant_unverified"],
      ["decision verifier refuses", () => ({ verifier: fixtureVerifier({ approve: false }) }), "decision_unverified"],
      ["grant verifier returns nothing", () => ({ grant: fixtureGrantVerifier({ answer: () => undefined }) }), "grant_unverified"],
      ["grant verifier throws", () => ({ grant: { async verify() { throw new Error("host down"); } } }), "grant_unverified"],
      ["grant verifier has no verify", () => ({ grant: {} }), "grant_unverified"],
      ["decision SKU is not the delegated one", () => ({ decision: { ...productReadDecision, sku: "GLOBAL-PHO-6X8" } }), "decision_mismatch"],
      ["decision destination is not the delegated one", () => ({ decision: { ...productReadDecision, destinationCountryCode: "GB" } }), "decision_mismatch"],
      ["decision shipping is not the delegated one", () => ({ decision: { ...productReadDecision, shippingMethod: "Express" } }), "decision_mismatch"]
    ];
    for (const [name, build, code] of scenarios) {
      const http = recordingHttp([{ body: productDetailsResponse() }]);
      const secrets = newSecrets();
      await rejectsWith(productClient({ http, secrets: secrets.source, ...build() }).getProductDetails(PRODUCT_READ_REFERENCES), code, "not_dispatched");
      assert.equal(http.calls.length, 0, name);
      assert.equal(secrets.counter.loads, 0, name);
    }
    for (const [name, references] of [
      ["empty permission", { ...PRODUCT_READ_REFERENCES, ownerPermissionReference: "" }],
      ["spaced terms", { ...PRODUCT_READ_REFERENCES, accountTermsReference: "has spaces" }],
      ["overlong budget", { ...PRODUCT_READ_REFERENCES, requestCostBudgetReference: "a".repeat(101) }],
      ["unprefixed binding", { ...PRODUCT_READ_REFERENCES, receiptBinding: "a".repeat(64) }],
      ["short binding", { ...PRODUCT_READ_REFERENCES, receiptBinding: "sha256:abc" }],
      ["missing", undefined],
      ["not an object", "refs"]
    ]) {
      const http = recordingHttp([{ body: productDetailsResponse() }]);
      const secrets = newSecrets();
      await rejectsWith(productClient({ http, secrets: secrets.source }).getProductDetails(references), "invalid_input", "not_dispatched");
      assert.equal(http.calls.length + secrets.counter.loads, 0, name);
    }
    const aborted = new AbortController();
    aborted.abort();
    const http = recordingHttp([{ body: productDetailsResponse() }]);
    const secrets = newSecrets();
    await rejectsWith(productClient({ http, secrets: secrets.source }).getProductDetails(PRODUCT_READ_REFERENCES, aborted.signal), "aborted", "not_dispatched");
    assert.equal(http.calls.length + secrets.counter.loads, 0);
  });

  add("product-read.grant-must-echo-the-exact-request-and-be-unexpired", async () => {
    const bad = [
      ["wrong SKU", (grant) => ({ ...grant, sku: "GLOBAL-PHO-6X8" })],
      ["wrong url", (grant) => ({ ...grant, url: "https://api.sandbox.prodigi.com/v4.0/products/OTHER" })],
      ["wrong method", (grant) => ({ ...grant, method: "POST" })],
      ["wrong permission reference", (grant) => ({ ...grant, ownerPermissionReference: "owner-permission:other" })],
      ["wrong terms reference", (grant) => ({ ...grant, accountTermsReference: "account-terms:other" })],
      ["wrong budget reference", (grant) => ({ ...grant, requestCostBudgetReference: "cost-budget:other" })],
      ["wrong receipt binding", (grant) => ({ ...grant, receiptBinding: `sha256:${"b".repeat(64)}` })],
      ["wrong decision reference", (grant) => ({ ...grant, decisionReference: "decision:other" })],
      ["two requests allowed", (grant) => ({ ...grant, maxProviderRequests: 2 })],
      ["host never states the approved digest (echo-only host)", (grant) => { const { approvedBuiltArtifactSha256, ...rest } = grant; void approvedBuiltArtifactSha256; return rest; }],
      ["host never states the approved revision", (grant) => { const { approvedSourceRevision, ...rest } = grant; void approvedSourceRevision; return rest; }],
      ["host never states the approved owner packet", (grant) => { const { approvedOwnerPacketSha256, ...rest } = grant; void approvedOwnerPacketSha256; return rest; }],
      ["approved digest differs from the candidate", (grant) => ({ ...grant, approvedBuiltArtifactSha256: "e".repeat(64) })],
      ["approved revision differs from the candidate", (grant) => ({ ...grant, approvedSourceRevision: "f".repeat(40) })],
      ["approved owner packet differs from the candidate", (grant) => ({ ...grant, approvedOwnerPacketSha256: "b".repeat(64) })],
      ["retries allowed", (grant) => ({ ...grant, maxRetries: 1 })],
      ["permission not verified", (grant) => ({ ...grant, ownerPermissionVerified: false })],
      ["terms not accepted", (grant) => ({ ...grant, accountTermsAccepted: "yes" })],
      ["budget not approved", (grant) => ({ ...grant, requestCostBudgetApproved: undefined })],
      ["not single use", (grant) => ({ ...grant, singleUse: false })],
      ["missing flag", (grant) => { const { singleUse, ...rest } = grant; void singleUse; return rest; }],
      ["unknown extra field", (grant) => ({ ...grant, extra: true })],
      ["no expiry", (grant) => ({ ...grant, expiresAt: undefined })],
      ["unparseable expiry", (grant) => ({ ...grant, expiresAt: "tomorrow" })],
      ["expired", (grant) => ({ ...grant, expiresAt: new Date(Date.now() - 1000).toISOString() })],
      ["expires now", (grant) => ({ ...grant, expiresAt: new Date(Date.now()).toISOString() })],
      ["array", () => []],
      ["string", () => "approved"],
      ["accessor flag", (grant) => Object.defineProperty({ ...grant }, "singleUse", { enumerable: true, get: () => true })],
      ["non-plain prototype", (grant) => Object.assign(Object.create({ inherited: true }), grant)]
    ];
    for (const [name, answer] of bad) {
      const http = recordingHttp([{ body: productDetailsResponse() }]);
      const secrets = newSecrets();
      await rejectsWith(productClient({ http, secrets: secrets.source, grant: fixtureGrantVerifier({ answer }) }).getProductDetails(PRODUCT_READ_REFERENCES), "grant_unverified", "not_dispatched");
      assert.equal(http.calls.length + secrets.counter.loads, 0, name);
    }
    // The client clock decides expiry, so a grant valid for the injected time passes.
    const http = recordingHttp([{ body: productDetailsResponse() }]);
    const future = Date.now() + 10 * 86_400_000;
    await productClient({ http, grant: fixtureGrantVerifier({ now: future }), now: () => future }).getProductDetails(PRODUCT_READ_REFERENCES);
    assert.equal(http.calls.length, 1);
    // An operator-attested decision alone, with no trusted grant, never reaches the key.
    const secrets = newSecrets();
    await rejectsWith(productClient({ http: recordingHttp([]), secrets: secrets.source, grant: null }).getProductDetails(PRODUCT_READ_REFERENCES), "grant_unverified", "not_dispatched");
    assert.equal(secrets.counter.loads, 0);
  });

  // --- Client: response handling ---------------------------------------------------------

  add("product-read.statuses-redirects-and-failures-never-retry-and-stay-possible", async () => {
    const mapped = new Map([
      [400, "validation_failed"], [401, "authentication_failed"], [403, "authentication_failed"], [404, "not_found"], [429, "rate_limited"],
      [500, "provider_unavailable"], [502, "provider_unavailable"], [503, "provider_unavailable"],
      [301, "provider_unavailable"], [302, "provider_unavailable"], [307, "provider_unavailable"], [308, "provider_unavailable"]
    ]);
    for (const [status, code] of mapped) {
      const http = recordingHttp([{ status, body: {} }, { body: productDetailsResponse() }]);
      await rejectsWith(productClient({ http }).getProductDetails(PRODUCT_READ_REFERENCES), code, "possible", status);
      assert.equal(http.calls.length, 1, `status ${status}`);
    }
    for (const status of [201, 202, 203, 204, 206]) {
      const http = recordingHttp([{ status, body: productDetailsResponse() }, { body: productDetailsResponse() }]);
      await rejectsWith(productClient({ http }).getProductDetails(PRODUCT_READ_REFERENCES), "invalid_response", "possible", status);
      assert.equal(http.calls.length, 1);
    }
    const thrown = recordingHttp([() => { throw new Error(`socket reset ${FIXTURE_SANDBOX_KEY}`); }, { body: productDetailsResponse() }]);
    await rejectsWith(productClient({ http: thrown }).getProductDetails(PRODUCT_READ_REFERENCES), "provider_unavailable", "possible");
    assert.equal(thrown.calls.length, 1);
    const rejected = recordingHttp([() => Promise.reject(new TypeError("redirect mode is set to error")), { body: productDetailsResponse() }]);
    await rejectsWith(productClient({ http: rejected }).getProductDetails(PRODUCT_READ_REFERENCES), "provider_unavailable", "possible");
    assert.equal(rejected.calls.length, 1);
    const hostile = recordingHttp([() => ({ get status() { throw new Error("getter"); }, bodyText: "{}" })]);
    await rejectsWith(productClient({ http: hostile }).getProductDetails(PRODUCT_READ_REFERENCES), "provider_unavailable", "possible");
    assert.equal(hostile.calls.length, 1);
  });

  add("product-read.invalid-and-oversized-bodies-fail-closed-before-any-parse", async () => {
    const originalParse = JSON.parse;
    let parses = 0;
    const counting = (text, reviver) => {
      parses += 1;
      return originalParse(text, reviver);
    };
    const oversizeText = `"${"€".repeat(400_000)}"`;
    const cases = [
      ["invalid JSON", { bodyText: "{not json" }, true],
      ["empty", { bodyText: "" }, false],
      ["non-string", { bodyText: 42 }, false],
      ["null JSON", { bodyText: "null" }, true],
      ["array JSON", { bodyText: "[]" }, true],
      ["outcome Error", { bodyText: JSON.stringify({ ...productDetailsResponse(), outcome: "Error" }) }, true],
      ["SKU mismatch", { bodyText: JSON.stringify(productDetailsResponse({ sku: "GLOBAL-PHO-6X8" })) }, true],
      ["unknown product field", { bodyText: JSON.stringify(productDetailsResponse({ unreviewed: true })) }, true],
      ["missing product", { bodyText: JSON.stringify({ outcome: "Ok" }) }, true],
      ["more than 1 MiB of characters", { bodyText: " ".repeat(1_048_577) }, false],
      ["more than 1 MiB of UTF-8 bytes in fewer characters", { bodyText: oversizeText }, false],
      ["port counted more than 1 MiB", { bodyText: JSON.stringify(productDetailsResponse()), bodyBytes: 1_048_577 }, false],
      ["port count is negative", { bodyText: JSON.stringify(productDetailsResponse()), bodyBytes: -1 }, false],
      ["port count is not an integer", { bodyText: JSON.stringify(productDetailsResponse()), bodyBytes: 1.5 }, false],
      ["port count is a string", { bodyText: JSON.stringify(productDetailsResponse()), bodyBytes: "10" }, false]
    ];
    JSON.parse = counting;
    try {
      for (const [name, response, mayParse] of cases) {
        const transport = createOneShotProdigiProductReadPort({ async send() { return { status: 200, ...response }; } });
        parses = 0;
        await rejectsWith(productClient({ http: transport.port }).getProductDetails(PRODUCT_READ_REFERENCES), "invalid_response", "possible", 200);
        if (!mayParse) assert.equal(parses, 0, `${name} must be refused before JSON.parse`);
        // The transport counted the dispatch itself, whatever the client made of the response.
        const snapshot = transport.snapshot();
        assert.equal(snapshot.dispatched, 1, name);
        assert.equal(snapshot.refused, 0, name);
      }
    } finally {
      JSON.parse = originalParse;
    }
    // Exactly 1 MiB of valid JSON is not oversize.
    const padded = productDetailsResponse();
    const base = JSON.stringify(padded);
    const exact = `${base.slice(0, -1)}${" ".repeat(1_048_576 - base.length)}}`;
    assert.equal(Buffer.byteLength(exact, "utf8"), 1_048_576);
    const ok = await productClient({ http: recordingHttp([{ body: exact }]) }).getProductDetails(PRODUCT_READ_REFERENCES);
    assert.equal(ok.sku, PRODUCT_READ_SKU);
  });

  add("product-read.hard-deadline-when-the-port-ignores-abort", async () => {
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      let lateReject;
      const never = new Promise((_, reject) => { lateReject = reject; });
      let seenSignal;
      const http = { send(request) { seenSignal = request.signal; return never; } };
      const timersBefore = countTimers();
      const started = performance.now();
      await rejectsWith(productClient({ http, timeoutMs: 25 }).getProductDetails(PRODUCT_READ_REFERENCES), "timeout", "possible");
      assert.ok(performance.now() - started < 1000, "the call must settle at its own deadline");
      assert.equal(seenSignal.aborted, true, "the deadline also aborts the signal");
      assert.equal(countTimers(), timersBefore, "no timer is left running");
      lateReject(new Error(`late failure ${FIXTURE_SANDBOX_KEY}`));
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(unhandled, [], "a late port rejection must not become an unhandled rejection");
      // A late success after the deadline cannot revive the call.
      let lateResolve;
      const lateOk = new Promise((resolve) => { lateResolve = resolve; });
      const client = productClient({ http: { send: () => lateOk }, timeoutMs: 25 });
      await rejectsWith(client.getProductDetails(PRODUCT_READ_REFERENCES), "timeout", "possible");
      lateResolve({ status: 200, bodyText: JSON.stringify(productDetailsResponse()) });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(unhandled, []);
      // The deadline covers the whole call: a verifier or secret source that never answers ends it with nothing dispatched,
      // and answering later cannot revive the call into a request.
      const hanging = {
        "decision verifier": (resumes) => ({ verifier: { verify: (request) => new Promise((resolve) => resumes.push(() => resolve({ ...request, productAndDestinationApproved: true, sandboxAccountAccessConfirmed: false }))) } }),
        "grant verifier": (resumes) => ({ grant: { verify: (request) => new Promise((resolve) => resumes.push(() => resolve(fixtureGrantVerifier().verify(request)))) } }),
        "secret source": (resumes) => {
          const real = newSecrets().source;
          return { secrets: { load: (input) => new Promise((resolve) => resumes.push(() => resolve(real.load(input)))) } };
        }
      };
      for (const [name, build] of Object.entries(hanging)) {
        const resumes = [];
        const lateHttp = recordingHttp([{ body: productDetailsResponse() }]);
        const before = countTimers();
        await rejectsWith(productClient({ http: lateHttp, timeoutMs: 25, ...build(resumes) }).getProductDetails(PRODUCT_READ_REFERENCES), "timeout", "not_dispatched");
        assert.equal(countTimers(), before, name);
        for (const resume of resumes) resume();
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(lateHttp.calls.length, 0, `${name}: a continuation after the deadline must not dispatch`);
        assert.deepEqual(unhandled, [], name);
      }
      // A caller signal aborted during the call ends it without a request; aborting afterwards changes nothing.
      const callerAbort = new AbortController();
      const abortHttp = recordingHttp([{ body: productDetailsResponse() }]);
      const resumesAbort = [];
      const abortCall = productClient({ http: abortHttp, grant: { verify: (request) => new Promise((resolve) => resumesAbort.push(() => resolve(fixtureGrantVerifier().verify(request)))) } })
        .getProductDetails(PRODUCT_READ_REFERENCES, callerAbort.signal);
      await new Promise((resolve) => setTimeout(resolve, 5));
      callerAbort.abort();
      resumesAbort.forEach((resume) => resume());
      await rejectsWith(abortCall, "aborted", "not_dispatched");
      assert.equal(abortHttp.calls.length, 0);
      // A port that settles in time leaves no timer behind either.
      const quick = recordingHttp([{ body: productDetailsResponse() }]);
      const before = countTimers();
      await productClient({ http: quick, timeoutMs: 5_000 }).getProductDetails(PRODUCT_READ_REFERENCES);
      assert.equal(countTimers(), before);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  add("product-read.timeout-defaults-to-15-seconds-and-never-exceeds-30", async () => {
    const delays = [];
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (callback, delay, ...rest) => {
      delays.push(delay);
      return originalSetTimeout(callback, delay, ...rest);
    };
    try {
      for (const [timeoutMs, expected] of [[undefined, 15_000], [1, 1], [20_000, 20_000], [30_000, 30_000], [45_000, 30_000], [60_000, 30_000]]) {
        delays.length = 0;
        await productClient({ http: recordingHttp([{ body: productDetailsResponse() }]), ...(timeoutMs === undefined ? {} : { timeoutMs }) }).getProductDetails(PRODUCT_READ_REFERENCES);
        assert.deepEqual(delays.filter((delay) => delay >= 1), [expected], `timeoutMs ${timeoutMs}`);
      }
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  add("product-read.second-call-is-blocked-before-any-gate-key-or-port", async () => {
    const http = recordingHttp([{ body: productDetailsResponse() }, { body: productDetailsResponse() }]);
    const secrets = newSecrets();
    const grantCalls = [];
    const client = productClient({ http, secrets: secrets.source, grant: fixtureGrantVerifier({ calls: grantCalls }) });
    await client.getProductDetails(PRODUCT_READ_REFERENCES);
    await rejectsWith(client.getProductDetails(PRODUCT_READ_REFERENCES), "request_budget_exhausted", "not_dispatched");
    assert.equal(http.calls.length, 1);
    assert.equal(secrets.counter.loads, 1);
    assert.equal(grantCalls.length, 1);
    // A failed attempt consumes the claim too: there is no retry.
    const failing = recordingHttp([{ status: 503, body: {} }, { body: productDetailsResponse() }]);
    const retrying = productClient({ http: failing });
    await rejectsWith(retrying.getProductDetails(PRODUCT_READ_REFERENCES), "provider_unavailable", "possible", 503);
    await rejectsWith(retrying.getProductDetails(PRODUCT_READ_REFERENCES), "request_budget_exhausted", "not_dispatched");
    assert.equal(failing.calls.length, 1);
    const gated = productClient({ http: recordingHttp([]), enabled: false });
    await rejectsWith(gated.getProductDetails(PRODUCT_READ_REFERENCES), "sandbox_calls_disabled", "not_dispatched");
    await rejectsWith(gated.getProductDetails(PRODUCT_READ_REFERENCES), "request_budget_exhausted", "not_dispatched");
    // Concurrent calls: the claim is taken before the first await, so exactly one proceeds.
    const concurrentHttp = recordingHttp([{ body: productDetailsResponse() }, { body: productDetailsResponse() }]);
    const concurrent = productClient({ http: concurrentHttp });
    const settled = await Promise.allSettled([concurrent.getProductDetails(PRODUCT_READ_REFERENCES), concurrent.getProductDetails(PRODUCT_READ_REFERENCES), concurrent.getProductDetails(PRODUCT_READ_REFERENCES)]);
    assert.equal(settled.filter((entry) => entry.status === "fulfilled").length, 1);
    assert.deepEqual(settled.filter((entry) => entry.status === "rejected").map((entry) => entry.reason.code), ["request_budget_exhausted", "request_budget_exhausted"]);
    assert.equal(concurrentHttp.calls.length, 1);
  });

  add("product-read.one-shot-port-lets-only-the-exact-request-through-once", async () => {
    const innerCalls = [];
    const inner = { async send(request) { innerCalls.push(request); return { status: 200, bodyText: "é{}", bodyBytes: 4 }; } };
    const good = createOneShotProdigiProductReadPort(inner);
    assert.deepEqual(good.snapshot(), { attempts: 0, dispatched: 0, refused: 0, state: "idle", responseStatus: null, responseBytes: null });
    const response = await good.port.send(goodRequest());
    assert.equal(response.status, 200);
    assert.deepEqual(good.snapshot(), { attempts: 1, dispatched: 1, refused: 0, state: "returned", responseStatus: 200, responseBytes: 4 });
    for (let attempt = 0; attempt < 3; attempt += 1) await assert.rejects(good.port.send(goodRequest()), /refused/u);
    assert.equal(innerCalls.length, 1, "a second request never reaches the port");
    assert.deepEqual(good.snapshot(), { attempts: 4, dispatched: 1, refused: 3, state: "returned", responseStatus: 200, responseBytes: 4 });
    // Without a port-side count the UTF-8 length of the text is used.
    const noCount = createOneShotProdigiProductReadPort({ async send() { return { status: 200, bodyText: "é" }; } });
    await noCount.port.send(goodRequest());
    assert.equal(noCount.snapshot().responseBytes, 2);
    // Concurrent calls: the second is refused synchronously, before the first resolves.
    let release;
    const slow = createOneShotProdigiProductReadPort({ send: () => new Promise((resolve) => { release = resolve; }) });
    const first = slow.port.send(goodRequest());
    await assert.rejects(slow.port.send(goodRequest()), /refused/u);
    assert.equal(slow.snapshot().state, "pending");
    release({ status: 200, bodyText: "{}" });
    await first;
    assert.equal(slow.snapshot().dispatched, 1);
    const wrong = [
      ["POST", { method: "POST" }], ["lower-case method", { method: "get" }],
      ["quote URL", { url: "https://api.sandbox.prodigi.com/v4.0/quotes" }],
      ["other SKU", { url: "https://api.sandbox.prodigi.com/v4.0/products/GLOBAL-PHO-6X8" }],
      ["order read", { url: "https://api.sandbox.prodigi.com/v4.0/orders/ord_1" }],
      ["query added", { url: `${PRODUCT_READ_URL}?expand=all` }], ["fragment added", { url: `${PRODUCT_READ_URL}#x` }],
      ["trailing slash", { url: `${PRODUCT_READ_URL}/` }], ["double slash", { url: PRODUCT_READ_URL.replace("/v4.0/", "//v4.0/") }],
      ["production host", { url: "https://api.prodigi.com/v4.0/products/GLOBAL-PHO-4X6" }],
      ["lookalike host", { url: "https://api.sandbox.prodigi.com.evil.example/v4.0/products/GLOBAL-PHO-4X6" }],
      ["userinfo host", { url: "https://api.sandbox.prodigi.com@evil.example/v4.0/products/GLOBAL-PHO-4X6" }],
      ["plain http", { url: PRODUCT_READ_URL.replace("https:", "http:") }], ["upper-case host", { url: PRODUCT_READ_URL.replace("api.sandbox", "API.sandbox") }],
      ["extra header", { headers: { "X-API-Key": FIXTURE_SANDBOX_KEY, Accept: "application/json", "Content-Type": "application/json" } }],
      ["missing Accept", { headers: { "X-API-Key": FIXTURE_SANDBOX_KEY } }],
      ["wrong Accept", { headers: { "X-API-Key": FIXTURE_SANDBOX_KEY, Accept: "*/*" } }],
      ["empty key", { headers: { "X-API-Key": "", Accept: "application/json" } }],
      ["body", { body: "{}" }], ["no signal", { signal: undefined }], ["no headers", { headers: undefined }]
    ];
    for (const [name, override] of wrong) {
      const calls = [];
      const transport = createOneShotProdigiProductReadPort({ async send(request) { calls.push(request); return { status: 200, bodyText: "{}" }; } });
      await assert.rejects(transport.port.send({ ...goodRequest(), ...override }), /refused/u, name);
      assert.equal(calls.length, 0, name);
      assert.deepEqual(transport.snapshot(), { attempts: 1, dispatched: 0, refused: 1, state: "idle", responseStatus: null, responseBytes: null }, name);
      await assert.rejects(transport.port.send(goodRequest()), /refused/u, `${name}: the one shot is consumed`);
      assert.equal(calls.length, 0);
    }
    await assert.rejects(createOneShotProdigiProductReadPort(inner).port.send(null), /refused/u);
    const threw = createOneShotProdigiProductReadPort({ async send() { throw new Error("socket"); } });
    await assert.rejects(threw.port.send(goodRequest()), /socket/u);
    assert.deepEqual(threw.snapshot(), { attempts: 1, dispatched: 1, refused: 0, state: "threw", responseStatus: null, responseBytes: null });
    const hostile = createOneShotProdigiProductReadPort({ async send() { return { get status() { throw new Error("getter"); }, bodyText: "{}" }; } });
    await hostile.port.send(goodRequest());
    assert.equal(hostile.snapshot().dispatched, 1);
  });

  add("product-read.fetch-port-requests-only-the-fixed-url-without-redirects-and-counts-native-bytes", async () => {
    const seen = [];
    const body = JSON.stringify(productDetailsResponse());
    const port = createProdigiProductReadFetchPort(async (url, init) => {
      seen.push({ url, init });
      return new Response(body, { status: 200 });
    });
    const signal = new AbortController().signal;
    const response = await port.send({ ...goodRequest(signal), headers: { "X-API-Key": FIXTURE_SANDBOX_KEY, Accept: "application/json" } });
    assert.deepEqual(response, { status: 200, bodyText: body, bodyBytes: Buffer.byteLength(body, "utf8") });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, PRODUCT_READ_URL);
    assert.deepEqual(Object.keys(seen[0].init).sort(), ["headers", "method", "redirect", "signal"]);
    assert.equal(seen[0].init.method, "GET");
    assert.equal(seen[0].init.redirect, "error");
    assert.deepEqual(seen[0].init.headers, { "X-API-Key": FIXTURE_SANDBOX_KEY, Accept: "application/json" });
    assert.equal(seen[0].init.signal, signal);
    for (const override of [{ method: "POST" }, { url: "https://api.sandbox.prodigi.com/v4.0/quotes" }, { body: "x" }, { headers: {} }]) {
      await assert.rejects(port.send({ ...goodRequest(signal), ...override }), /refused/u);
    }
    assert.equal(seen.length, 1, "refused requests never reach fetch");
    const multibyte = createProdigiProductReadFetchPort(async () => new Response("é€", { status: 200 }));
    assert.deepEqual(await multibyte.send(goodRequest()), { status: 200, bodyText: "é€", bodyBytes: 5 });
    let cancelledError = false;
    const errorBody = createProdigiProductReadFetchPort(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("secret-error-body")); }, cancel() { cancelledError = true; } }), { status: 503 }));
    assert.deepEqual(await errorBody.send(goodRequest()), { status: 503, bodyText: "", bodyBytes: 0 });
    assert.equal(cancelledError, true);
    // The stream is cut as soon as the native byte count passes 1 MiB; nothing is decoded.
    let pulled = 0;
    let cancelled = false;
    const chunk = new Uint8Array(65_536).fill(97);
    const streamed = createProdigiProductReadFetchPort(async () => new Response(new ReadableStream({
      pull(controller) { pulled += 1; controller.enqueue(chunk); },
      cancel() { cancelled = true; }
    }), { status: 200 }));
    const big = await streamed.send(goodRequest());
    assert.equal(big.bodyText, "");
    assert.ok(big.bodyBytes > 1_048_576);
    assert.equal(cancelled, true);
    assert.ok(pulled <= 18, `read ${pulled} chunks past the limit`);
    let declaredCancelled = false;
    const declared = createProdigiProductReadFetchPort(async () => new Response(new ReadableStream({ cancel() { declaredCancelled = true; } }), { status: 200, headers: { "content-length": "5000000" } }));
    assert.deepEqual(await declared.send(goodRequest()), { status: 200, bodyText: "", bodyBytes: 5_000_000 });
    assert.equal(declaredCancelled, true);
    // fetch itself refuses to follow a redirect (redirect: "error" throws); the client then reports one dispatched, uncertain request.
    const redirecting = createOneShotProdigiProductReadPort(createProdigiProductReadFetchPort(async () => { throw new TypeError("redirect mode is set to error"); }));
    await rejectsWith(productClient({ http: redirecting.port }).getProductDetails(PRODUCT_READ_REFERENCES), "provider_unavailable", "possible");
    assert.equal(redirecting.snapshot().dispatched, 1);
    const status301 = createOneShotProdigiProductReadPort(createProdigiProductReadFetchPort(async () => new Response(null, { status: 301, headers: { location: "https://evil.example/" } })));
    await rejectsWith(productClient({ http: status301.port }).getProductDetails(PRODUCT_READ_REFERENCES), "provider_unavailable", "possible", 301);
    assert.equal(status301.snapshot().dispatched, 1);
  });

  add("product-read.errors-and-observations-never-carry-the-key-body-or-description", async () => {
    const hostileBody = JSON.stringify({ outcome: "Error", detail: `echo ${FIXTURE_SANDBOX_KEY}`, description: "SYNTHETIC-DESCRIPTION-MUST-NOT-REACH-A-RECEIPT" });
    const failures = [];
    for (const response of [{ status: 200, body: hostileBody }, { status: 401, body: hostileBody }, { status: 500, body: hostileBody }]) {
      try {
        await productClient({ http: recordingHttp([response]) }).getProductDetails(PRODUCT_READ_REFERENCES);
        assert.fail("expected a failure");
      } catch (error) {
        failures.push(error);
      }
    }
    for (const error of failures) {
      const rendered = `${error.message}|${error.stack}|${JSON.stringify(error)}|${String(error.cause)}|${Object.keys(error).join()}`;
      assert.equal(rendered.includes(FIXTURE_SANDBOX_KEY), false);
      assert.equal(rendered.includes("SYNTHETIC-DESCRIPTION"), false);
      assert.equal(rendered.includes("echo"), false);
      assert.deepEqual(Object.keys(error).sort(), ["code", "httpStatus", "name", "sideEffectState"]);
    }
  });

  // --- Command line: preflight and refusals -------------------------------------------------

  const validArgs = (receiptPath, drop = []) => {
    const pairs = [
      ["--decision-reference", productReadDecision.decisionReference],
      ["--owner-permission-reference", PRODUCT_READ_REFERENCES.ownerPermissionReference],
      ["--account-terms-reference", PRODUCT_READ_REFERENCES.accountTermsReference],
      ["--request-cost-budget-reference", PRODUCT_READ_REFERENCES.requestCostBudgetReference],
      ["--source-revision", REVISION],
      ["--owner-packet-sha256", PACKET_SHA],
      ["--receipt-path", receiptPath]
    ];
    return pairs.filter(([name]) => !drop.includes(name)).flat();
  };

  const spawnScript = (args, { env = { PATH: process.env.PATH ?? "" }, nodeArgs = [] } = {}) => spawnSync(process.execPath, ["--import", guardPath, ...nodeArgs, scriptPath, ...args], { encoding: "utf8", env, timeout: 30_000 });

  add("script.product-read-preflight-names-every-missing-gate-with-zero-requests", async () => {
    // The fixture key is present in the child's environment only to show that it is neither read nor echoed.
    const child = spawnScript([], { env: { PATH: process.env.PATH ?? "", PRODIGI_SANDBOX_API_KEY: FIXTURE_SANDBOX_KEY } });
    assert.equal(child.status, 2);
    assert.equal(child.stderr, "");
    assert.equal(child.stdout.includes(FIXTURE_SANDBOX_KEY), false);
    const report = JSON.parse(child.stdout);
    assert.equal(report.schema, "prodigi-sandbox-product-read-preflight/1");
    assert.equal(report.mode, "preflight");
    assert.equal(report.execution, "NOT_EXECUTED");
    assert.equal(report.status, "PREFLIGHT_REFUSED_GATES_MISSING");
    assert.equal(report.authorizesExecution, false);
    assert.equal(report.requestCost, "UNKNOWN");
    assert.deepEqual([report.externalProviderCalls, report.credentialReads, report.networkRequests], [0, 0, 0]);
    assert.deepEqual(report.compiledSelection, { sku: "GLOBAL-PHO-4X6", destinationCountryCode: "US", shippingMethod: "Standard" });
    // The spawned child carries the suite's own --import network guard, which the preload gate rightly flags.
    assert.deepEqual(report.missingGates.sort(), [
      "account_terms_reference", "built_artifact_approved_by_trusted_host", "decision_reference", "no_untrusted_preload", "owner_packet_sha256", "owner_permission_reference",
      "receipt_path_outside_git", "request_cost_budget_reference", "source_revision_immutable", "trusted_host_grant_verifier"
    ]);
    const plan = report.requestPlan;
    assert.equal(plan.method, "GET");
    assert.equal(plan.url, PRODUCT_READ_URL);
    assert.equal(plan.body, null);
    assert.deepEqual([plan.maxProviderRequests, plan.retries, plan.redirect, plan.timeoutMs, plan.maxResponseBytes], [1, 0, "error", 15_000, 1_048_576]);
    assert.deepEqual([plan.quote, plan.orders, plan.live], [false, false, false]);
    const states = Object.fromEntries(report.gates.map((entry) => [entry.id, entry.state]));
    assert.equal(states.compiled_selection, "satisfied");
    assert.equal(states.no_whole_env_file_loading, "satisfied");
    assert.equal(states.trusted_host_grant_verifier, "unavailable");
    // What the command line cannot establish is listed apart from the gates and never reads as verified.
    assert.deepEqual(report.unverifiedAssertions.map((entry) => [entry.id, entry.state]), [
      ["built_artifact_reviewed", "approval_pending"], ["compiled_tuple_verified_by_authority", "not_verified_operator_attestation_only"],
      ["account_access", "not_asserted"], ["request_cost", "UNKNOWN"], ["customer_authority", "none"]
    ]);
    assert.equal(report.gates.some((entry) => entry.id.includes("compiled_tuple")), false);
    assert.equal(report.builtArtifact.state, "approval_pending");
    assert.match(report.builtArtifact.candidateSha256, /^[a-f0-9]{64}$/u);
    assert.equal(states.built_artifact_inventory, "satisfied");
    assert.equal(states.built_artifact_approved_by_trusted_host, "unverified");
    assert.equal(report.trustedHostInterface.method, "verifyProductReadGrant(request)");
    assert.ok(report.trustedHostInterface.request.includes("ownerPermissionReference") && report.trustedHostInterface.request.includes("receiptBinding"));
    assert.ok(report.trustedHostInterface.notAuthority.includes("an operator attestation boolean"));
    assert.match(report.gates.find((entry) => entry.id === "source_revision_immutable").note, /./u);
    // A symlinked invocation path must still run and print its report, never exit 0 silently.
    await withTemp(async (directory) => {
      const link = path.join(directory, "linked-product-read.mjs");
      fs.symlinkSync(scriptPath, link);
      const viaLink = spawnSync(process.execPath, ["--import", guardPath, link], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" }, timeout: 30_000 });
      assert.equal(viaLink.status, 2);
      assert.equal(JSON.parse(viaLink.stdout).schema, "prodigi-sandbox-product-read-preflight/1");
    });
  });

  add("script.product-read-flags-each-missing-malformed-or-unverifiable-reference", async () => {
    await withTemp(async (directory) => {
      const receipt = path.join(directory, "receipt.json");
      const stateOf = (child, id) => JSON.parse(child.stdout).gates.find((entry) => entry.id === id)?.state;
      const full = spawnScript(validArgs(receipt));
      assert.equal(full.status, 2, "even complete references cannot pass without a trusted host");
      const report = JSON.parse(full.stdout);
      assert.equal(report.authorizesExecution, false);
      for (const id of ["owner_permission_reference", "account_terms_reference", "request_cost_budget_reference"]) {
        assert.equal(report.gates.find((entry) => entry.id === id).state, "unverified", "a reference that exists is not authority");
      }
      assert.equal(report.gates.find((entry) => entry.id === "decision_reference").state, "attested_only");
      assert.equal(report.gates.find((entry) => entry.id === "receipt_path_outside_git").state, "satisfied");
      assert.deepEqual(report.missingGates.sort(), ["owner_permission_reference", "account_terms_reference", "request_cost_budget_reference", "source_revision_immutable", "trusted_host_grant_verifier", "built_artifact_approved_by_trusted_host", "no_untrusted_preload"].sort());
      for (const [flag, id] of [["--decision-reference", "decision_reference"], ["--owner-permission-reference", "owner_permission_reference"],
        ["--account-terms-reference", "account_terms_reference"], ["--request-cost-budget-reference", "request_cost_budget_reference"],
        ["--source-revision", "source_revision_immutable"], ["--owner-packet-sha256", "owner_packet_sha256"], ["--receipt-path", "receipt_path_outside_git"]]) {
        assert.equal(stateOf(spawnScript(validArgs(receipt, [flag])), id), "missing", flag);
      }
      for (const [flag, id] of [["--decision-reference", "decision_reference"], ["--owner-permission-reference", "owner_permission_reference"],
        ["--account-terms-reference", "account_terms_reference"], ["--request-cost-budget-reference", "request_cost_budget_reference"],
        ["--source-revision", "source_revision_immutable"], ["--owner-packet-sha256", "owner_packet_sha256"]]) {
        for (const bad of ["has space", "", "../x", "a".repeat(101), "x".repeat(3)]) {
          const args = validArgs(receipt);
          args[args.indexOf(flag) + 1] = bad;
          const state = stateOf(spawnScript(args), id);
          assert.ok(["invalid", "missing"].includes(state) || (id === "decision_reference" && state === "attested_only" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u.test(bad)) ||
            (state === "unverified" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u.test(bad)), `${flag}=${JSON.stringify(bad)} -> ${state}`);
          if (/[ /]/u.test(bad) || bad === "" || bad.length > 100) assert.equal(state, "invalid", `${flag}=${JSON.stringify(bad)}`);
        }
      }
      // A revision that is not the checked-out HEAD can never pass.
      assert.ok(["invalid", "unverified"].includes(stateOf(spawnScript(validArgs(receipt)), "source_revision_immutable")));
    });
  });

  add("script.product-read-refuses-unknown-options-env-file-loading-and-execute-without-a-trusted-host", async () => {
    await withTemp(async (directory) => {
      const receipt = path.join(directory, "receipt.json");
      for (const args of [["--sku", "OTHER"], ["--country", "GB"], ["--shipping", "Express"], ["--url", "https://example.invalid/"], ["--host", "api.prodigi.com"],
        ["--read-order", "ord_1"], ["--api-key", FIXTURE_SANDBOX_KEY], ["--attributes", "{}"], ["positional"], ["--receipt-path"]]) {
        const child = spawnScript([...validArgs(receipt), ...args]);
        assert.equal(child.status, 2, args.join(" "));
        assert.equal(JSON.parse(child.stdout).status, "REFUSED_UNKNOWN_OR_MALFORMED_OPTION");
        assert.equal(child.stdout.includes(FIXTURE_SANDBOX_KEY), false);
        assert.equal(child.stderr, "");
      }
      // node --env-file would load a whole .env into the process before any gate.
      const envFile = path.join(directory, "fixture.env");
      fs.writeFileSync(envFile, `PRODIGI_SANDBOX_API_KEY=${FIXTURE_SANDBOX_KEY}\nUNRELATED_FIXTURE_VARIABLE=1\n`);
      const loaded = spawnScript(validArgs(receipt), { nodeArgs: [`--env-file=${envFile}`] });
      assert.equal(loaded.status, 2);
      assert.equal(loaded.stdout.includes(FIXTURE_SANDBOX_KEY), false);
      const loadedReport = JSON.parse(loaded.stdout);
      assert.equal(loadedReport.gates.find((entry) => entry.id === "no_whole_env_file_loading").state, "invalid");
      assert.ok(loadedReport.missingGates.includes("no_whole_env_file_loading"));
      const loadedExecute = spawnScript([...validArgs(receipt), "--execute", "--owner-approved"], { nodeArgs: [`--env-file=${envFile}`] });
      assert.equal(loadedExecute.status, 2);
      assert.equal(JSON.parse(loadedExecute.stdout).execution, "NOT_EXECUTED");
      // --execute from this command line has no trusted host, so it refuses with no receipt, no key read and no request.
      const execute = spawnScript([...validArgs(receipt), "--execute", "--owner-approved"], { env: { PATH: process.env.PATH ?? "", PRODIGI_SANDBOX_API_KEY: FIXTURE_SANDBOX_KEY } });
      assert.equal(execute.status, 2);
      assert.equal(execute.stderr, "");
      assert.equal(execute.stdout.includes(FIXTURE_SANDBOX_KEY), false);
      const refusal = JSON.parse(execute.stdout);
      assert.equal(refusal.status, "REFUSED_GATES_MISSING");
      assert.equal(refusal.execution, "NOT_EXECUTED");
      assert.ok(refusal.missingGates.includes("trusted_host_grant_verifier"));
      assert.deepEqual([refusal.externalProviderCalls, refusal.credentialReads, refusal.networkRequests], [0, 0, 0]);
      assert.equal(fs.existsSync(receipt), false, "a refused run creates no receipt");
      const noFlag = JSON.parse(spawnScript([...validArgs(receipt), "--execute"]).stdout);
      assert.ok(noFlag.missingGates.includes("owner_approved_flag"));
    });
  });

  add("script.product-read-receipt-location-rules", async () => {
    await withTemp(async (directory) => {
      const code = (value) => validateReceiptPath(value).code;
      assert.deepEqual(validateReceiptPath(path.join(directory, "receipt.json")), { ok: true });
      assert.equal(code(undefined), "receipt_path_invalid");
      assert.equal(code(""), "receipt_path_invalid");
      assert.equal(code(`${directory}/a\u0000.json`), "receipt_path_invalid");
      assert.equal(code("receipt.json"), "receipt_path_not_absolute");
      assert.equal(code("../receipt.json"), "receipt_path_not_absolute");
      assert.equal(code(`${directory}/../${path.basename(directory)}/receipt.json`), "receipt_path_not_normalized");
      assert.equal(code(`${directory}//receipt.json`), "receipt_path_not_normalized");
      assert.equal(code(`${directory}/./receipt.json`), "receipt_path_not_normalized");
      for (const name of [".env", ".env.json", "receipt.txt", "receipt", "-receipt.json", ".hidden.json", "a b.json", `${"a".repeat(129)}.json`]) {
        assert.equal(code(path.join(directory, name)), "receipt_name_invalid", name);
      }
      assert.equal(code(path.join(directory, "missing-directory", "receipt.json")), "receipt_parent_missing");
      const filePath = path.join(directory, "plain-file");
      fs.writeFileSync(filePath, "x");
      assert.equal(code(path.join(filePath, "receipt.json")), "receipt_parent_not_directory");
      const realParent = path.join(directory, "real");
      fs.mkdirSync(realParent);
      fs.symlinkSync(realParent, path.join(directory, "link"));
      assert.equal(code(path.join(directory, "link", "receipt.json")), "receipt_path_contains_symlink");
      assert.equal(code(path.join(repositoryRoot, "receipt.json")), "receipt_path_inside_repository");
      assert.equal(code(path.join(repositoryRoot, "docs", "receipt.json")), "receipt_path_inside_repository");
      const worktree = path.join(directory, "other-worktree");
      fs.mkdirSync(path.join(worktree, ".git"), { recursive: true });
      fs.mkdirSync(path.join(worktree, "nested"));
      assert.equal(code(path.join(worktree, "receipt.json")), "receipt_path_inside_git_worktree");
      assert.equal(code(path.join(worktree, "nested", "receipt.json")), "receipt_path_inside_git_worktree");
      const gitFileTree = path.join(directory, "linked-worktree");
      fs.mkdirSync(gitFileTree);
      fs.writeFileSync(path.join(gitFileTree, ".git"), "gitdir: /elsewhere\n");
      assert.equal(code(path.join(gitFileTree, "receipt.json")), "receipt_path_inside_git_worktree");
      const envAdjacent = path.join(directory, "env-adjacent");
      fs.mkdirSync(envAdjacent);
      fs.writeFileSync(path.join(envAdjacent, ".env.fixture"), "FIXTURE=1\n");
      assert.equal(code(path.join(envAdjacent, "receipt.json")), "receipt_parent_env_adjacent");
      const existing = path.join(directory, "existing.json");
      fs.writeFileSync(existing, "{}");
      assert.equal(code(existing), "receipt_path_exists");
      const dangling = path.join(directory, "dangling.json");
      fs.symlinkSync(path.join(directory, "nowhere"), dangling);
      assert.equal(code(dangling), "receipt_path_exists", "a dangling symlink at the target is not a free path");
    });
  });

  // --- Command line: execution through an injected trusted host --------------------------------

  const trustedHost = ({ calls = [], events, answer } = {}) => ({
    async verifyProductReadGrant(request) {
      calls.push(request);
      events?.push("host.verify");
      const grant = {
        ...request, ownerPermissionVerified: true, accountTermsAccepted: true, requestCostBudgetApproved: true, singleUse: true,
        approvedSourceRevision: request.sourceRevision, approvedBuiltArtifactSha256: request.builtArtifactSha256, approvedOwnerPacketSha256: request.ownerPacketSha256,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString()
      };
      return answer === undefined ? grant : answer(grant);
    }
  });

  const spyEnv = (log, values = { PRODIGI_SANDBOX_API_KEY: FIXTURE_SANDBOX_KEY, UNRELATED_FIXTURE_VARIABLE: "unrelated" }) => new Proxy(values, {
    get(target, key) { log.push(`get:${String(key)}`); return target[key]; },
    has(target, key) { log.push(`has:${String(key)}`); return key in target; },
    ownKeys(target) { log.push("ownKeys"); return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, key) { log.push(`descriptor:${String(key)}`); return Reflect.getOwnPropertyDescriptor(target, key); }
  });

  const fakeFetch = (respond, events) => {
    const calls = [];
    const impl = async (url, init) => {
      calls.push({ url, init });
      events?.push("fetch");
      return respond(url, init);
    };
    return { calls, impl };
  };

  const tracedFs = (events, overrides = {}) => ({
    ...fs,
    openSync: (file, flags, mode) => {
      // Only the exclusive receipt open ("wx") is traced or overridden; the built-artifact reads use numeric flags.
      const receipt = flags === "wx";
      if (receipt) events.push("receipt.open");
      return (receipt && overrides.openSync !== undefined ? overrides.openSync : fs.openSync)(file, flags, mode);
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([name]) => name !== "openSync"))
  });

  async function execute(directory, { respond, host = trustedHost(), extraArgs = [], fsApi, events = [], envLog = [], envValues, execArgv = [], run = runProductRead, name = "receipt.json" } = {}) {
    const receipt = path.join(directory, name);
    const fetcher = fakeFetch(respond ?? (() => new Response(JSON.stringify(productDetailsResponse()), { status: 200 })), events);
    const result = await run([...validArgs(receipt), "--execute", "--owner-approved", ...extraArgs], {
      host, env: spyEnv(envLog, envValues), fetch: fetcher.impl, fs: fsApi ?? tracedFs(events), git: () => ({ head: REVISION, clean: true }), execArgv
    });
    return { result, receipt, fetcher, events, envLog };
  }

  add("script.product-read-execute-with-a-trusted-host-writes-one-sanitized-exclusive-receipt", async () => {
    await withTemp(async (directory) => {
      const hostCalls = [];
      const events = [];
      // What the receipt file holds at the moment the one request is in flight.
      let inFlight = null;
      const expectedReceipt = path.join(directory, "receipt.json");
      const respond = () => {
        inFlight = { text: fs.readFileSync(expectedReceipt, "utf8"), mode: fs.statSync(expectedReceipt).mode & 0o777 };
        return new Response(JSON.stringify(productDetailsResponse()), { status: 200 });
      };
      const { result, receipt, fetcher, envLog } = await execute(directory, { host: trustedHost({ calls: hostCalls, events }), events, respond });
      assert.equal(result.exitCode, 0);
      assert.equal(result.output.status, "ok");
      assert.equal(result.output.execution, "EXECUTED");
      assert.equal(result.output.receiptWritten, true);
      assert.deepEqual([result.output.externalProviderCalls, result.output.credentialReads, result.output.networkRequests], [1, 1, 1]);
      // Order: gate-stage host check, exclusive receipt, the client's own host check, then the one key read, then the one request.
      assert.equal(events[0], "host.verify");
      assert.ok(events.indexOf("receipt.open") > events.indexOf("host.verify"));
      assert.deepEqual(events.filter((event) => event === "fetch"), ["fetch"]);
      assert.ok(events.lastIndexOf("host.verify") > events.indexOf("receipt.open"));
      assert.equal(hostCalls.length, 2);
      assert.deepEqual(hostCalls[0], hostCalls[1]);
      assert.equal(hostCalls[0].receiptBinding.length, 71);
      assert.equal(fetcher.calls.length, 1);
      assert.equal(fetcher.calls[0].url, PRODUCT_READ_URL);
      assert.equal(fetcher.calls[0].init.headers["X-API-Key"], FIXTURE_SANDBOX_KEY);
      // A crash during the request must leave evidence that a dispatch may have happened, not an empty file.
      const early = JSON.parse(inFlight.text);
      assert.equal(early.status, "in_flight_dispatch_unknown");
      assert.equal(early.sourceRevision, REVISION);
      assert.equal(early.refs.ownerPermission, PRODUCT_READ_REFERENCES.ownerPermissionReference);
      assert.equal("decoded" in early || "outcome" in early, false);
      assert.equal(inFlight.text.includes(FIXTURE_SANDBOX_KEY), false);
      if (process.platform !== "win32") assert.equal(inFlight.mode, 0o600);
      assert.equal(fetcher.calls[0].init.redirect, "error");
      // Only the one named variable is ever touched, once, and only after the receipt exists.
      assert.deepEqual(envLog, ["get:NODE_OPTIONS", "get:PRODIGI_SANDBOX_API_KEY"]);
      const written = fs.readFileSync(receipt, "utf8");
      assert.deepEqual(JSON.parse(written), result.output.receipt);
      assert.deepEqual(validateProductReadReceipt(result.output.receipt, { forbiddenText: [FIXTURE_SANDBOX_KEY] }), []);
      if (process.platform !== "win32") assert.equal(fs.statSync(receipt).mode & 0o777, 0o600);
      const parsed = result.output.receipt;
      assert.deepEqual(parsed.refs, {
        decision: productReadDecision.decisionReference, ownerPermission: PRODUCT_READ_REFERENCES.ownerPermissionReference,
        accountTerms: PRODUCT_READ_REFERENCES.accountTermsReference, requestCostBudget: PRODUCT_READ_REFERENCES.requestCostBudgetReference
      });
      assert.equal(parsed.sourceRevision, REVISION);
      assert.equal(parsed.ownerPacketSha256, PACKET_SHA);
      assert.deepEqual(parsed.request, {
        method: "GET", origin: "https://api.sandbox.prodigi.com", path: "/v4.0/products/GLOBAL-PHO-4X6", attempts: 1, dispatched: 1, refused: 0,
        retries: 0, redirect: "error", timeoutMs: 15_000, maxProviderRequests: 1
      });
      assert.equal(parsed.outcome.status, "ok");
      assert.equal(parsed.outcome.httpStatus, 200);
      assert.equal(parsed.outcome.errorCode, null);
      assert.ok(parsed.outcome.responseBytes > 100);
      assert.equal(parsed.decoded.sku, PRODUCT_READ_SKU);
      assert.deepEqual(parsed.decoded.finishAttributeValues, ["gloss", "lustre"]);
      assert.equal(parsed.decoded.shipsToIncludesUS, true);
      assert.deepEqual(parsed.decoded.defaultPrintAreaRecommendedPixelSizes, [{ horizontal: 1800, vertical: 1200 }]);
      assert.deepEqual(parsed.attestations, {
        decisionVerifier: "operator_attestation_only", keyPresence: "name_only_never_proof", accountAccess: "NOT_ASSERTED_ONLY_OBSERVED_BY_THIS_ONE_READ",
        accountTerms: "NOT_VERIFIED_BY_THIS_RECEIPT", builtArtifact: "LOADED_FROM_HASHED_BYTES_APPROVAL_IS_THE_TRUSTED_HOSTS_ONLY", requestCost: "UNKNOWN", authorityIssued: false, quoteAuthority: false, orderAuthority: false,
        bundleEligible: false, trimOrTierApproval: false, customerApproval: false
      });
      assert.equal(parsed.trustedHostGrant.verified, true);
      for (const forbidden of [FIXTURE_SANDBOX_KEY, "SYNTHETIC-DESCRIPTION", "traceParent", "X-API-Key", "bodyText"]) {
        assert.equal(written.includes(forbidden), false, forbidden);
        assert.equal(JSON.stringify(result.output).includes(forbidden), false, forbidden);
      }
      // The path is free no more: the same receipt can never be reused.
      const again = await execute(directory, { events: [] });
      assert.equal(again.result.exitCode, 2);
      assert.ok(again.result.output.missingGates.includes("receipt_path_outside_git"));
      assert.equal(again.fetcher.calls.length, 0);
      assert.deepEqual(withoutNodeOptions(again.envLog), []);
      assert.deepEqual(JSON.parse(fs.readFileSync(receipt, "utf8")), parsed);
    });
  });

  add("script.product-read-execute-failures-keep-accurate-counts-and-uncertainty", async () => {
    const big = new Uint8Array(65_536).fill(97);
    const failures = [
      ["invalid JSON", () => new Response("{not json", { status: 200 }), "invalid_response", "possible", 200],
      ["SKU mismatch", () => new Response(JSON.stringify(productDetailsResponse({ sku: "GLOBAL-PHO-6X8" })), { status: 200 }), "invalid_response", "possible", 200],
      ["unknown field", () => new Response(JSON.stringify(productDetailsResponse({ extra: 1 })), { status: 200 }), "invalid_response", "possible", 200],
      ["empty body", () => new Response("", { status: 200 }), "invalid_response", "possible", 200],
      ["oversize body", () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(big); } }), { status: 200 }), "invalid_response", "possible", 200],
      ["HTTP 401", () => new Response("key rejected", { status: 401 }), "authentication_failed", "possible", 401],
      ["HTTP 404", () => new Response("{}", { status: 404 }), "not_found", "possible", 404],
      ["HTTP 429", () => new Response("{}", { status: 429 }), "rate_limited", "possible", 429],
      ["HTTP 503", () => new Response("{}", { status: 503 }), "provider_unavailable", "possible", 503],
      ["redirect", () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }), "provider_unavailable", "possible", 302],
      ["network failure", () => { throw new TypeError(`fetch failed ${FIXTURE_SANDBOX_KEY}`); }, "provider_unavailable", "possible", null]
    ];
    for (const [name, respond, errorCode, sideEffectState, httpStatus] of failures) {
      await withTemp(async (directory) => {
        const { result, receipt, fetcher } = await execute(directory, { respond });
        assert.equal(result.exitCode, 1, name);
        assert.equal(result.output.status, "failed", name);
        assert.equal(fetcher.calls.length, 1, `${name}: never retried`);
        const written = JSON.parse(fs.readFileSync(receipt, "utf8"));
        assert.deepEqual(validateProductReadReceipt(written, { forbiddenText: [FIXTURE_SANDBOX_KEY] }), [], name);
        // The dispatch is counted by the transport, so an invalid 200 still shows one request.
        assert.equal(written.request.dispatched, 1, name);
        assert.equal(written.request.attempts, 1, name);
        assert.equal(written.outcome.status, "failed", name);
        assert.equal(written.outcome.errorCode, errorCode, name);
        assert.equal(written.outcome.sideEffectState, sideEffectState, name);
        assert.equal(written.outcome.httpStatus, httpStatus, name);
        assert.equal(written.decoded, null, name);
        assert.equal(result.output.externalProviderCalls, 1, name);
        assert.equal(JSON.stringify(written).includes(FIXTURE_SANDBOX_KEY), false, name);
        assert.equal(JSON.stringify(written).includes("key rejected"), false, name);
        if (name === "oversize body") assert.ok(written.outcome.responseBytes > 1_048_576);
      });
    }
  });

  add("script.product-read-host-denials-send-nothing-read-no-key-and-create-no-receipt", async () => {
    const denials = [
      ["returns nothing", () => undefined], ["unverified permission", (grant) => ({ ...grant, ownerPermissionVerified: false })],
      ["unaccepted terms", (grant) => ({ ...grant, accountTermsAccepted: false })], ["unapproved budget", (grant) => ({ ...grant, requestCostBudgetApproved: false })],
      ["not single use", (grant) => ({ ...grant, singleUse: false })], ["wrong receipt binding", (grant) => ({ ...grant, receiptBinding: `sha256:${"0".repeat(64)}` })],
      ["wrong SKU", (grant) => ({ ...grant, sku: "GLOBAL-PHO-6X8" })], ["throws", () => { throw new Error("host unavailable"); }]
    ];
    for (const [name, answer] of denials) {
      await withTemp(async (directory) => {
        const { result, receipt, fetcher, envLog } = await execute(directory, { host: trustedHost({ answer }) });
        assert.equal(result.exitCode, 2, name);
        assert.equal(result.output.execution, "NOT_EXECUTED", name);
        assert.deepEqual(result.output.missingGates.sort(), ["account_terms_reference", "built_artifact_approved_by_trusted_host", "owner_permission_reference", "request_cost_budget_reference"], name);
        assert.equal(fetcher.calls.length, 0, name);
        assert.deepEqual(withoutNodeOptions(envLog), [], name);
        assert.equal(fs.existsSync(receipt), false, name);
      });
    }
    await withTemp(async (directory) => {
      const receipt = path.join(directory, "receipt.json");
      const fetcher = fakeFetch(() => new Response("{}", { status: 200 }));
      const envLog = [];
      const host = trustedHost();
      const deps = { host, env: spyEnv(envLog), fetch: fetcher.impl, git: () => ({ head: REVISION, clean: true }), execArgv: [] };
      for (const [name, args, gate] of [
        ["no owner-approved flag", [...validArgs(receipt), "--execute"], "owner_approved_flag"],
        ["missing permission reference", [...validArgs(receipt, ["--owner-permission-reference"]), "--execute", "--owner-approved"], "owner_permission_reference"],
        ["missing terms reference", [...validArgs(receipt, ["--account-terms-reference"]), "--execute", "--owner-approved"], "account_terms_reference"],
        ["missing budget reference", [...validArgs(receipt, ["--request-cost-budget-reference"]), "--execute", "--owner-approved"], "request_cost_budget_reference"],
        ["missing packet hash", [...validArgs(receipt, ["--owner-packet-sha256"]), "--execute", "--owner-approved"], "owner_packet_sha256"]
      ]) {
        const result = await runProductRead(args, deps);
        assert.equal(result.exitCode, 2, name);
        assert.ok(result.output.missingGates.includes(gate), name);
      }
      const dirty = await runProductRead([...validArgs(receipt), "--execute", "--owner-approved"], { ...deps, git: () => ({ head: REVISION, clean: false }) });
      assert.ok(dirty.output.missingGates.includes("source_revision_immutable"));
      const moved = await runProductRead([...validArgs(receipt), "--execute", "--owner-approved"], { ...deps, git: () => ({ head: "f".repeat(40), clean: true }) });
      assert.ok(moved.output.missingGates.includes("source_revision_immutable"));
      const envFile = await runProductRead([...validArgs(receipt), "--execute", "--owner-approved"], { ...deps, execArgv: ["--env-file=.env"] });
      assert.ok(envFile.output.missingGates.includes("no_whole_env_file_loading"));
      assert.equal(fetcher.calls.length, 0);
      assert.deepEqual(withoutNodeOptions(envLog), []);
      assert.equal(fs.existsSync(receipt), false);
    });
  });

  add("script.product-read-preflight-with-a-trusted-host-verifies-but-never-executes-or-reads-the-environment", async () => {
    await withTemp(async (directory) => {
      const receipt = path.join(directory, "receipt.json");
      const hostCalls = [];
      const fetcher = fakeFetch(() => new Response("{}", { status: 200 }));
      const envLog = [];
      const result = await runProductRead(validArgs(receipt), { host: trustedHost({ calls: hostCalls }), env: spyEnv(envLog), fetch: fetcher.impl, git: () => ({ head: REVISION, clean: true }), execArgv: [] });
      assert.equal(result.exitCode, 0);
      assert.equal(result.output.status, "PREFLIGHT_GATES_SATISFIED_NOT_EXECUTED");
      assert.equal(result.output.execution, "NOT_EXECUTED");
      assert.equal(result.output.authorizesExecution, false);
      assert.deepEqual(result.output.missingGates, []);
      assert.equal(hostCalls.length, 1);
      assert.equal(fetcher.calls.length, 0);
      assert.deepEqual(envLog, [], "a preflight reads no environment variable at all");
      assert.equal(fs.existsSync(receipt), false, "a preflight creates no receipt");
      assert.deepEqual([result.output.externalProviderCalls, result.output.credentialReads, result.output.networkRequests], [0, 0, 0]);
      // Without a host the same references stay unverified and the preflight refuses.
      const hostless = await runProductRead(validArgs(receipt), { env: spyEnv(envLog), fetch: fetcher.impl, git: () => ({ head: REVISION, clean: true }), execArgv: [] });
      assert.equal(hostless.exitCode, 2);
      assert.ok(hostless.output.missingGates.includes("trusted_host_grant_verifier"));
      assert.deepEqual(envLog, []);
    });
  });

  add("script.product-read-receipt-races-and-reuse-fail-closed", async () => {
    // 1. A regular file appears at the path between the preflight and the exclusive open.
    await withTemp(async (directory) => {
      const target = path.join(directory, "receipt.json");
      const events = [];
      const { result, fetcher, envLog } = await execute(directory, {
        events,
        fsApi: tracedFs(events, { openSync: (file, flags, mode) => { fs.writeFileSync(file, "squatter"); return fs.openSync(file, flags, mode); } })
      });
      assert.equal(result.exitCode, 2);
      assert.equal(result.output.status, "REFUSED_RECEIPT_NOT_EXCLUSIVE");
      assert.equal(result.output.receiptError, "EEXIST");
      assert.equal(fs.readFileSync(target, "utf8"), "squatter", "the other file is left alone");
      assert.equal(fetcher.calls.length, 0);
      assert.deepEqual(withoutNodeOptions(envLog), [], "the key is not read when the receipt cannot be claimed");
    });
    // 2. A symlink to a decoy appears at the path: O_EXCL does not follow it, so the decoy is never written.
    await withTemp(async (directory) => {
      const decoy = path.join(directory, "decoy.txt");
      fs.writeFileSync(decoy, "decoy");
      const events = [];
      const { result, fetcher, envLog } = await execute(directory, {
        events,
        fsApi: tracedFs(events, { openSync: (file, flags, mode) => { fs.symlinkSync(decoy, file); return fs.openSync(file, flags, mode); } })
      });
      assert.equal(result.exitCode, 2);
      assert.equal(result.output.status, "REFUSED_RECEIPT_NOT_EXCLUSIVE");
      assert.equal(fs.readFileSync(decoy, "utf8"), "decoy");
      assert.equal(fetcher.calls.length, 0);
      assert.deepEqual(withoutNodeOptions(envLog), []);
    });
    // 3. The path is swapped for a symlink right after the file was opened: the run is refused before the key or the network.
    await withTemp(async (directory) => {
      const decoy = path.join(directory, "decoy.txt");
      fs.writeFileSync(decoy, "decoy");
      const events = [];
      const { result, fetcher, envLog } = await execute(directory, {
        events,
        fsApi: tracedFs(events, { openSync: (file, flags, mode) => {
          const descriptor = fs.openSync(file, flags, mode);
          fs.unlinkSync(file);
          fs.symlinkSync(decoy, file);
          return descriptor;
        } })
      });
      assert.equal(result.exitCode, 2);
      assert.equal(result.output.status, "REFUSED_RECEIPT_NOT_EXCLUSIVE");
      assert.equal(fs.readFileSync(decoy, "utf8"), "decoy");
      assert.equal(fetcher.calls.length, 0);
      assert.deepEqual(withoutNodeOptions(envLog), []);
    });
    // 4. A hard link to a file elsewhere: more than one name means the receipt is not exclusively ours.
    await withTemp(async (directory) => {
      const other = path.join(directory, "other.txt");
      fs.writeFileSync(other, "other");
      const events = [];
      const { result, fetcher } = await execute(directory, {
        events,
        fsApi: tracedFs(events, { openSync: (file, flags, mode) => {
          const descriptor = fs.openSync(file, flags, mode);
          fs.linkSync(file, path.join(directory, "second-name.json"));
          return descriptor;
        } })
      });
      assert.equal(result.exitCode, 2);
      assert.equal(result.output.status, "REFUSED_RECEIPT_NOT_EXCLUSIVE");
      assert.equal(fetcher.calls.length, 0);
    });
    // 5. A symlinked parent directory is refused at the preflight.
    await withTemp(async (directory) => {
      const real = path.join(directory, "real");
      fs.mkdirSync(real);
      fs.symlinkSync(real, path.join(directory, "link"));
      const fetcher = fakeFetch(() => new Response("{}", { status: 200 }));
      const result = await runProductRead(validArgs(path.join(directory, "link", "receipt.json")).concat(["--execute", "--owner-approved"]),
        { host: trustedHost(), env: spyEnv([]), fetch: fetcher.impl, git: () => ({ head: REVISION, clean: true }), execArgv: [] });
      assert.equal(result.exitCode, 2);
      assert.equal(result.output.gates.find((entry) => entry.id === "receipt_path_outside_git").note, "receipt_path_contains_symlink");
      assert.equal(fetcher.calls.length, 0);
    });
  });

  add("script.product-read-receipt-validator-rejects-unsafe-or-overstated-content", async () => {
    await withTemp(async (directory) => {
      const { result } = await execute(directory);
      const good = result.output.receipt;
      assert.deepEqual(validateProductReadReceipt(good), []);
      const copy = () => JSON.parse(JSON.stringify(good));
      const mutations = [
        ["extra top-level body", (r) => { r.rawBody = "{}"; }],
        ["extra header record", (r) => { r.headers = { "X-API-Key": "x" }; }],
        ["missing attestations", (r) => { delete r.attestations; }],
        ["authority issued", (r) => { r.attestations.authorityIssued = true; }],
        ["quote authority", (r) => { r.attestations.quoteAuthority = true; }],
        ["order authority", (r) => { r.attestations.orderAuthority = true; }],
        ["bundle eligible", (r) => { r.attestations.bundleEligible = true; }],
        ["trim approval", (r) => { r.attestations.trimOrTierApproval = true; }],
        ["customer approval", (r) => { r.attestations.customerApproval = true; }],
        ["cost assumed zero", (r) => { r.attestations.requestCost = "0"; }],
        ["cost as a number", (r) => { r.attestations.requestCost = 0; }],
        ["account terms verified", (r) => { r.attestations.accountTerms = "VERIFIED"; }],
        ["account access proven", (r) => { r.attestations.accountAccess = "PROVEN"; }],
        ["decision called verified", (r) => { r.attestations.decisionVerifier = "verified"; }],
        ["two requests dispatched", (r) => { r.request.dispatched = 2; }],
        ["retries recorded", (r) => { r.request.retries = 1; }],
        ["other path", (r) => { r.request.path = "/v4.0/products/OTHER"; }],
        ["other origin", (r) => { r.request.origin = "https://api.prodigi.com"; }],
        ["redirects followed", (r) => { r.request.redirect = "follow"; }],
        ["timeout over 30 seconds", (r) => { r.request.timeoutMs = 45_000; }],
        ["url text in a reference", (r) => { r.refs.decision = "https://evil.example/x"; }],
        ["url text in a finish", (r) => { r.decoded.finishAttributeValues = ["https://evil.example/signed?sig=1"]; }],
        ["sentence in an attribute name", (r) => { r.decoded.attributeNames = ["a long free-text provider description"]; }],
        ["other SKU decoded", (r) => { r.decoded.sku = "GLOBAL-PHO-6X8"; }],
        ["decoded on failure", (r) => { r.outcome.status = "failed"; r.outcome.errorCode = "timeout"; }],
        ["ok with an error code", (r) => { r.outcome.errorCode = "timeout"; }],
        ["unknown error code", (r) => { r.outcome.status = "failed"; r.outcome.errorCode = "boom"; r.decoded = null; }],
        ["status out of range", (r) => { r.outcome.httpStatus = 99; }],
        ["negative elapsed", (r) => { r.outcome.elapsedMs = -1; }],
        ["unbounded bytes", (r) => { r.outcome.responseBytes = 1.5; }],
        ["bad timestamp", (r) => { r.recordedAt = "yesterday"; }],
        ["bad revision", (r) => { r.sourceRevision = "main"; }],
        ["bad packet hash", (r) => { r.ownerPacketSha256 = "abc"; }],
        ["bad built artifact digest", (r) => { r.builtArtifactSha256 = "abc"; }],
        ["built artifact called reviewed", (r) => { r.attestations.builtArtifact = "REVIEWED"; }]
      ];
      for (const [name, mutate] of mutations) {
        const bad = copy();
        mutate(bad);
        assert.notDeepEqual(validateProductReadReceipt(bad), [], name);
      }
      assert.notDeepEqual(validateProductReadReceipt(good, { forbiddenText: [PRODUCT_READ_SKU] }), [], "forbidden text is detected anywhere in the receipt");
      const failed = copy();
      failed.outcome = { status: "failed", httpStatus: null, errorCode: "timeout", sideEffectState: "possible", elapsedMs: 1, responseBytes: null };
      failed.decoded = null;
      assert.deepEqual(validateProductReadReceipt(failed), []);
      assert.notDeepEqual(validateProductReadReceipt(null), []);
      assert.notDeepEqual(validateProductReadReceipt([]), []);
    });
  });
  // --- R45 fixes: late continuations, header shape, key variable, built artifact binding, strict preflight grant ---------------

  add("product-read.late-continuations-after-the-deadline-start-no-further-step", async () => {
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const late = { decision: [], grant: [], secret: [] };
      const grantCalls = [];
      const secrets = newSecrets();
      const real = secrets.source;
      const http = recordingHttp([{ body: productDetailsResponse() }]);
      // Each stage resolves only after the 40 ms deadline has failed the call and the call has returned.
      const decisionLate = { verify: (request) => new Promise((resolve) => late.decision.push(() => resolve({ ...request, productAndDestinationApproved: true, sandboxAccountAccessConfirmed: false }))) };
      const before = countTimers();
      await rejectsWith(productClient({ http, secrets: real, verifier: decisionLate, grant: fixtureGrantVerifier({ calls: grantCalls }), timeoutMs: 40 }).getProductDetails(PRODUCT_READ_REFERENCES), "timeout", "not_dispatched");
      assert.equal(countTimers(), before);
      late.decision.forEach((resume) => resume());
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(grantCalls.length, 0, "the trusted host must not be called after the deadline");
      assert.equal(secrets.counter.loads, 0, "the key must not be read after the deadline");
      assert.equal(http.calls.length, 0);

      const grantCalls2 = [];
      const secrets2 = newSecrets();
      const grantLate = { verify: (request) => { grantCalls2.push(request); return new Promise((resolve) => late.grant.push(() => resolve(fixtureGrantVerifier().verify(request)))); } };
      await rejectsWith(productClient({ http, secrets: secrets2.source, grant: grantLate, timeoutMs: 40 }).getProductDetails(PRODUCT_READ_REFERENCES), "timeout", "not_dispatched");
      assert.equal(grantCalls2.length, 1, "the grant check had already started");
      late.grant.forEach((resume) => resume());
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(secrets2.counter.loads, 0, "a grant that answers after the deadline must not lead to a key read");
      assert.equal(http.calls.length, 0);

      // A caller abort is a deadline too: the same steps stay unstarted.
      const abort = new AbortController();
      const secrets3 = newSecrets();
      const grantCalls3 = [];
      const decisionGate = { verify: (request) => new Promise((resolve) => late.secret.push(() => resolve({ ...request, productAndDestinationApproved: true, sandboxAccountAccessConfirmed: false }))) };
      const aborted = productClient({ http, secrets: secrets3.source, verifier: decisionGate, grant: fixtureGrantVerifier({ calls: grantCalls3 }) }).getProductDetails(PRODUCT_READ_REFERENCES, abort.signal);
      await new Promise((resolve) => setTimeout(resolve, 5));
      abort.abort();
      late.secret.forEach((resume) => resume());
      await rejectsWith(aborted, "aborted", "not_dispatched");
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual([grantCalls3.length, secrets3.counter.loads, http.calls.length], [0, 0, 0]);
      assert.deepEqual(unhandled, []);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  add("product-read.one-shot-port-allows-exactly-the-two-header-names", async () => {
    const base = { "X-API-Key": FIXTURE_SANDBOX_KEY, Accept: "application/json" };
    for (const [name, headers] of [
      ["extra header sorting first", { "A-Extra": "1", ...base }], ["extra header sorting last", { ...base, "Z-Extra": "1" }], ["extra header between", { ...base, "Accept-Language": "en" }],
      ["only the key", { "X-API-Key": FIXTURE_SANDBOX_KEY }], ["only Accept", { Accept: "application/json" }], ["no headers", {}],
      ["lower-case names", { "x-api-key": FIXTURE_SANDBOX_KEY, accept: "application/json" }], ["duplicated by case", { ...base, "x-api-key": "other" }]
    ]) {
      const calls = [];
      const transport = createOneShotProdigiProductReadPort({ async send(request) { calls.push(request); return { status: 200, bodyText: "{}" }; } });
      await assert.rejects(transport.port.send({ ...goodRequest(), headers }), /refused/u, name);
      assert.equal(calls.length, 0, name);
      assert.equal(transport.snapshot().dispatched, 0, name);
    }
    const accepted = [];
    const ok = createOneShotProdigiProductReadPort({ async send(request) { accepted.push(Object.keys(request.headers).sort()); return { status: 200, bodyText: "{}" }; } });
    await ok.port.send(goodRequest());
    assert.deepEqual(accepted, [["Accept", "X-API-Key"]]);
  });

  add("script.product-read-key-comes-only-from-the-one-named-variable", async () => {
    await withTemp(async (directory) => {
      const envLog = [];
      const others = { PRODIGI_API_KEY: FIXTURE_SANDBOX_KEY, PRODIGI_SANDBOX_KEY: FIXTURE_SANDBOX_KEY, SANDBOX_API_KEY: FIXTURE_SANDBOX_KEY, PRODIGI_LIVE_API_KEY: FIXTURE_SANDBOX_KEY, API_KEY: FIXTURE_SANDBOX_KEY };
      const { result, receipt, fetcher } = await execute(directory, { envLog, envValues: others });
      assert.equal(result.exitCode, 1);
      assert.equal(result.output.status, "failed");
      assert.equal(fetcher.calls.length, 0, "no request without the one named variable");
      assert.deepEqual(envLog, ["get:NODE_OPTIONS", "get:PRODIGI_SANDBOX_API_KEY"], "no other name is ever consulted");
      const written = JSON.parse(fs.readFileSync(receipt, "utf8"));
      assert.deepEqual(validateProductReadReceipt(written, { forbiddenText: [FIXTURE_SANDBOX_KEY] }), []);
      assert.equal(written.outcome.errorCode, "credential_unavailable");
      assert.equal(written.outcome.sideEffectState, "not_dispatched");
      assert.equal(written.request.dispatched, 0);
      assert.equal(written.outcome.httpStatus, null);
      assert.equal(result.output.externalProviderCalls, 0);
      assert.equal(result.output.credentialReads, 1);
    });
  });

  // A copy of the command line and dist/ that a case can tamper with without touching the real build.
  const copyBuild = (directory) => {
    const root = path.join(directory, "tree");
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), "{\"type\":\"module\"}\n");
    const script = path.join(root, "scripts", "prodigi-sandbox-product-read.mjs");
    fs.copyFileSync(scriptPath, script);
    fs.cpSync(path.join(repositoryRoot, "dist"), path.join(root, "dist"), { recursive: true });
    fs.mkdirSync(path.join(directory, "out"));
    return { root, script, dist: path.join(root, "dist"), out: path.join(directory, "out") };
  };
  let copyCounter = 0;
  const importCopy = async (script) => import(`${pathToFileURL(script).href}?copy=${copyCounter++}`);
  const alter = (file, from, to) => {
    const text = fs.readFileSync(file, "utf8");
    assert.ok(text.includes(from), `${file} must contain ${from}`);
    fs.writeFileSync(file, text.split(from).join(to));
  };
  // A careful host: it approves only the digest the owner reviewed and checks every other field it is handed.
  const approvingHost = (approvedDigest, { calls = [], during } = {}) => ({
    async verifyProductReadGrant(request) {
      calls.push(request);
      if (during !== undefined) await during(request);
      if (request.builtArtifactSha256 !== approvedDigest || request.sourceRevision !== REVISION || request.ownerPacketSha256 !== PACKET_SHA) return undefined;
      // The approved values come from the host's own context (here the closed-over reviewed digest), not from the request.
      return { ...request, ownerPermissionVerified: true, accountTermsAccepted: true, requestCostBudgetApproved: true, singleUse: true,
        approvedSourceRevision: REVISION, approvedBuiltArtifactSha256: approvedDigest, approvedOwnerPacketSha256: PACKET_SHA, expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
    }
  });
  const candidateDigest = async (tree) => {
    const module = await importCopy(tree.script);
    const out = await module.runProductRead(validArgs(path.join(tree.out, "probe.json")), { git: () => ({ head: REVISION, clean: true }), execArgv: [] });
    return out.output.builtArtifact.candidateSha256;
  };

  add("script.product-read-built-artifact-binds-execution-to-the-hashed-bytes", async () => {
    // The clean build, a careful host that approves exactly its digest, and the full success path.
    let approved;
    await withTemp(async (directory) => {
      const tree = copyBuild(directory);
      approved = await candidateDigest(tree);
      assert.match(approved, /^[a-f0-9]{64}$/u);
      const module = await importCopy(tree.script);
      const hostCalls = [];
      const { result, fetcher, envLog } = await execute(tree.out, { run: module.runProductRead, host: approvingHost(approved, { calls: hostCalls }) });
      assert.equal(result.exitCode, 0, JSON.stringify(result.output).slice(0, 400));
      assert.equal(fetcher.calls[0].url, PRODUCT_READ_URL);
      assert.ok(hostCalls.length >= 2);
      for (const call of hostCalls) {
        assert.equal(call.builtArtifactSha256, approved);
        assert.equal(call.sourceRevision, REVISION);
        assert.equal(call.ownerPacketSha256, PACKET_SHA);
      }
      assert.equal(result.output.receipt.builtArtifactSha256, approved);
      assert.equal(result.output.receipt.attestations.builtArtifact, "LOADED_FROM_HASHED_BYTES_APPROVAL_IS_THE_TRUSTED_HOSTS_ONLY");
      assert.deepEqual(envLog, ["get:NODE_OPTIONS", "get:PRODIGI_SANDBOX_API_KEY"]);
      // The digest does not depend on where the tree lives, only on the bytes.
      assert.equal(await candidateDigest(copyBuild(fs.mkdtempSync(path.join(directory, "second-")))), approved);
    });
    assert.match(approved, /^[a-f0-9]{64}$/u);
    // Every change to what would run changes the digest, so the careful host refuses and nothing is sent, read or created.
    const tampers = [
      ["fetch port retargeted to another SKU (reviewer R45-01 repro)", (t) => alter(path.join(t.dist, "prodigi-sandbox.js"), "fetchImpl(PRODIGI_SANDBOX_PRODUCT_READ_URL, {", "fetchImpl(\"https://api.sandbox.prodigi.com/v4.0/products/GLOBAL-CAN-10x10\", {")],
      ["path constant retargeted", (t) => alter(path.join(t.dist, "provider-matrix.js"), "/v4.0/products/GLOBAL-PHO-4X6", "/v4.0/products/GLOBAL-CAN-10x10")],
      ["one byte in another module", (t) => alter(path.join(t.dist, "prodigi-secrets.js"), "export const", "export  const")],
      ["extra module file", (t) => fs.writeFileSync(path.join(t.dist, "unrelated.js"), "export const injected = true;\n")],
      ["extra declaration file", (t) => fs.writeFileSync(path.join(t.dist, "unrelated.d.ts"), "export {};\n")],
      ["missing module file", (t) => fs.unlinkSync(path.join(t.dist, "status.js"))],
      ["entry module imports an injected module", (t) => { fs.writeFileSync(path.join(t.dist, "evil.js"), "export const x = 1;\n"); fs.appendFileSync(path.join(t.dist, "index.js"), "import \"./evil.js\";\n"); }],
      ["command-line controls modified", (t) => fs.appendFileSync(t.script, "\n// modified\n")],
      ["sub directory added", (t) => { fs.mkdirSync(path.join(t.dist, "nested")); fs.writeFileSync(path.join(t.dist, "nested", "x.js"), "export {};\n"); }]
    ];
    for (const [name, tamper] of tampers) {
      await withTemp(async (directory) => {
        const tree = copyBuild(directory);
        tamper(tree);
        const module = await importCopy(tree.script);
        const hostCalls = [];
        const { result, receipt, fetcher, envLog } = await execute(tree.out, { run: module.runProductRead, host: approvingHost(approved, { calls: hostCalls }) });
        assert.equal(result.exitCode, 2, name);
        assert.equal(result.output.execution, "NOT_EXECUTED", name);
        assert.ok(result.output.missingGates.includes("built_artifact_approved_by_trusted_host"), name);
        assert.notEqual(hostCalls[0]?.builtArtifactSha256, approved, `${name}: the host must have been shown the changed digest`);
        assert.equal(fetcher.calls.length, 0, name);
        assert.deepEqual(withoutNodeOptions(envLog), [], name);
        assert.equal(fs.existsSync(receipt), false, name);
        assert.deepEqual([result.output.externalProviderCalls, result.output.credentialReads, result.output.networkRequests], [0, 0, 0], name);
      });
    }
    // Changing dist/ AFTER it was hashed cannot change what runs: the library was imported from the hashed bytes.
    await withTemp(async (directory) => {
      const tree = copyBuild(directory);
      const module = await importCopy(tree.script);
      let retargeted = 0;
      const { result, fetcher } = await execute(tree.out, {
        run: module.runProductRead,
        host: approvingHost(approved, { during: () => { if (retargeted === 0) { retargeted += 1; alter(path.join(tree.dist, "prodigi-sandbox.js"), "fetchImpl(PRODIGI_SANDBOX_PRODUCT_READ_URL, {", "fetchImpl(\"https://api.sandbox.prodigi.com/v4.0/products/GLOBAL-CAN-10x10\", {"); } } })
      });
      assert.equal(retargeted, 1);
      assert.match(fs.readFileSync(path.join(tree.dist, "prodigi-sandbox.js"), "utf8"), /GLOBAL-CAN-10x10/u, "the file on disk really was retargeted, and would have fetched that SKU");
      assert.equal(result.exitCode, 0);
      assert.equal(fetcher.calls.length, 1);
      assert.equal(fetcher.calls[0].url, PRODUCT_READ_URL, "the request still goes to the hashed code's URL");
      assert.equal(result.output.receipt.request.path, "/v4.0/products/GLOBAL-PHO-4X6");
    });
    // The preflight shows the candidate digest with approval pending, and a host-less run never reaches approval.
    await withTemp(async (directory) => {
      const tree = copyBuild(directory);
      const module = await importCopy(tree.script);
      const out = await module.runProductRead(validArgs(path.join(tree.out, "r.json")), { git: () => ({ head: REVISION, clean: true }), execArgv: [] });
      assert.equal(out.output.builtArtifact.state, "approval_pending");
      assert.equal(out.output.builtArtifact.candidateSha256, approved);
      assert.equal(out.output.gates.find((g) => g.id === "built_artifact_approved_by_trusted_host").state, "unverified");
      assert.equal(out.exitCode, 2);
      assert.equal(out.output.authorizesExecution, false);
    });
  });

  add("script.product-read-approval-precedes-any-candidate-module-evaluation", async () => {
    await withTemp(async (directory) => {
      const tree = copyBuild(directory);
      const marker = "fc_r45_unapproved_candidate_evaluation";
      delete globalThis[marker];
      fs.appendFileSync(path.join(tree.dist, "index.js"), `\nglobalThis[${JSON.stringify(marker)}] = (globalThis[${JSON.stringify(marker)}] ?? 0) + 1;\n`);
      const module = await importCopy(tree.script);
      const approved = module.inspectBuiltArtifact().sha256;
      const receipt = path.join(tree.out, "receipt.json");
      const base = { git: () => ({ head: REVISION, clean: true }), execArgv: [] };
      try {
        // Both hostless and fully approved PREFLIGHT must remain data-only.
        await module.runProductRead(validArgs(receipt), base);
        assert.equal(globalThis[marker], undefined, "hostless preflight must not evaluate candidate code");
        await module.runProductRead(validArgs(receipt), { ...base, host: approvingHost(approved) });
        assert.equal(globalThis[marker], undefined, "approved preflight still must not evaluate code");
        // A denied candidate must not evaluate even though it is valid JavaScript and has a real top-level effect.
        const denied = await execute(tree.out, { run: module.runProductRead, host: approvingHost("e".repeat(64)) });
        assert.equal(denied.result.exitCode, 2);
        assert.equal(globalThis[marker], undefined, "digest refusal must precede module evaluation");
        assert.equal(denied.fetcher.calls.length, 0);
        assert.deepEqual(withoutNodeOptions(denied.envLog), []);
        assert.equal(fs.existsSync(receipt), false);
        // Positive control: the exact same top-level effect is reachable after approval.
        const allowed = await execute(tree.out, { run: module.runProductRead, host: approvingHost(approved) });
        assert.equal(allowed.result.exitCode, 0);
        assert.equal(globalThis[marker], 1);
        assert.equal(allowed.fetcher.calls.length, 1, "injected fake fetch only");
      } finally { delete globalThis[marker]; }
    });
  });

  add("script.product-read-untrusted-preload-and-unloadable-artifacts-hard-fail", async () => {
    const gateState = (output, id) => output.gates.find((g) => g.id === id)?.state;
    // Code-loading flags in argv, at preflight and execute, and in NODE_OPTIONS at execute.
    for (const execArgv of [["--import", "/tmp/preload.mjs"], ["--import=/tmp/preload.mjs"], ["--require=/tmp/preload.cjs"], ["-r", "/tmp/preload.cjs"], ["--loader=/tmp/loader.mjs"],
      ["--experimental-loader", "x"], ["--eval", "1"], ["-e", "1"], ["--print", "1"], ["--inspect"], ["--inspect-brk=9229"]]) {
      await withTemp(async (directory) => {
        const hostCalls = [];
        const { result, receipt, fetcher, envLog } = await execute(directory, { host: trustedHost({ calls: hostCalls }), execArgv });
        assert.equal(result.exitCode, 2, execArgv.join(" "));
        assert.equal(gateState(result.output, "no_untrusted_preload"), "invalid");
        assert.deepEqual([hostCalls.length, fetcher.calls.length, fs.existsSync(receipt)], [0, 0, false], execArgv.join(" "));
        assert.deepEqual(withoutNodeOptions(envLog), []);
      });
    }
    for (const nodeOptions of ["--require /tmp/preload.js", "--max-old-space-size=64 --import=/tmp/p.mjs", "-r /tmp/p.js", "--loader x", "--inspect-wait"]) {
      await withTemp(async (directory) => {
        const hostCalls = [];
        const { result, fetcher, envLog } = await execute(directory, { host: trustedHost({ calls: hostCalls }), envValues: { NODE_OPTIONS: nodeOptions, PRODIGI_SANDBOX_API_KEY: FIXTURE_SANDBOX_KEY } });
        assert.equal(result.exitCode, 2, nodeOptions);
        assert.equal(gateState(result.output, "no_untrusted_preload"), "invalid");
        assert.deepEqual([hostCalls.length, fetcher.calls.length], [0, 0], nodeOptions);
        assert.deepEqual(envLog, ["get:NODE_OPTIONS"], "the key is not read when NODE_OPTIONS preloads code");
      });
    }
    await withTemp(async (directory) => {
      const { result, fetcher } = await execute(directory, { envValues: { NODE_OPTIONS: "--max-old-space-size=64", PRODIGI_SANDBOX_API_KEY: FIXTURE_SANDBOX_KEY } });
      assert.equal(result.exitCode, 0, "a benign NODE_OPTIONS is not a preload");
      assert.equal(fetcher.calls.length, 1);
    });
    // Unsafe or unloadable build output: refused before the host is asked, with zero requests and no key read.
    const unsafe = [
      ["symlink inside dist", (t) => fs.symlinkSync(path.join(t.root, "package.json"), path.join(t.dist, "link.js")), "built_artifact_symlink"],
      ["hard link into dist", (t) => fs.linkSync(path.join(t.dist, "status.js"), path.join(t.root, "second-name.js")), "built_artifact_unsafe_file"],
      ["dist itself a symlink", (t) => { fs.renameSync(t.dist, path.join(t.root, "real-dist")); fs.symlinkSync(path.join(t.root, "real-dist"), t.dist); }, "built_artifact_root_not_directory"],
      ["entry module missing", (t) => fs.unlinkSync(path.join(t.dist, "index.js")), "built_artifact_entry_missing"],
      ["dist missing", (t) => fs.rmSync(t.dist, { recursive: true }), "built_artifact_missing"],
      ["hidden file name", (t) => fs.writeFileSync(path.join(t.dist, ".hidden.js"), "export {};\n"), "built_artifact_unsafe_name"],
      ["prototype-looking name", (t) => fs.writeFileSync(path.join(t.dist, "__proto__.js"), "export {};\n"), "built_artifact_unsafe_name"],
      ["name with a space", (t) => fs.writeFileSync(path.join(t.dist, "a b.js"), "export {};\n"), "built_artifact_unsafe_name"],
      ["too deep", (t) => { let d = t.dist; for (const n of ["a", "b", "c", "d", "e"]) { d = path.join(d, n); fs.mkdirSync(d); } fs.writeFileSync(path.join(d, "x.js"), "export {};\n"); }, "built_artifact_too_deep"],
      ["too many files", (t) => { for (let i = 0; i < 260; i += 1) fs.writeFileSync(path.join(t.dist, `extra${i}.js`), "export {};\n"); }, "built_artifact_too_large"],
      ["oversize total", (t) => fs.writeFileSync(path.join(t.dist, "big.js"), Buffer.alloc(17 * 1024 * 1024, 32)), "built_artifact_too_large"],
      ["entry imports a bare package", (t) => fs.appendFileSync(path.join(t.dist, "index.js"), "import \"left-pad\";\n"), "could not be loaded"],
      ["entry imports a bare package that really exists", (t) => {
        fs.mkdirSync(path.join(t.root, "node_modules", "fakepkg"), { recursive: true });
        fs.writeFileSync(path.join(t.root, "node_modules", "fakepkg", "package.json"), "{\"name\":\"fakepkg\",\"type\":\"module\",\"main\":\"index.js\"}\n");
        fs.writeFileSync(path.join(t.root, "node_modules", "fakepkg", "index.js"), "export const injected = true;\n");
        fs.appendFileSync(path.join(t.dist, "index.js"), "import \"fakepkg\";\n");
      }, "could not be loaded"],
      ["entry imports a file URL", (t) => fs.appendFileSync(path.join(t.dist, "index.js"), `import "${pathToFileURL(path.join(t.root, "package.json")).href}";\n`), "could not be loaded"],
      ["entry imports a module outside the inventory", (t) => fs.appendFileSync(path.join(t.dist, "index.js"), "import \"./not-in-inventory.js\";\n"), "could not be loaded"]
    ];
    for (const [name, tamper, expected] of unsafe) {
      await withTemp(async (directory) => {
        const tree = copyBuild(directory);
        tamper(tree);
        const module = await importCopy(tree.script);
        const hostCalls = [];
        const { result, receipt, fetcher, envLog } = await execute(tree.out, { run: module.runProductRead, host: trustedHost({ calls: hostCalls }) });
        assert.equal(result.exitCode, 2, name);
        const inventory = result.output.gates.find((g) => g.id === "built_artifact_inventory");
        assert.notEqual(inventory.state, "satisfied", name);
        assert.ok(inventory.note.includes(expected), `${name}: ${inventory.note}`);
        // Structural inventory failures precede approval. Module resolution is intentionally
        // attempted only AFTER approval, so a valid inventory with a bad import reaches the host.
        assert.deepEqual([hostCalls.length > 0, fetcher.calls.length, fs.existsSync(receipt)], [expected === "could not be loaded", 0, false], name);
        assert.deepEqual(withoutNodeOptions(envLog), [], name);
        assert.equal(result.output.builtArtifact.candidateSha256 === null || result.output.builtArtifact.state === "approval_pending", true, name);
      });
    }
  });

  add("script.product-read-preflight-applies-the-clients-strict-grant-check", async () => {
    const cases = [
      ["expired grant", (grant) => ({ ...grant, expiresAt: new Date(Date.now() - 1000).toISOString() })],
      ["non-ISO expiry", (grant) => ({ ...grant, expiresAt: "tomorrow" })],
      ["extra key", (grant) => ({ ...grant, extra: true })],
      ["missing flag", (grant) => { const { singleUse, ...rest } = grant; void singleUse; return rest; }],
      ["flag not exactly true", (grant) => ({ ...grant, accountTermsAccepted: "yes" })],
      ["wrong built artifact digest echoed", (grant) => ({ ...grant, builtArtifactSha256: "e".repeat(64) })],
      ["host that only echoes the request (no approved values)", (grant) => { const { approvedSourceRevision, approvedBuiltArtifactSha256, approvedOwnerPacketSha256, ...rest } = grant; void [approvedSourceRevision, approvedBuiltArtifactSha256, approvedOwnerPacketSha256]; return rest; }],
      ["approved digest differs from the candidate", (grant) => ({ ...grant, approvedBuiltArtifactSha256: "e".repeat(64) })],
      ["wrong source revision echoed", (grant) => ({ ...grant, sourceRevision: "f".repeat(40) })],
      ["wrong owner packet echoed", (grant) => ({ ...grant, ownerPacketSha256: "b".repeat(64) })],
      ["accessor field", (grant) => Object.defineProperty({ ...grant }, "singleUse", { enumerable: true, get: () => true })],
      ["array", () => []]
    ];
    for (const [name, answer] of cases) {
      await withTemp(async (directory) => {
        const receipt = path.join(directory, "receipt.json");
        const fetcher = fakeFetch(() => new Response("{}", { status: 200 }));
        const deps = { host: trustedHost({ answer }), env: spyEnv([]), fetch: fetcher.impl, git: () => ({ head: REVISION, clean: true }), execArgv: [] };
        const preflight = await runProductRead(validArgs(receipt), deps);
        assert.equal(preflight.exitCode, 2, name);
        assert.equal(preflight.output.gates.find((g) => g.id === "owner_permission_reference").state, "invalid", name);
        assert.equal(preflight.output.gates.find((g) => g.id === "built_artifact_approved_by_trusted_host").state, "invalid", name);
        const executed = await runProductRead([...validArgs(receipt), "--execute", "--owner-approved"], deps);
        assert.equal(executed.exitCode, 2, name);
        assert.equal(executed.output.execution, "NOT_EXECUTED", name);
        assert.equal(fs.existsSync(receipt), false, `${name}: an unverifiable grant must fail before a receipt exists`);
        assert.equal(fetcher.calls.length, 0, name);
      });
    }
  });
}
