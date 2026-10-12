// Cases for the owner-gated Prodigi sandbox product read (GET /v4.0/products/GLOBAL-PHO-4X6).
// Registered into tests/prodigi-sandbox-suite.mjs, so they run under the network guard with a
// fake credential only. Every request goes to an injected fake port or fake fetch; nothing here
// can reach Prodigi, and the key below is a fixture value.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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
    assert.deepEqual(observation.defaultPrintAreaResolutions, [{ horizontal: 1800, vertical: 1200 }]);
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
    assert.deepEqual(report.missingGates.sort(), [
      "account_terms_reference", "decision_reference", "owner_packet_sha256", "owner_permission_reference", "receipt_path_outside_git",
      "request_cost_budget_reference", "source_revision_immutable", "trusted_host_grant_verifier"
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
      assert.deepEqual(report.missingGates.sort(), ["owner_permission_reference", "account_terms_reference", "request_cost_budget_reference", "source_revision_immutable", "trusted_host_grant_verifier"].sort());
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
        expiresAt: new Date(Date.now() + 3_600_000).toISOString()
      };
      return answer === undefined ? grant : answer(grant);
    }
  });

  const spyEnv = (log) => new Proxy({ PRODIGI_SANDBOX_API_KEY: FIXTURE_SANDBOX_KEY, UNRELATED_FIXTURE_VARIABLE: "unrelated" }, {
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
    openSync: (...args) => {
      events.push("receipt.open");
      return (overrides.openSync ?? fs.openSync)(...args);
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([name]) => name !== "openSync"))
  });

  async function execute(directory, { respond, host = trustedHost(), extraArgs = [], fsApi, events = [], envLog = [], name = "receipt.json" } = {}) {
    const receipt = path.join(directory, name);
    const fetcher = fakeFetch(respond ?? (() => new Response(JSON.stringify(productDetailsResponse()), { status: 200 })), events);
    const result = await runProductRead([...validArgs(receipt), "--execute", "--owner-approved", ...extraArgs], {
      host, env: spyEnv(envLog), fetch: fetcher.impl, fs: fsApi ?? tracedFs(events), git: () => ({ head: REVISION, clean: true }), execArgv: []
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
      assert.deepEqual(envLog, ["get:PRODIGI_SANDBOX_API_KEY"]);
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
      assert.deepEqual(parsed.decoded.defaultPrintAreaResolutions, [{ horizontal: 1800, vertical: 1200 }]);
      assert.deepEqual(parsed.attestations, {
        decisionVerifier: "operator_attestation_only", keyPresence: "name_only_never_proof", accountAccess: "NOT_ASSERTED_ONLY_OBSERVED_BY_THIS_ONE_READ",
        accountTerms: "NOT_VERIFIED_BY_THIS_RECEIPT", requestCost: "UNKNOWN", authorityIssued: false, quoteAuthority: false, orderAuthority: false,
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
      assert.deepEqual(again.envLog, []);
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
        assert.deepEqual(result.output.missingGates.sort(), ["account_terms_reference", "owner_permission_reference", "request_cost_budget_reference"], name);
        assert.equal(fetcher.calls.length, 0, name);
        assert.deepEqual(envLog, [], name);
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
      assert.deepEqual(envLog, []);
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
      assert.deepEqual(envLog, [], "the key is not read when the receipt cannot be claimed");
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
      assert.deepEqual(envLog, []);
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
      assert.deepEqual(envLog, []);
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
        ["bad packet hash", (r) => { r.ownerPacketSha256 = "abc"; }]
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
}
