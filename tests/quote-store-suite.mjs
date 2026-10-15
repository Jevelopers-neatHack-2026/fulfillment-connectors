import assert from "node:assert/strict";
import { mkdtempSync, chmodSync, rmSync, symlinkSync, statSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createLocalQuoteStore, QuoteStoreError } from "../dist/quote-store.js";
import { executePrivateQuote, evaluatePrivateQuoteCurrent } from "../dist/quotes.js";
import { quoteHarness, quoteScope, requestFor } from "./quote-fixtures.mjs";

function directory(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "fc-quotes-"));
  chmodSync(root, 0o700); t.after(() => rmSync(root, { recursive: true, force: true })); return root;
}
function storeAt(t, root) { const store = createLocalQuoteStore(root); t.after(() => store.close()); return store; }
async function quote() { const h = quoteHarness(); return (await executePrivateQuote(await requestFor(), h.dependencies)).quote; }

test("quote execution persists exact immutable terms and reopens after close", async (t) => {
  const root = directory(t), store = storeAt(t, root), h = quoteHarness();
  const input = await requestFor();
  const response = await executePrivateQuote(input, { ...h.dependencies, quoteStore: store });
  store.close();
  const reopened = storeAt(t, root);
  const stored = await reopened.get(response.quote.quoteId, quoteScope);
  assert.deepEqual(JSON.parse(JSON.stringify(stored)), JSON.parse(JSON.stringify(response.quote)));
  assert.equal(stored.financialEffect, "quote_only");
  assert.equal(stored.breakdown.total.value.decimal, "17.30");
  assert.equal(statSync(join(root, "quotes.sqlite")).mode & 0o777, 0o600);
  assert.throws(() => { stored.binding.quantity = 999; }, TypeError);
  assert.equal(h.calls.quote, 1); assert.equal(h.calls.order, 0);
  assert.equal((await evaluatePrivateQuoteCurrent(stored, input, h.dependencies)).status, "current");
  h.setNow("2026-10-10T10:35:00.000Z");
  assert.equal((await evaluatePrivateQuoteCurrent(stored, input, h.dependencies)).status, "stale");
});

test("tenant and project partition reads and reject foreign saves", async (t) => {
  const store = storeAt(t, directory(t)), value = await quote();
  await store.save(value, quoteScope);
  for (const scope of [{ ...quoteScope, tenantId: "tenant:other" }, { ...quoteScope, projectId: "project:other" }]) {
    assert.equal(await store.get(value.quoteId, scope), undefined);
    await assert.rejects(store.save(value, scope), QuoteStoreError);
  }
  await assert.rejects(store.get("../../private-canary", quoteScope), QuoteStoreError);
});

test("a fresh process persists a quote and another process instance reopens it", async (t) => {
  const root = directory(t), value = await quote();
  const moduleUrl = new URL("../dist/quote-store.js", import.meta.url).href;
  const guardUrl = new URL("./prodigi-sandbox-network-guard.mjs", import.meta.url).href;
  const script = `import {readFileSync} from 'node:fs';
    const {createLocalQuoteStore}=await import(${JSON.stringify(moduleUrl)});
    const quote=JSON.parse(readFileSync(0,'utf8'));
    const store=createLocalQuoteStore(process.argv[1]);
    await store.save(quote,{tenantId:quote.binding.tenantId,projectId:quote.binding.projectId});
    store.close();`;
  execFileSync(process.execPath, ["--import", guardUrl, "--input-type=module", "-e", script, root], {
    input: JSON.stringify(value), encoding: "utf8", env: { PATH: process.env.PATH }
  });
  const reopened = storeAt(t, root);
  assert.equal(JSON.stringify(await reopened.get(value.quoteId, quoteScope)), JSON.stringify(value));
});

test("duplicate writes from separate connections preserve one snapshot", async (t) => {
  const root = directory(t), a = storeAt(t, root), b = storeAt(t, root), value = await quote();
  await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).save(value, quoteScope)));
  const db = new DatabaseSync(join(root, "quotes.sqlite"));
  assert.equal(db.prepare("SELECT count(*) AS n FROM quotes").get().n, 1); db.close();
  assert.deepEqual(JSON.parse(JSON.stringify(await a.get(value.quoteId, quoteScope))), JSON.parse(JSON.stringify(value)));
});

test("changed terms, malformed data and tampered rows cannot overwrite history", async (t) => {
  const root = directory(t), store = storeAt(t, root), value = await quote();
  await store.save(value, quoteScope);
  const changed = structuredClone(value); changed.binding.quantity++;
  await assert.rejects(store.save(changed, quoteScope), QuoteStoreError);
  assert.deepEqual(JSON.parse(JSON.stringify(await store.get(value.quoteId, quoteScope))), JSON.parse(JSON.stringify(value)));
  const db = new DatabaseSync(join(root, "quotes.sqlite"));
  db.prepare("UPDATE quotes SET payload=?").run(JSON.stringify(changed));
  await assert.rejects(store.get(value.quoteId, quoteScope), QuoteStoreError);
  await assert.rejects(store.save(value, quoteScope), QuoteStoreError);
  assert.equal(db.prepare("SELECT payload FROM quotes").get().payload, JSON.stringify(changed));
  db.prepare("UPDATE quotes SET payload=?").run("private-canary");
  await assert.rejects(store.get(value.quoteId, quoteScope), (error) => error instanceof QuoteStoreError && !String(error).includes("private-canary"));
  db.close();
});

test("closed/outage persistence never returns a successful quote or creates an order", async (t) => {
  const store = storeAt(t, directory(t)); store.close();
  for (const quoteStore of [store, { async save() { throw new Error("private-canary"); } }, { save: "not-a-method" }]) {
    const h = quoteHarness();
    await assert.rejects(executePrivateQuote(await requestFor(), { ...h.dependencies, quoteStore }), (error) => error.code === "persistence_unavailable" && !JSON.stringify(error).includes("private-canary"));
    assert.equal(h.calls.order, 0);
    if (typeof quoteStore.save !== "function") assert.equal(h.calls.quote, 0);
  }
});

test("invalid contract receipt never reaches persistence", async () => {
  const h = quoteHarness({ contracts: { binding() { return { state: "missing" }; } } });
  let saves = 0;
  await assert.rejects(executePrivateQuote(await requestFor(), { ...h.dependencies, quoteStore: { async save() { saves++; } } }));
  assert.equal(saves, 0); assert.equal(h.calls.quote, 0); assert.equal(h.calls.order, 0);
});

test("unsafe storage directories, symlinks and future schema versions fail closed", (t) => {
  const root = directory(t);
  chmodSync(root, 0o755); assert.throws(() => createLocalQuoteStore(root), QuoteStoreError); chmodSync(root, 0o700);
  const elsewhere = directory(t);
  symlinkSync(elsewhere, join(root, "quotes.sqlite"));
  assert.throws(() => createLocalQuoteStore(root), QuoteStoreError);
  rmSync(join(root, "quotes.sqlite"));
  const store = createLocalQuoteStore(root); store.close();
  const db = new DatabaseSync(join(root, "quotes.sqlite")); db.exec("PRAGMA user_version=2"); db.close();
  assert.throws(() => createLocalQuoteStore(root), QuoteStoreError);
});

test("quote store suite made zero network attempts", () => {
  const guard = globalThis[Symbol.for("fulfillment-connectors.prodigi-sandbox.network-guard")];
  assert.equal(guard?.installed, true); assert.equal(guard.attempts, 0);
});
