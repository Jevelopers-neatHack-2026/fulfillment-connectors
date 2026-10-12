// SIMULATED ONLY. Cases: png, pdfsvg, geometry (unit = pure observation; e2e = owner-built re-commitment), fixtures.
//
// How the failing bytes reach the local check (PBR-20):
//  - class "unit": the pure observation function is fed mutated real bytes plus descriptors copied from the real manifest (with the
//    mutated bytes' hash/size). These test the function, not the pipeline.
//  - class "e2e": a FULLY RE-COMMITTED synthetic bundle is built from owner-exported helpers plus a test-only stored-ZIP writer,
//    published through the fixture publication port, and the OWNER verifier is asserted to PASS it before the consumer is asserted
//    to FAIL it. Owner failures are never counted as geometry coverage.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { crc32 } from "node:zlib";
import { inspectPngBytes } from "../dist/index.js";
import * as bundle from "../dist/production-bundle.js";
import * as f from "./production-bundle-fixtures.mjs";
import { baselineWorld, criterion, runGate } from "./production-bundle-cases-core.mjs";

const enc = (text) => new TextEncoder().encode(text);
const tagged = f.sha256Tagged;

// ---- PNG chunk helpers (test-only) --------------------------------------------------------------------------
function chunks(png) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength); const out = []; let offset = 8;
  while (offset < png.length) { const length = view.getUint32(offset); out.push({ type: new TextDecoder().decode(png.subarray(offset + 4, offset + 8)), offset, length }); offset += 12 + length; }
  return out;
}
function withPhys(png, ppm, unit = 1) {
  const out = f.clone(png); const chunk = chunks(out).find((entry) => entry.type === "pHYs");
  const view = new DataView(out.buffer);
  view.setUint32(chunk.offset + 8, ppm); view.setUint32(chunk.offset + 12, ppm); out[chunk.offset + 16] = unit;
  view.setUint32(chunk.offset + 17, crc32(out.subarray(chunk.offset + 4, chunk.offset + 17)));
  return out;
}
function withoutChunk(png, type) {
  const chunk = chunks(png).find((entry) => entry.type === type);
  return new Uint8Array([...png.subarray(0, chunk.offset), ...png.subarray(chunk.offset + 12 + chunk.length)]);
}

// ---- unit harness ----------------------------------------------------------------------------------------------
function observe({ png, pdf, svg, edit } = {}) {
  const declared = structuredClone(f.baselineManifest.files);
  const bytes = f.baseline().files;
  for (const [name, replacement] of [["output.png", png], ["output.pdf", pdf], ["output.svg", svg]]) {
    if (replacement === undefined) continue;
    bytes.set(name, replacement);
    const descriptor = declared.find((entry) => entry.filename === name);
    descriptor.byte_hash = tagged(replacement); descriptor.byte_size = replacement.length;
  }
  if (edit !== undefined) edit(declared);
  return bundle.observePrintOutputs(declared, bytes);
}
const pngDescriptor = (declared) => declared.find((entry) => entry.filename === "output.png");

async function recommittedReport(mutation) {
  const recommitted = f.recommit(mutation);
  assert.deepEqual(f.ownerVerifyDirect(recommitted.files, recommitted.commitment), { ok: true, integrity: "passed", eligibility: "blocked" }, "the OWNER verifier passes the re-committed bundle first");
  const world = f.createWorld();
  f.publishFromBaseline(world, recommitted.files, recommitted.commitmentBytes, recommitted.bundleHash);
  assert.equal(world.bundles.get(recommitted.bundleHash).pin.sha256, recommitted.pin.sha256, "independent fixture-publication pin over the committed commitment bytes");
  const report = await runGate(world, { bundleDigest: recommitted.bundleHash });
  assert.equal(report.verdict, "integrity_failed");
  assert.equal(criterion(report, "anchor_resolution").state, "verified_local");
  assert.equal(criterion(report, "byte_custody").state, "verified_local");
  assert.equal(criterion(report, "owner_integrity").state, "verified_owner", "owner integrity passed: this is local-check coverage");
  assert.deepEqual(report.owner.codes, []);
  const geometry = criterion(report, "observed_geometry_consistency");
  assert.equal(geometry.state, "failed"); assert.equal(geometry.critical, true, "a known-invalid critical condition is never downgraded");
  assert.ok(report.openCriticalCodes.includes(geometry.code));
  assert.equal(report.unchanged, true);
  return { report, recommitted, geometry };
}

export function register(define) {
  // ---- png --------------------------------------------------------------------------------------------------
  define("png.observed-pixels-match-manifest", async () => {
    const png = f.baseline().files.get("output.png");
    const inspected = inspectPngBytes(png, "image/png", png.length, tagged(png));
    assert.equal(inspected.status, "inspected");
    const declared = f.baselineManifest.files.find((entry) => entry.filename === "output.png").geometry;
    assert.equal(inspected.metadata.width, declared.width_px); assert.equal(inspected.metadata.height, declared.height_px);
    assert.deepEqual([inspected.metadata.width, inspected.metadata.height], [1200, 600]);
    const observation = observe();
    assert.equal(observation.pixels, "verified_local"); assert.deepEqual(observation.failures, []);
    const report = await runGate(baselineWorld());
    assert.equal(criterion(report, "png_pixels").state, "verified_local");
  });

  define("png.effective-dpi-derived-integer-exact", async () => {
    const declared = f.baselineManifest.files.find((entry) => entry.filename === "output.png").geometry;
    const dpi = (px, nm) => (BigInt(px) * 25_400_000n) / BigInt(nm);
    assert.equal(dpi(declared.width_px, declared.width_nm), 300n); assert.equal(dpi(declared.height_px, declared.height_nm), 300n);
    assert.equal((BigInt(declared.width_px) * 25_400_000n) % BigInt(declared.width_nm), 0n, "exact, not rounded");
    assert.equal(observe().dpi, "verified_local");
    assert.equal((await runGate(baselineWorld())).criteria.find((entry) => entry.id === "png_effective_dpi").state, "verified_local");
    for (const wrong of [299, 301, 72]) {
      const observation = observe({ edit: (files) => { pngDescriptor(files).geometry.effective_dpi = wrong; } });
      assert.equal(observation.dpi, "failed", String(wrong)); assert.ok(observation.failures.includes("DPI_DERIVATION_MISMATCH"));
    }
    assert.equal(observe({ edit: (files) => { pngDescriptor(files).geometry.width_nm = "101600001"; } }).dpi, "failed");
    const absent = observe({ edit: (files) => { pngDescriptor(files).geometry.effective_dpi = null; } });
    assert.equal(absent.dpi, "not_observed"); assert.equal(absent.phys, "not_observed");
  });

  define("png.phys-metadata-consistent", async () => {
    const png = f.baseline().files.get("output.png");
    const inspected = inspectPngBytes(png);
    assert.equal(inspected.metadata.physicalResolution.pixelsPerUnitX, 11811);
    assert.equal(inspected.metadata.physicalResolution.unit, "metre");
    assert.notEqual(inspected.metadata.physicalResolution.dpiX, 300, "the decoder's 299.9994 is metadata, not what is compared");
    assert.equal(observe().phys, "verified_local");
    // The integer encoding identity round(dpi / 0.0254): only 300 maps to 11811; 299 and 301 map elsewhere (not a tolerance).
    for (const [dpi, ppm] of [[299, 11772], [300, 11811], [301, 11850]]) {
      const observation = observe({ png: withPhys(png, ppm), edit: (files) => { pngDescriptor(files).geometry.effective_dpi = dpi; } });
      assert.equal(observation.phys, "verified_local", `${dpi} dpi <-> ${ppm} ppm`);
    }
    assert.equal(observe({ png: withPhys(png, 11810) }).phys, "failed");
    assert.equal(observe({ png: withPhys(png, 11812) }).phys, "failed");
    assert.equal((await runGate(baselineWorld())).criteria.find((entry) => entry.id === "png_phys_metadata").state, "verified_local");
  });

  define("png.phys-absent-or-unit0-not-observed", () => {
    const png = f.baseline().files.get("output.png");
    const absent = observe({ png: withoutChunk(png, "pHYs") });
    assert.equal(absent.phys, "not_observed"); assert.equal(absent.pixels, "verified_local"); assert.deepEqual(absent.failures, []);
    const unitZero = observe({ png: withPhys(png, 11811, 0) });
    assert.equal(unitZero.phys, "not_observed"); assert.equal(unitZero.pixels, "verified_local"); assert.deepEqual(unitZero.failures, []);
    assert.equal(inspectPngBytes(withPhys(png, 11811, 0)).status, "inspected", "the decoder itself accepts both; never a pass or a fail");
  });

  define("png.wrong-hash-and-one-byte-mutation", () => {
    const png = f.baseline().files.get("output.png");
    const wrongHash = observe({ edit: (files) => { pngDescriptor(files).byte_hash = tagged(enc("something else")); } });
    assert.equal(wrongHash.pixels, "failed"); assert.deepEqual(wrongHash.failures, ["PNG_EXPECTATION_MISMATCH"]);
    const idat = chunks(png).find((entry) => entry.type === "IDAT");
    const mutated = f.clone(png); mutated[idat.offset + 20] ^= 1;
    const result = observe({ png: mutated });
    assert.equal(result.pixels, "failed"); assert.match(result.failures[0], /^PNG_(CHUNK_CRC_MISMATCH|ZLIB_INVALID|SCANLINE_[A-Z_]+)$/);
    const truncated = observe({ png: png.slice(0, -5) });
    assert.equal(truncated.pixels, "failed");
  });

  // ---- pdfsvg -----------------------------------------------------------------------------------------------
  define("pdfsvg.geometry-declared-not-observed", async () => {
    const report = await runGate(baselineWorld());
    assert.deepEqual({ state: criterion(report, "pdf_svg_geometry").state, code: criterion(report, "pdf_svg_geometry").code }, { state: "declared_not_observed", code: "PDF_SVG_GEOMETRY_UNOBSERVED" });
    assert.equal(criterion(report, "pdf_svg_signature").state, "verified_local");
    // Whatever the manifest declares for PDF/SVG geometry is never compared with anything: an absurd declaration still passes.
    const recommitted = f.recommit({ manifest: (manifest) => { for (const name of ["output.pdf", "output.svg"]) { const g = manifest.files.find((file) => file.filename === name).geometry; g.width_nm = "1"; g.height_nm = "1"; } } });
    assert.equal(f.ownerVerifyDirect(recommitted.files, recommitted.commitment).ok, true);
    const world = f.createWorld(); f.publishFromBaseline(world, recommitted.files, recommitted.commitmentBytes, recommitted.bundleHash);
    const absurd = await runGate(world, { bundleDigest: recommitted.bundleHash });
    assert.equal(absurd.verdict, "integrity_passed_blocked");
    assert.equal(criterion(absurd, "pdf_svg_geometry").state, "declared_not_observed");
    assert.equal(absurd.eligibility, "blocked");
  });

  // ---- geometry: unit ---------------------------------------------------------------------------------------
  define("geometry.unit.png-pixel-mismatch-fails", () => {
    for (const [label, edit] of [["width", (files) => { pngDescriptor(files).geometry.width_px = 1000; }], ["height", (files) => { pngDescriptor(files).geometry.height_px = 599; }]]) {
      const result = observe({ edit });
      assert.equal(result.pixels, "failed", label); assert.ok(result.failures.includes("OBSERVED_GEOMETRY_MISMATCH"), label);
    }
    const missing = observe({ edit: (files) => { pngDescriptor(files).geometry.width_px = null; } });
    assert.equal(missing.pixels, "failed"); assert.deepEqual(missing.failures, ["PNG_DECLARED_PIXELS_MISSING"]);
    const noGeometry = observe({ edit: (files) => { pngDescriptor(files).geometry = null; } });
    assert.equal(noGeometry.pixels, "failed");
  });

  define("geometry.unit.png-phys-mismatch-fails", () => {
    const png = f.baseline().files.get("output.png");
    const result = observe({ png: withPhys(png, 11772) });
    assert.equal(result.phys, "failed"); assert.deepEqual(result.failures, ["PHYS_METADATA_MISMATCH"]); assert.equal(result.pixels, "verified_local");
    const view = new DataView(withPhys(png, 11811).buffer);
    const skew = f.clone(png); const chunk = chunks(skew).find((entry) => entry.type === "pHYs");
    new DataView(skew.buffer).setUint32(chunk.offset + 12, 11812);
    new DataView(skew.buffer).setUint32(chunk.offset + 17, crc32(skew.subarray(chunk.offset + 4, chunk.offset + 17)));
    assert.equal(view.byteLength, png.length);
    assert.equal(observe({ png: skew }).phys, "failed", "x and y must both equal the encoded value");
  });

  define("geometry.unit.spoofed-mime-fails", () => {
    const cases = {
      pdfAsPng: [f.baseline().files.get("output.pdf"), "PNG_FORMAT_NOT_SUPPORTED"],
      jpegAsPng: [Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]), "PNG_FORMAT_NOT_SUPPORTED"],
      zipAsPng: [f.baseline().files.get("archive.zip"), "PNG_FORMAT_NOT_SUPPORTED"],
      garbageAsPng: [enc("not a png at all"), "PNG_SIGNATURE_MISMATCH"],
      emptyAsPng: [new Uint8Array(0), "PNG_SIGNATURE_MISMATCH"]
    };
    for (const [label, [bytes, code]] of Object.entries(cases)) {
      const result = observe({ png: bytes });
      assert.equal(result.pixels, "failed", label); assert.deepEqual(result.failures, [code], label);
    }
  });

  define("geometry.unit.pdf-and-svg-signature-negatives", () => {
    const pdf = f.baseline().files.get("output.pdf");
    assert.equal(observe().signature, "verified_local");
    for (const [label, bytes] of Object.entries({ noHeader: pdf.slice(1), htmlInstead: enc("<html></html>"), empty: new Uint8Array(0), shortHeader: enc("%PDF") })) {
      const result = observe({ pdf: bytes });
      assert.equal(result.signature, "failed", label); assert.ok(result.failures.includes("PDF_SIGNATURE_MISSING"), label);
    }
    const svgOk = ["<svg xmlns=\"http://www.w3.org/2000/svg\"/>", "<?xml version=\"1.0\"?>\n<!-- c -->\n<!DOCTYPE svg>\n<svg width=\"1\"></svg>", "﻿  <svg\n></svg>", "<svg/>"];
    const svgBad = { html: "<html><body/></html>", prefixed: "<svgx></svgx>", textFirst: "hello <svg/>", empty: "", xmlOnly: "<?xml version=\"1.0\"?>", commentOnly: "<!-- <svg> -->", unterminated: "<!-- never closed <svg/>" };
    for (const text of svgOk) assert.equal(observe({ svg: enc(text) }).signature, "verified_local", JSON.stringify(text));
    for (const [label, text] of Object.entries(svgBad)) {
      const result = observe({ svg: enc(text) });
      assert.equal(result.signature, "failed", label); assert.ok(result.failures.includes("SVG_ROOT_MISSING"), label);
    }
    assert.equal(observe({ svg: Uint8Array.from([0xff, 0xfe, 0x3c, 0x73]) }).signature, "failed", "invalid UTF-8 is not an SVG");
  });

  // ---- geometry: end-to-end (owner passes first, consumer fails) --------------------------------------------
  const png0 = () => f.baseline().files.get("output.png");
  define("geometry.e2e.recommitted-png-phys-mismatch-owner-passes-consumer-fails", async () => {
    for (const ppm of [11772, 11810]) {
      const { report, geometry } = await recommittedReport({ payload: { "output.png": withPhys(png0(), ppm) } });
      assert.equal(geometry.code, "PHYS_METADATA_MISMATCH", String(ppm));
      assert.equal(criterion(report, "png_phys_metadata").state, "failed"); assert.equal(criterion(report, "png_pixels").state, "verified_local");
    }
  });
  define("geometry.e2e.recommitted-declared-width-owner-passes-consumer-fails", async () => {
    const { report, geometry } = await recommittedReport({ manifest: (manifest) => { manifest.files.find((file) => file.filename === "output.png").geometry.width_px = 1000; } });
    assert.equal(geometry.code, "OBSERVED_GEOMETRY_MISMATCH");
    assert.equal(criterion(report, "png_pixels").state, "failed"); assert.equal(criterion(report, "png_effective_dpi").state, "failed");
  });
  define("geometry.e2e.recommitted-declared-dpi-owner-passes-consumer-fails", async () => {
    const { report, geometry } = await recommittedReport({ manifest: (manifest) => { manifest.files.find((file) => file.filename === "output.png").geometry.effective_dpi = 72; } });
    assert.equal(geometry.code, "DPI_DERIVATION_MISMATCH");
    assert.equal(criterion(report, "png_effective_dpi").state, "failed"); assert.equal(criterion(report, "png_pixels").state, "verified_local");
  });
  define("geometry.e2e.recommitted-png-bytes-are-pdf-owner-passes-consumer-fails", async () => {
    const { report, geometry } = await recommittedReport({ payload: { "output.png": f.baseline().files.get("output.pdf") } });
    assert.equal(geometry.code, "PNG_FORMAT_NOT_SUPPORTED");
    assert.ok(report.diagnostic.reasons.includes("PNG_FORMAT_NOT_SUPPORTED"));
  });
  define("geometry.e2e.recommitted-garbage-png-owner-passes-consumer-fails", async () => {
    const { geometry } = await recommittedReport({ payload: { "output.png": enc("not a png") } });
    assert.equal(geometry.code, "PNG_SIGNATURE_MISMATCH");
  });
  define("geometry.e2e.recommitted-pdf-without-signature-owner-passes-consumer-fails", async () => {
    const pdf = f.baseline().files.get("output.pdf").slice(); pdf[0] = 0x23;
    const { report, geometry } = await recommittedReport({ payload: { "output.pdf": pdf } });
    assert.equal(geometry.code, "PDF_SIGNATURE_MISSING"); assert.equal(criterion(report, "pdf_svg_signature").state, "failed");
  });
  define("geometry.e2e.recommitted-svg-without-root-owner-passes-consumer-fails", async () => {
    const { report, geometry } = await recommittedReport({ payload: { "output.svg": enc("<html><body>not svg</body></html>") } });
    assert.equal(geometry.code, "SVG_ROOT_MISSING"); assert.equal(criterion(report, "pdf_svg_signature").state, "failed");
  });

  define("geometry.owner-first-ordering-mutated-png-under-real-anchor-is-owner-integrity", async () => {
    const mutated = png0().slice(); mutated[100] ^= 255;
    const world = baselineWorld();
    world.bundles.get(f.BUNDLE_HASH).files.set("output.png", mutated);
    const report = await runGate(world);
    assert.equal(report.verdict, "integrity_failed");
    assert.equal(criterion(report, "owner_integrity").state, "failed"); assert.deepEqual(report.owner.codes, ["INTEGRITY_FAILURE"]);
    for (const id of ["observed_geometry_consistency", "png_pixels", "png_effective_dpi", "png_phys_metadata", "pdf_svg_signature"]) {
      assert.equal(criterion(report, id).state, "not_observed", `${id} is never reached: this is owner coverage, not geometry coverage`);
    }
    assert.deepEqual(report.diagnostic.attribution.problems, ["hash-mismatch:output.png"]);
  });

  // ---- fixtures ---------------------------------------------------------------------------------------------
  define("fixtures.recommit-helper-reproduces-baseline-manifest-detached-archive-byte-identical", () => {
    const rebuilt = f.recommit();
    const base = f.baseline();
    for (const name of ["manifest.json", "detached.json", "archive.zip", "output.svg", "output.png", "output.pdf", "preflight.json", "lineage.json"]) {
      assert.equal(f.sha256Hex(rebuilt.files.get(name)), f.sha256Hex(base.files.get(name)), `${name} is byte-identical to the real artifact`);
    }
    assert.equal(rebuilt.bundleHash, f.BUNDLE_HASH);
    assert.equal(f.ownerHelpers.canonicalJson(rebuilt.commitment), f.ownerHelpers.canonicalJson(base.commitment), "same commitment value (only its serialization differs)");
    assert.deepEqual(f.ownerVerifyDirect(rebuilt.files, rebuilt.commitment), { ok: true, integrity: "passed", eligibility: "blocked" });
  });

  define("fixtures.recommit-uses-only-owner-hash-helpers-and-test-only-zip-writer", () => {
    const source = readFileSync(new URL("./production-bundle-fixtures.mjs", import.meta.url), "utf8");
    const body = source.slice(source.indexOf("export function recommit"), source.indexOf("export const ownerVerifyDirect"));
    for (const required of ["ownerRoot.hashBytes", "ownerRoot.canonicalJson", "owner.productionBundleContentHash", "owner.productionPayloadSetHash", "storedZip("]) assert.ok(body.includes(required), required);
    assert.ok(!/createHash\s*\(/.test(body), "no hand-rolled hashing inside recommit");
    assert.ok(!/\bverifyProductionZip\b|\bverifyProductionBundleFiles\b|\bparseProductionCanonicalBytes\b/.test(body), "recommit contains no verifier");
    assert.ok(source.includes("export function storedZip"), "the ZIP writer lives in the test fixtures");
    assert.deepEqual(Object.keys(f.ownerHelpers).sort(), ["canonicalJson", "hashBytes", "productionBundleContentHash", "productionPayloadSetHash"]);
  });

  define("fixtures.test-zip-writer-not-importable-from-src", async () => {
    for (const file of ["production-bundle.ts", "production-bundle-contract.ts", "production-bundle-owner.ts", "runtime.ts"]) {
      const text = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
      assert.ok(!/storedZip|0x04034b50|0x02014b50|0x06054b50/.test(text), `${file} contains no ZIP writer or signature constants`);
    }
    assert.equal(Object.keys(bundle).some((key) => /zip/i.test(key)), false);
    assert.equal("storedZip" in bundle, false);
  });

  define("fixtures.independent-fixture-publication-pin-matches-committed-bytes", () => {
    const base = f.baseline();
    const world = f.createWorld(); f.publishFromBaseline(world);
    const entry = world.bundles.get(f.BUNDLE_HASH);
    assert.equal(entry.pin.sha256, tagged(base.commitmentBytes)); assert.equal(entry.pin.length, base.commitmentBytes.length);
    assert.equal(entry.pin.sha256, f.provenance.trustedCommitment.sha256.startsWith("sha256:") ? f.provenance.trustedCommitment.sha256 : `sha256:${f.provenance.trustedCommitment.sha256}`);
    const rebuilt = f.recommit();
    assert.equal(rebuilt.pin.sha256, tagged(rebuilt.commitmentBytes));
    assert.notEqual(rebuilt.pin.sha256, entry.pin.sha256, "the re-committed bundle has its own pin; it is not the producer's");
    assert.notEqual(rebuilt.pin.sha256, f.corpus.control_inventory[0].sha256);
  });
}
