/**
 * ProductionBundle consumer (FC-08, fulfillment-connectors #10): the real offline validator over the owner
 * `@jevelopers/shared-contracts` 0.9.7 byte-verification API, plus the gate the runtime fails closed on.
 *
 * Authority model, in one place:
 * - The owner verifier (via `production-bundle-owner.ts`) is the only authority for inventory, hashes, canonical
 *   manifest, detached protocol, ZIP and payload set. This module re-implements none of it.
 * - The trust anchor is a host-published pin resolved ONLY from `trustedScope + bundleDigest`; the commitment bytes are
 *   read through a content-addressed byte source and hashed against that pin BEFORE they are parsed. The command
 *   envelope, the caller and `CORPUS.json` can never choose an anchor, a hash, a provenance or a policy.
 * - Everything the owner cannot express stays a typed, frozen, CRITICAL blocked/unsupported criterion. The report type
 *   has no eligible/approved/accepted member, and owner 0.9.7 eligibility is intentionally unreachable.
 * - Bytes are copied once, defensively, with captured native intrinsics. The owner, the PNG decoder and the digests see
 *   only the private copies, never caller objects.
 *
 * Nothing here issues approval, authorization, pins or finance facts; the report is a derived observation.
 */
import { clearTimeout as realClearTimeout, setTimeout as realSetTimeout } from "node:timers";
import { types as utilTypes } from "node:util";
import {
  OWNER_PACKAGE_PIN,
  PRODUCTION_BUNDLE_CRITERIA,
  PRODUCTION_BUNDLE_GATE_KIND,
  PRODUCTION_BUNDLE_REPORT_VERSION,
  PRODUCTION_BUNDLE_VALIDATOR_VERSION,
  TRUSTED_COMMITMENT_DIGEST_KEY,
  computeReportDigest,
  computeSetDigest,
  isSha256Digest,
  openCriticalCodes,
  sealGenuineProductionBundleGate,
  sha256Digest,
  stableStringify,
  type ByteReadResult,
  type CriterionId,
  type CriterionResult,
  type CriterionState,
  type ProductionBundleAnchorProvenance,
  type ProductionBundleByteSource,
  type ProductionBundleGate,
  type ProductionBundleGateRequest,
  type ProductionBundlePublicationSource,
  type ProductionBundleReport,
  type PublicationResult,
  type TermsBindingDiagnostic
} from "./production-bundle-contract.js";
import {
  ownerLimits,
  ownerPreValidateCommitment,
  ownerSafeFilename,
  ownerVerifyBundle,
  toOwnerScope,
  type OwnerBundleRef,
  type OwnerLimits,
  type OwnerScope,
  type OwnerVerified
} from "./production-bundle-owner.js";
import { inspectPngBytes } from "./png-inspection.js";
import type { Clock, TrustedScope, TrustedTermsSource } from "./types.js";

// The values hosts need alongside the implementation. They live in the owner-free contract module; the package root exports only types.
export { OWNER_PACKAGE_PIN, PRODUCTION_BUNDLE_CRITERIA, PRODUCTION_BUNDLE_REPORT_VERSION, PRODUCTION_BUNDLE_VALIDATOR_VERSION };

// ---------------------------------------------------------------------------------------------------------
// 1. Native-intrinsic private snapshots (PBR-04, PBR-16)
// ---------------------------------------------------------------------------------------------------------

/**
 * Intrinsics are captured ONCE at module load. Runtime code never reads `view.buffer`, `.byteLength`, `.byteOffset`,
 * `.length`, `[Symbol.iterator]`, `.constructor`, `.set` or `.slice` as property accesses, and never iterates,
 * spreads, `Array.from`s, slices or consults a species. Pollution of the intrinsics BEFORE this module loads is
 * unobservable in-language and out of scope.
 */
const TypedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
function capturedGetter(owner: object, key: PropertyKey): () => unknown {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  if (descriptor === undefined || typeof descriptor.get !== "function") throw new Error("native intrinsic unavailable");
  return descriptor.get as () => unknown;
}
const taBufferGetter = capturedGetter(TypedArrayPrototype, "buffer");
const taByteLengthGetter = capturedGetter(TypedArrayPrototype, "byteLength");
const taByteOffsetGetter = capturedGetter(TypedArrayPrototype, "byteOffset");
const taTagGetter = capturedGetter(TypedArrayPrototype, Symbol.toStringTag);
const abResizableGetter = capturedGetter(ArrayBuffer.prototype, "resizable");
const abDetachedGetter = capturedGetter(ArrayBuffer.prototype, "detached");
const abByteLengthGetter = capturedGetter(ArrayBuffer.prototype, "byteLength");
const taSet = (TypedArrayPrototype as { readonly set: (...args: unknown[]) => unknown }).set;
const U8 = Uint8Array;
const AB = ArrayBuffer;
const U8Prototype = Uint8Array.prototype;
const ObjectPrototype = Object.prototype;
const apply = Reflect.apply;
const getOwnDescriptor = Object.getOwnPropertyDescriptor;
const getPrototypeOf = Object.getPrototypeOf;
const isArray = Array.isArray;
const freeze = Object.freeze;
const isProxy = utilTypes.isProxy;
const isUint8Array = utilTypes.isUint8Array;
const isArrayBuffer = utilTypes.isArrayBuffer;
const isSharedArrayBuffer = utilTypes.isSharedArrayBuffer;
const makeU8 = (buffer: unknown, offset: number, length: number): Uint8Array => new U8(buffer as ArrayBuffer, offset, length);

/**
 * Own-shadow deny-list DERIVED at load time from the intrinsic prototypes (never hand-typed). Checked by
 * descriptor presence only: values are never read and the dense index range is never enumerated. Enumerating a
 * dense view's own keys costs ~32 MiB of heap per MiB of view (measured), so "reject every non-index key" is not
 * implementable within the memory budget; the deny-list gives typed rejection while the captured intrinsics make
 * any own shadow inert for correctness (also proven in the suite with the deny-list disabled).
 */
export const PRODUCTION_BUNDLE_SHADOW_DENY_LIST: readonly PropertyKey[] = freeze([
  ...new Set<PropertyKey>([...Reflect.ownKeys(TypedArrayPrototype), ...Reflect.ownKeys(U8Prototype)])
]);

export type SnapshotReason =
  | "not_object" | "proxy" | "not_uint8array" | "not_exact_prototype" | "tag" | "own_shadow" | "shared_array_buffer"
  | "not_arraybuffer" | "resizable_or_detached" | "over_cap" | "window" | "threw";

export type ViewSnapshot =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: SnapshotReason };

export interface SnapshotOptions {
  /**
   * Test-only switch proving own shadows are inert without the deny-list (it only drops the typed `own_shadow`
   * diagnostic; bytes and verdicts are identical). It is accepted by the exported low-level snapshot helpers ONLY: it is
   * not a member of `ValidateBytesOptions`, so neither `validateProductionBundleBytes` nor the gate can be given it.
   */
  readonly skipShadowDenyList?: boolean;
}

const rejected = (reason: SnapshotReason): { readonly ok: false; readonly reason: SnapshotReason } => ({ ok: false, reason });

type InspectedView =
  | { readonly ok: true; readonly buffer: unknown; readonly offset: number; readonly length: number }
  | { readonly ok: false; readonly reason: SnapshotReason };

/**
 * NO-COPY inspection: every structural defence (Proxy, exact Uint8Array, tag, own-shadow descriptors, SharedArrayBuffer,
 * resizable/detached) plus the intrinsic length against `cap` and the window against the intrinsic buffer length. It reads
 * metadata through the captured native getters only; no value is read from the caller's object, no byte is copied, the
 * dense index range is never enumerated. Never throws.
 */
function inspectView(view: unknown, cap: number, options: SnapshotOptions): InspectedView {
  try {
    if (view === null || typeof view !== "object") return rejected("not_object");
    if (isProxy(view)) return rejected("proxy");
    if (!isUint8Array(view)) return rejected("not_uint8array");
    if (getPrototypeOf(view) !== U8Prototype) return rejected("not_exact_prototype");
    if (apply(taTagGetter, view, []) !== "Uint8Array") return rejected("tag");
    if (options.skipShadowDenyList !== true) {
      for (const key of PRODUCTION_BUNDLE_SHADOW_DENY_LIST) if (getOwnDescriptor(view, key) !== undefined) return rejected("own_shadow");
    }
    const buffer = apply(taBufferGetter, view, []);
    if (isSharedArrayBuffer(buffer)) return rejected("shared_array_buffer");
    if (!isArrayBuffer(buffer)) return rejected("not_arraybuffer");
    if (apply(abResizableGetter, buffer, []) === true || apply(abDetachedGetter, buffer, []) === true) return rejected("resizable_or_detached");
    const length = apply(taByteLengthGetter, view, []) as number;
    const offset = apply(taByteOffsetGetter, view, []) as number;
    if (length > cap) return rejected("over_cap");
    if (offset + length > (apply(abByteLengthGetter, buffer, []) as number)) return rejected("window");
    return { ok: true, buffer, offset, length };
  } catch {
    return rejected("threw");
  }
}

/** Copies the exact intrinsic window of a `Uint8Array` into a fresh private `ArrayBuffer`. Never throws. */
export function snapshotProductionBundleView(view: unknown, cap: number, options: SnapshotOptions = {}): ViewSnapshot {
  const inspected = inspectView(view, cap, options);
  if (!inspected.ok) return rejected(inspected.reason);
  try {
    const copy = new U8(new AB(inspected.length));
    apply(taSet, copy, [makeU8(inspected.buffer, inspected.offset, inspected.length)]);
    return { ok: true, bytes: copy };
  } catch {
    return rejected("threw");
  }
}

function dataValue(record: object, key: string): { readonly value: unknown } | null {
  const descriptor = getOwnDescriptor(record, key);
  return descriptor !== undefined && "value" in descriptor ? { value: descriptor.value } : null;
}

export type SnapshotFile = { readonly filename: string; readonly bytes: Uint8Array };
export type FilesSnapshot =
  | { readonly ok: true; readonly files: readonly SnapshotFile[] }
  | { readonly ok: false; readonly reason: SnapshotReason | "count" | "hole_or_accessor" | "files_not_plain_array" | "not_plain_object" | "accessor_or_missing" | "filename" | "duplicate_filename" | "aggregate_over_cap" | "payload_group_over_cap" };

/** Everything a file list must satisfy BEFORE the first byte is copied. All numbers come from the owner's exported limits. */
export interface FileListBounds {
  /** Exact maximum entry count (the owner's `outer_descriptors`). */
  readonly maxCount: number;
  /** Maximum sum of the intrinsic lengths of all entries. */
  readonly aggregateCap: number;
  /** Maximum sum of the intrinsic lengths of the entries for which `isPayload` is true (the owner's `payload_bytes`). */
  readonly payloadGroupCap: number;
  readonly isPayload: (filename: string) => boolean;
}

/**
 * Snapshots a caller-supplied file list: `[{ filename, bytes }]`, in TWO passes.
 *
 * Pass 1 copies nothing. The array length is read through an own data descriptor and bounded BEFORE any element is
 * touched; elements are read by data descriptor (no iterator, so an `@@iterator` hook is inert); entries must be plain
 * objects with data properties `filename` and `bytes`, and no other key is ever read. Each name is checked for a
 * case-insensitive duplicate, each view is inspected through the native intrinsics (see `inspectView`) against its own
 * per-name cap, and the running sums are checked against the aggregate and payload-group caps with safe-integer
 * arithmetic. A view repeated under many names therefore counts once per entry and cannot amplify memory.
 *
 * Pass 2 allocates the private copies, only after the whole list passed pass 1, so the copies can never exceed
 * `aggregateCap` bytes in total.
 */
export function snapshotProductionBundleFiles(files: unknown, capFor: (filename: string) => number, bounds: FileListBounds, options: SnapshotOptions = {}): FilesSnapshot {
  try {
    if (!isArray(files) || isProxy(files)) return { ok: false, reason: "files_not_plain_array" };
    const lengthDescriptor = getOwnDescriptor(files, "length");
    if (lengthDescriptor === undefined || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value) || !((lengthDescriptor.value as number) <= bounds.maxCount)) return { ok: false, reason: "count" };
    const planned: { readonly filename: string; readonly view: unknown; readonly cap: number }[] = [];
    const names = new Set<string>();
    let total = 0;
    let payloadTotal = 0;
    for (let index = 0; index < (lengthDescriptor.value as number); index += 1) {
      const element = getOwnDescriptor(files, String(index));
      if (element === undefined || !("value" in element)) return { ok: false, reason: "hole_or_accessor" };
      const entry = element.value as unknown;
      if (entry === null || typeof entry !== "object" || isProxy(entry) || getPrototypeOf(entry) !== ObjectPrototype) return { ok: false, reason: "not_plain_object" };
      const name = dataValue(entry, "filename");
      const bytes = dataValue(entry, "bytes");
      if (name === null || bytes === null) return { ok: false, reason: "accessor_or_missing" };
      if (typeof name.value !== "string" || name.value.length === 0 || name.value.length > 128) return { ok: false, reason: "filename" };
      const folded = name.value.toLowerCase();
      if (names.has(folded)) return { ok: false, reason: "duplicate_filename" };
      names.add(folded);
      const cap = capFor(name.value);
      const inspected = inspectView(bytes.value, cap, options);
      if (!inspected.ok) return { ok: false, reason: inspected.reason };
      total += inspected.length;
      if (!Number.isSafeInteger(total) || !(total <= bounds.aggregateCap)) return { ok: false, reason: "aggregate_over_cap" };
      if (bounds.isPayload(name.value)) {
        payloadTotal += inspected.length;
        if (!Number.isSafeInteger(payloadTotal) || !(payloadTotal <= bounds.payloadGroupCap)) return { ok: false, reason: "payload_group_over_cap" };
      }
      planned.push({ filename: name.value, view: bytes.value, cap });
    }
    const out: SnapshotFile[] = [];
    for (const item of planned) {
      const copy = snapshotProductionBundleView(item.view, item.cap, options);
      if (!copy.ok) return copy;
      out.push(freeze({ filename: item.filename, bytes: copy.bytes }));
    }
    return { ok: true, files: freeze(out) };
  } catch {
    return { ok: false, reason: "threw" };
  }
}

export type ByteSourceSnapshot =
  | { readonly ok: true; readonly missing: true }
  | { readonly ok: true; readonly missing: false; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: SnapshotReason | "result_shape" | "result_status" };

/** The same rule, applied to whatever a host `ByteSource.read` returned. */
export function snapshotByteSourceResult(result: unknown, cap: number): ByteSourceSnapshot {
  try {
    if (result === null || typeof result !== "object" || isProxy(result)) return { ok: false, reason: "result_shape" };
    const status = dataValue(result, "status");
    if (status === null) return { ok: false, reason: "result_shape" };
    if (status.value === "missing") return { ok: true, missing: true };
    if (status.value !== "found") return { ok: false, reason: "result_status" };
    const bytes = dataValue(result, "bytes");
    if (bytes === null) return { ok: false, reason: "result_shape" };
    const copy = snapshotProductionBundleView(bytes.value, cap);
    return copy.ok ? { ok: true, missing: false, bytes: copy.bytes } : copy;
  } catch {
    return { ok: false, reason: "threw" };
  }
}

// ---------------------------------------------------------------------------------------------------------
// 2. Finite real-time deadlines, abort, late-completion safety, bounded concurrency (PBR-22, PBR-25)
// ---------------------------------------------------------------------------------------------------------

export interface ProductionBundleGateLimits {
  readonly resolveMs?: number;
  readonly readMs?: number;
  readonly totalMs?: number;
  readonly maxConcurrent?: number;
  readonly maxQueued?: number;
}
interface ResolvedLimits { readonly resolveMs: number; readonly readMs: number; readonly totalMs: number; readonly maxConcurrent: number; readonly maxQueued: number }

/** Consumer RESOURCE bounds. They cannot select criteria and no monetary budget exists here. */
export const PRODUCTION_BUNDLE_DEFAULT_LIMITS: ResolvedLimits = freeze({ resolveMs: 5_000, readMs: 15_000, totalMs: 60_000, maxConcurrent: 2, maxQueued: 32 });

function resolveLimits(limits: ProductionBundleGateLimits | undefined): ResolvedLimits {
  const merged = { ...PRODUCTION_BUNDLE_DEFAULT_LIMITS, ...(limits ?? {}) };
  const ms = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 120_000;
  if (!ms(merged.resolveMs) || !ms(merged.readMs) || !ms(merged.totalMs)) throw new TypeError("deadlines must be integers within 1..120000 ms");
  if (!Number.isInteger(merged.maxConcurrent) || merged.maxConcurrent < 1 || merged.maxConcurrent > 8) throw new TypeError("maxConcurrent must be 1..8");
  if (!Number.isInteger(merged.maxQueued) || merged.maxQueued < 0 || merged.maxQueued > 256) throw new TypeError("maxQueued must be 0..256");
  return freeze({ ...merged });
}

type Timed<T> = { readonly status: "ok"; readonly value: T } | { readonly status: "deadline" } | { readonly status: "aborted" } | { readonly status: "failed" };

/**
 * Runs a host port call under a REAL wall-clock deadline (`node:timers`), never the injected `Clock` (fixtures may freeze
 * it). The child signal aborts at the deadline or when the parent aborts. A completion or rejection that arrives after
 * the call settled is dropped, its bytes are not retained, and a late rejection is swallowed.
 */
export function runWithDeadline<T>(start: (signal: AbortSignal) => Promise<T>, ms: number, parent: AbortSignal): Promise<Timed<T>> {
  return new Promise<Timed<T>>((resolve) => {
    if (parent.aborted) { resolve({ status: "aborted" }); return; }
    const controller = new AbortController();
    let settled = false;
    const finish = (value: Timed<T>): void => {
      if (settled) return;
      settled = true;
      realClearTimeout(timer);
      parent.removeEventListener("abort", onParentAbort);
      resolve(value);
    };
    const onParentAbort = (): void => { controller.abort(); finish({ status: "aborted" }); };
    const timer = realSetTimeout(() => { controller.abort(); finish({ status: "deadline" }); }, ms);
    parent.addEventListener("abort", onParentAbort, { once: true });
    let pending: Promise<T>;
    try {
      pending = Promise.resolve(start(controller.signal));
    } catch {
      finish({ status: "failed" });
      return;
    }
    pending.then((value) => finish({ status: "ok", value }), () => finish({ status: "failed" }));
  });
}

type Acquired = { readonly status: "acquired"; readonly release: () => void } | { readonly status: "queue_full" } | { readonly status: "timeout" } | { readonly status: "aborted" };

/** FIFO counting semaphore. Release is idempotent; a waiter that times out or aborts leaves the queue. */
export class BoundedSemaphore {
  private free: number;
  private readonly waiters: Array<(grant: () => void) => void> = [];
  constructor(width: number, private readonly maxQueued: number) { this.free = width; }

  private grant(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next === undefined) this.free += 1;
      else next(this.grant());
    };
  }

  acquire(timeoutMs: number, signal: AbortSignal): Promise<Acquired> {
    if (signal.aborted) return Promise.resolve({ status: "aborted" });
    if (this.free > 0) { this.free -= 1; return Promise.resolve({ status: "acquired", release: this.grant() }); }
    if (this.waiters.length >= this.maxQueued) return Promise.resolve({ status: "queue_full" });
    return new Promise<Acquired>((resolve) => {
      let done = false;
      const waiter = (grant: () => void): void => {
        if (done) { grant(); return; }
        done = true;
        realClearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve({ status: "acquired", release: grant });
      };
      const leave = (status: "timeout" | "aborted"): void => {
        if (done) return;
        done = true;
        realClearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve({ status });
      };
      const onAbort = (): void => leave("aborted");
      const timer = realSetTimeout(() => leave("timeout"), timeoutMs);
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  /** Test visibility only. */
  state(): { readonly free: number; readonly queued: number } { return { free: this.free, queued: this.waiters.length }; }
}

// ---------------------------------------------------------------------------------------------------------
// 3. Trust anchor (PBR-01, PBR-21) and budgets (PBR-05)
// ---------------------------------------------------------------------------------------------------------

export interface AnchoredDescriptor {
  readonly filename: string;
  readonly role: string;
  readonly byteSize: number;
  readonly byteHash: string;
  readonly cap: number;
}

/** Created only by `resolveTrustAnchor` and tracked in a module-private registry; a hand-built object is rejected. */
export interface ProductionBundleTrustAnchor {
  readonly bundleDigest: string;
  readonly commitment: OwnerBundleRef;
  readonly commitmentSha256: string;
  readonly commitmentLength: number;
  readonly provenance: ProductionBundleAnchorProvenance;
  readonly descriptors: readonly AnchoredDescriptor[];
  readonly ownerScope: OwnerScope;
  readonly trustedScope: TrustedScope;
}

const issuedAnchors = new WeakSet<object>();
export const isIssuedTrustAnchor = (candidate: unknown): candidate is ProductionBundleTrustAnchor =>
  typeof candidate === "object" && candidate !== null && issuedAnchors.has(candidate);

export interface AnchorSuccess { readonly ok: true; readonly anchor: ProductionBundleTrustAnchor }
export interface AnchorFailure { readonly ok: false; readonly codes: readonly string[]; readonly commitmentSha256?: string; readonly provenance?: ProductionBundleAnchorProvenance }

/** archive + manifest + detached + payload, all from the owner export. */
function aggregateCapOf(limits: OwnerLimits): number {
  return limits.archiveBytes + limits.manifestBytes + limits.detachedBytes + limits.payloadBytes;
}

const SINGLE_FILE_ROLES: ReadonlySet<string> = new Set(["archive", "manifest", "detached"]);

function roleCap(role: string, limits: OwnerLimits): number {
  return role === "archive" ? limits.archiveBytes : role === "manifest" ? limits.manifestBytes : role === "detached" ? limits.detachedBytes : limits.entryBytes;
}

/**
 * Derives the read budget from the owner-pre-validated commitment BEFORE any payload is read: descriptor count,
 * per-role cap and aggregate cap all come from the owner's exported `productionArchiveLimits`.
 */
export function deriveBudgets(commitment: OwnerBundleRef, limits: OwnerLimits): { readonly ok: true; readonly descriptors: readonly AnchoredDescriptor[] } | { readonly ok: false; readonly code: string } {
  const fileSet = (commitment as unknown as { readonly file_set: readonly { readonly filename: string; readonly role: string; readonly byte_size: number; readonly byte_hash: string }[] }).file_set;
  if (!Array.isArray(fileSet) || fileSet.length < 1 || fileSet.length > limits.outerDescriptors) return { ok: false, code: "BUDGET_DESCRIPTOR_COUNT" };
  const aggregateCap = aggregateCapOf(limits);
  const descriptors: AnchoredDescriptor[] = [];
  const names = new Set<string>();
  let total = 0;
  for (const entry of fileSet) {
    const cap = roleCap(entry.role, limits);
    if (!ownerSafeFilename(entry.filename) || names.has(entry.filename.toLowerCase())) return { ok: false, code: "BUDGET_FILENAME" };
    names.add(entry.filename.toLowerCase());
    if (!Number.isSafeInteger(entry.byte_size) || entry.byte_size < 0 || entry.byte_size > cap) return { ok: false, code: "BUDGET_ROLE_CAP" };
    total += entry.byte_size;
    if (total > aggregateCap) return { ok: false, code: "BUDGET_AGGREGATE_CAP" };
    descriptors.push(freeze({ filename: entry.filename, role: entry.role, byteSize: entry.byte_size, byteHash: entry.byte_hash, cap }));
  }
  return { ok: true, descriptors: freeze(descriptors) };
}

interface PortContext {
  readonly limits: ResolvedLimits;
  readonly signal: AbortSignal;
}

function readPublication(result: unknown): PublicationResult | null {
  try {
    if (result === null || typeof result !== "object" || isProxy(result)) return null;
    const status = dataValue(result, "status");
    if (status === null) return null;
    if (status.value === "unpublished") return { status: "unpublished" };
    if (status.value !== "published") return null;
    const bundleDigest = dataValue(result, "bundleDigest");
    const commitment = dataValue(result, "commitment");
    const provenance = dataValue(result, "provenance");
    if (bundleDigest === null || commitment === null || provenance === null) return null;
    const c = commitment.value, p = provenance.value;
    if (c === null || typeof c !== "object" || isProxy(c) || p === null || typeof p !== "object" || isProxy(p)) return null;
    const length = dataValue(c, "length"), sha = dataValue(c, "sha256"), kind = dataValue(p, "kind"), digest = dataValue(p, "digest");
    if (length === null || sha === null || kind === null || digest === null) return null;
    if (typeof bundleDigest.value !== "string" || typeof length.value !== "number" || typeof sha.value !== "string" || kind.value !== "development_fixture" || typeof digest.value !== "string") return null;
    return { status: "published", bundleDigest: bundleDigest.value, commitment: { length: length.value, sha256: sha.value }, provenance: { kind: "development_fixture", digest: digest.value } };
  } catch {
    return null;
  }
}

const COMMITMENT_FILENAME = "trusted-commitment.json";

/**
 * Resolves the anchor from the host publication source, reads the commitment through the content-addressed byte
 * source, checks LENGTH then SHA-256 against the pin BEFORE parsing, parses defensively, structurally pre-validates
 * with the owner, and only then derives the read budget. `commitment.eligibility`, `handoff_eligible` and every
 * "accepted"-looking field are never read for any decision.
 */
export async function resolveTrustAnchor(
  request: { readonly trustedScope: TrustedScope; readonly bundleDigest: string },
  ports: { readonly publication: ProductionBundlePublicationSource; readonly bytes: ProductionBundleByteSource },
  context: PortContext
): Promise<AnchorSuccess | AnchorFailure> {
  const limits = ownerLimits();
  if (!isSha256Digest(request.bundleDigest)) return { ok: false, codes: ["BUNDLE_DIGEST_INVALID"] };
  const publicationOutcome = await runWithDeadline((signal) => ports.publication.resolve({ trustedScope: request.trustedScope, bundleDigest: request.bundleDigest, signal }), context.limits.resolveMs, context.signal);
  if (publicationOutcome.status !== "ok") return { ok: false, codes: [publicationOutcome.status === "failed" ? "PUBLICATION_SOURCE_FAILED" : publicationOutcome.status === "deadline" ? "DEADLINE" : "ABORTED"] };
  const publication = readPublication(publicationOutcome.value);
  if (publication === null) return { ok: false, codes: ["PUBLICATION_RESULT_INVALID"] };
  if (publication.status === "unpublished") return { ok: false, codes: ["BUNDLE_UNPUBLISHED"] };
  if (publication.bundleDigest !== request.bundleDigest) return { ok: false, codes: ["PUBLICATION_DIGEST_MISMATCH"] };
  const pin = publication.commitment;
  // The 4 MiB commitment ceiling is a CONSUMER resource bound borrowed from the owner's manifest ceiling; it is not an owner/canonical rule.
  if (!isSha256Digest(pin.sha256) || !Number.isSafeInteger(pin.length) || pin.length < 1 || pin.length > limits.manifestBytes || !isSha256Digest(publication.provenance.digest)) return { ok: false, codes: ["PUBLICATION_PIN_INVALID"] };

  const read = await runWithDeadline<ByteReadResult>((signal) => ports.bytes.read({ trustedScope: request.trustedScope, role: "commitment", filename: COMMITMENT_FILENAME, byteHash: pin.sha256, maxLength: pin.length, signal }), context.limits.readMs, context.signal);
  if (read.status !== "ok") return { ok: false, codes: [read.status === "failed" ? "BYTE_SOURCE_FAILED" : read.status === "deadline" ? "DEADLINE" : "ABORTED"], provenance: publication.provenance };
  const snapshot = snapshotByteSourceResult(read.value, pin.length);
  if (!snapshot.ok) return { ok: false, codes: ["SNAPSHOT_REJECTED"], provenance: publication.provenance };
  if (snapshot.missing) return { ok: false, codes: ["COMMITMENT_MISSING"], provenance: publication.provenance };
  if (snapshot.bytes.length !== pin.length) return { ok: false, codes: ["COMMITMENT_LENGTH_MISMATCH"], provenance: publication.provenance };
  const commitmentSha256 = sha256Digest(snapshot.bytes);
  if (commitmentSha256 !== pin.sha256) return { ok: false, codes: ["COMMITMENT_PIN_MISMATCH"], commitmentSha256, provenance: publication.provenance };

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(snapshot.bytes));
  } catch {
    return { ok: false, codes: ["COMMITMENT_PARSE_FAILED"], commitmentSha256, provenance: publication.provenance };
  }
  const ownerScope = toOwnerScope(request.trustedScope);
  const validated = ownerPreValidateCommitment(parsed, ownerScope);
  if (!validated.ok) return { ok: false, codes: validated.codes.map((code) => `OWNER_${code}`), commitmentSha256, provenance: publication.provenance };
  if (validated.value.bundle_ref.content_hash !== request.bundleDigest) return { ok: false, codes: ["COMMITMENT_BUNDLE_MISMATCH"], commitmentSha256, provenance: publication.provenance };
  const budgets = deriveBudgets(validated.value, limits);
  if (!budgets.ok) return { ok: false, codes: [budgets.code], commitmentSha256, provenance: publication.provenance };
  const anchor: ProductionBundleTrustAnchor = freeze({
    bundleDigest: request.bundleDigest,
    commitment: validated.value,
    commitmentSha256,
    commitmentLength: pin.length,
    provenance: freeze({ kind: "development_fixture" as const, digest: publication.provenance.digest }),
    descriptors: budgets.descriptors,
    ownerScope,
    trustedScope: freeze({ tenantId: request.trustedScope.tenantId, projectId: request.trustedScope.projectId })
  });
  issuedAnchors.add(anchor);
  return { ok: true, anchor };
}

// ---------------------------------------------------------------------------------------------------------
// 4. Local observation of print outputs (PBR-06): real PNG pixels; PDF/SVG signature only
// ---------------------------------------------------------------------------------------------------------

const NM_PER_INCH = 25_400_000n;

function svgRootPresent(text: string): boolean {
  let position = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (let step = 0; step < 16; step += 1) {
    while (position < text.length && /\s/.test(text.charAt(position))) position += 1;
    if (text.startsWith("<?xml", position)) { const end = text.indexOf("?>", position); if (end < 0) return false; position = end + 2; continue; }
    if (text.startsWith("<!--", position)) { const end = text.indexOf("-->", position); if (end < 0) return false; position = end + 3; continue; }
    if (text.startsWith("<!DOCTYPE", position)) {
      const bracket = text.indexOf("[", position), close = text.indexOf(">", position);
      if (close < 0) return false;
      if (bracket >= 0 && bracket < close) { const end = text.indexOf("]>", bracket); if (end < 0) return false; position = end + 2; } else position = close + 1;
      continue;
    }
    break;
  }
  if (!text.startsWith("<svg", position)) return false;
  const next = text.charAt(position + 4);
  return next === ">" || next === "/" || /\s/.test(next);
}

export interface PrintOutputObservation {
  readonly pixels: CriterionState; readonly pixelsCode: string | null;
  readonly dpi: CriterionState; readonly dpiCode: string | null;
  readonly phys: CriterionState; readonly physCode: string | null;
  readonly signature: CriterionState; readonly signatureCode: string | null;
  /** Failure codes only, in the order observed. */
  readonly failures: readonly string[];
  /** Failure codes first, then informational notes (for example an unobserved media type). */
  readonly reasons: readonly string[];
}

export type DeclaredPrintFile = OwnerVerified["bundle"]["files"][number];

/**
 * Pure observation of owner-declared print outputs against their bytes: real PNG pixels and pHYs through the existing
 * decoder, effective DPI derived by integer arithmetic from observed pixels and declared nanometres, PDF/SVG signature
 * only. PDF/SVG geometry is never observed. None of this is supplier fit.
 */
export function observePrintOutputs(files: readonly DeclaredPrintFile[], bytesByName: ReadonlyMap<string, Uint8Array>): PrintOutputObservation {
  const reasons: string[] = [];
  const notes: string[] = [];
  const track = { pixels: [] as boolean[], dpi: [] as (boolean | null)[], phys: [] as (boolean | null)[], signature: [] as boolean[] };
  const fail = (code: string): void => { reasons.push(code); };
  for (const declared of files) {
    if (declared.role !== "print_output") continue;
    const bytes = bytesByName.get(declared.filename);
    if (bytes === undefined) { fail("OBSERVATION_BYTES_MISSING"); track.signature.push(false); continue; }
    if (declared.media_type === "image/png") {
      const inspected = inspectPngBytes(bytes, "image/png", declared.byte_size, declared.byte_hash);
      if (inspected.status !== "inspected" || inspected.metadata === null) {
        track.pixels.push(false); fail(`PNG_${inspected.code.toUpperCase()}`); continue;
      }
      const geometry = declared.geometry;
      const metadata = inspected.metadata;
      if (geometry === null || geometry.width_px === null || geometry.height_px === null) { track.pixels.push(false); fail("PNG_DECLARED_PIXELS_MISSING"); continue; }
      const pixelsMatch = metadata.width === geometry.width_px && metadata.height === geometry.height_px;
      track.pixels.push(pixelsMatch);
      if (!pixelsMatch) fail("OBSERVED_GEOMETRY_MISMATCH");
      if (geometry.effective_dpi === null) { track.dpi.push(null); }
      else {
        let derived = false;
        try {
          derived = BigInt(geometry.width_px) * NM_PER_INCH === BigInt(geometry.effective_dpi) * BigInt(geometry.width_nm) &&
            BigInt(geometry.height_px) * NM_PER_INCH === BigInt(geometry.effective_dpi) * BigInt(geometry.height_nm);
        } catch { derived = false; }
        track.dpi.push(derived);
        if (!derived) fail("DPI_DERIVATION_MISMATCH");
      }
      const physical = metadata.physicalResolution;
      if (physical === null || physical.unit !== "metre" || geometry.effective_dpi === null) track.phys.push(null);
      else {
        // The PNG integer pixels-per-metre ENCODING identity (300 dpi -> 11811), not a tolerance and not a supplier-fit claim.
        const encoded = Math.round((geometry.effective_dpi * 10_000) / 254);
        const consistent = physical.pixelsPerUnitX === encoded && physical.pixelsPerUnitY === encoded;
        track.phys.push(consistent);
        if (!consistent) fail("PHYS_METADATA_MISMATCH");
      }
    } else if (declared.media_type === "application/pdf") {
      const ok = bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
      track.signature.push(ok);
      if (!ok) fail("PDF_SIGNATURE_MISSING");
    } else if (declared.media_type === "image/svg+xml") {
      let text: string | null = null;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { text = null; }
      const ok = text !== null && svgRootPresent(text);
      track.signature.push(ok);
      if (!ok) fail("SVG_ROOT_MISSING");
    } else {
      notes.push(`MEDIA_TYPE_NOT_OBSERVED:${declared.media_type}`.slice(0, 96).toUpperCase().replace(/[^A-Z0-9_:.-]/g, "_"));
    }
  }
  const verdict = (values: readonly (boolean | null)[], failedCode: string): { state: CriterionState; code: string | null } => {
    if (values.some((value) => value === false)) return { state: "failed", code: failedCode };
    if (values.some((value) => value === true)) return { state: "verified_local", code: null };
    return { state: "not_observed", code: "NOT_OBSERVED" };
  };
  const pixels = verdict(track.pixels, "OBSERVED_GEOMETRY_MISMATCH");
  const dpi = verdict(track.dpi, "DPI_DERIVATION_MISMATCH");
  const phys = verdict(track.phys, "PHYS_METADATA_MISMATCH");
  const signature = verdict(track.signature, "SIGNATURE_MISMATCH");
  return { pixels: pixels.state, pixelsCode: pixels.code, dpi: dpi.state, dpiCode: dpi.code, phys: phys.state, physCode: phys.code, signature: signature.state, signatureCode: signature.code, failures: freeze([...reasons]), reasons: freeze([...reasons, ...notes]) };
}

// ---------------------------------------------------------------------------------------------------------
// 5. Sealed attribution diagnostic (PBR-08)
// ---------------------------------------------------------------------------------------------------------

/**
 * Names which anchored file failed. Runs ONLY after an owner or custody failure, compares only roster, length and
 * SHA-256 against the anchor's owner-validated file set, never parses the manifest, ZIP or detached file, and never
 * feeds the verdict, a criterion or an error code.
 */
export function attributeFailure(descriptors: readonly AnchoredDescriptor[], observed: readonly SnapshotFile[]): { readonly authoritative: false; readonly problems: readonly string[] } | "unattributed" {
  const problems: string[] = [];
  const byName = new Map(observed.map((file) => [file.filename, file]));
  for (const descriptor of descriptors) {
    const file = byName.get(descriptor.filename);
    if (file === undefined) problems.push(`missing:${descriptor.filename}`);
    else if (file.bytes.length !== descriptor.byteSize) problems.push(`length-mismatch:${descriptor.filename}`);
    else if (sha256Digest(file.bytes) !== descriptor.byteHash) problems.push(`hash-mismatch:${descriptor.filename}`);
  }
  const anchored = new Set(descriptors.map((descriptor) => descriptor.filename));
  for (const file of observed) if (!anchored.has(file.filename)) problems.push(`extra:${ownerSafeFilename(file.filename) ? file.filename : "unsafe-name"}`);
  return problems.length === 0 ? "unattributed" : freeze({ authoritative: false as const, problems: freeze(problems) });
}

// ---------------------------------------------------------------------------------------------------------
// 6. Evaluation and report building
// ---------------------------------------------------------------------------------------------------------

class Accumulator {
  readonly states = new Map<CriterionId, { state: CriterionState; code: string | null }>();
  readonly reasons: string[] = [];
  ownerCodes: readonly string[] = [];
  anchor: { readonly provenance: ProductionBundleAnchorProvenance; readonly commitmentSha256: string } | null = null;
  bundle: { readonly hash: string; readonly id: string; readonly revision: number } | null = null;
  specRef: ProductionBundleReport["specRef"] = { state: "blocked", code: "SPEC_REF_UNAVAILABLE" };
  inputDigests: Record<string, string> = {};
  outputDigests: Record<string, string> = {};
  attribution: { readonly authoritative: false; readonly problems: readonly string[] } | "unattributed" | undefined;
  termsBinding: TermsBindingDiagnostic | undefined;

  set(id: CriterionId, state: CriterionState, code: string | null): void { this.states.set(id, { state, code }); }
  fail(id: CriterionId, code: string): void { this.set(id, "failed", code); if (!this.reasons.includes(code)) this.reasons.push(code); }
  reason(code: string): void { if (!this.reasons.includes(code)) this.reasons.push(code); }
}

function criterionResults(acc: Accumulator): readonly CriterionResult[] {
  return freeze(PRODUCTION_BUNDLE_CRITERIA.map((definition) => {
    if (definition.fixed !== null) return freeze({ id: definition.id, state: definition.fixed.state, critical: definition.critical, code: definition.fixed.code });
    const chosen = acc.states.get(definition.id);
    if (chosen !== undefined) return freeze({ id: definition.id, state: chosen.state, critical: definition.critical, code: chosen.code });
    return freeze({ id: definition.id, state: "not_observed" as const, critical: definition.critical, code: "NOT_EVALUATED" });
  }));
}

const REASON_PATTERN = /^[A-Z0-9_:.-]{1,96}$/;

function buildReport(acc: Accumulator, clock: Clock, consumerRevision: string | null): ProductionBundleReport {
  const criteria = criterionResults(acc);
  const verdict = criteria.some((criterion) => criterion.state === "failed") || acc.states.get("owner_integrity")?.state !== "verified_owner" ||
    acc.states.get("anchor_resolution")?.state !== "verified_local" || acc.states.get("byte_custody")?.state !== "verified_local"
    ? "integrity_failed" as const : "integrity_passed_blocked" as const;
  let evaluatedAt = "1970-01-01T00:00:00.000Z";
  try {
    const now = clock.now();
    if (Number.isFinite(now)) evaluatedAt = new Date(now).toISOString();
    else acc.reason("CLOCK_INVALID");
  } catch { acc.reason("CLOCK_INVALID"); }
  const inputDigests = freeze({ ...acc.inputDigests });
  const outputDigests = freeze({ ...acc.outputDigests });
  const reasons = acc.reasons.filter((reason) => REASON_PATTERN.test(reason)).slice(0, 64);
  const diagnostic = {
    ...(reasons.length === 0 ? {} : { reasons: freeze(reasons) }),
    ...(acc.attribution === undefined || verdict === "integrity_passed_blocked" ? {} : { attribution: acc.attribution }),
    ...(acc.termsBinding === undefined ? {} : { termsBinding: acc.termsBinding })
  };
  const body: Omit<ProductionBundleReport, "reportDigest"> = {
    reportVersion: PRODUCTION_BUNDLE_REPORT_VERSION,
    verdict,
    eligibility: "blocked",
    authorityIssued: false,
    accepted: false,
    handoffEligible: false,
    openCriticalCodes: openCriticalCodes(criteria),
    criteria,
    bundle: acc.bundle,
    anchor: acc.anchor,
    owner: freeze({ package: OWNER_PACKAGE_PIN.name, version: OWNER_PACKAGE_PIN.version, archiveSha256: OWNER_PACKAGE_PIN.archiveSha256, integrity: OWNER_PACKAGE_PIN.integrity, accepted: false as const, codes: freeze([...acc.ownerCodes]) }),
    specRef: acc.specRef,
    consumer: freeze({ revision: consumerRevision, validatorVersion: PRODUCTION_BUNDLE_VALIDATOR_VERSION }),
    evaluatedAt,
    inputDigests,
    outputDigests,
    unchanged: stableStringify(inputDigests) === stableStringify(outputDigests),
    setDigest: computeSetDigest(inputDigests),
    ...(Object.keys(diagnostic).length === 0 ? {} : { diagnostic: freeze(diagnostic) })
  };
  return freeze({ ...body, reportDigest: computeReportDigest(body as ProductionBundleReport) });
}

function digestsOf(files: readonly SnapshotFile[], commitmentSha256: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (commitmentSha256 !== null) out[TRUSTED_COMMITMENT_DIGEST_KEY] = commitmentSha256;
  for (const file of files) out[file.filename] = sha256Digest(file.bytes);
  return out;
}

interface EvaluateInput {
  readonly anchor: ProductionBundleTrustAnchor;
  readonly files: readonly SnapshotFile[];
  readonly missing: readonly string[];
  readonly rejected: readonly { readonly filename: string; readonly code: string }[];
  /** Descriptors whose bytes were actually requested; attribution never calls an unrequested file "missing". */
  readonly attempted: readonly AnchoredDescriptor[];
  /** False for operational failures (store error, deadline, snapshot rejection): they are not integrity findings. */
  readonly attribute: boolean;
}

/** Synchronous core over PRIVATE copies: owner verification, then local observation. */
function evaluate(acc: Accumulator, input: EvaluateInput): OwnerVerified | null {
  const { anchor, files } = input;
  acc.set("anchor_resolution", "verified_local", null);
  acc.anchor = freeze({ provenance: anchor.provenance, commitmentSha256: anchor.commitmentSha256 });
  const ref = anchor.commitment.bundle_ref;
  acc.inputDigests = digestsOf(files, anchor.commitmentSha256);
  if (input.missing.length > 0 || input.rejected.length > 0) {
    acc.fail("byte_custody", input.missing.length > 0 ? "BYTE_MISSING" : input.rejected[0]!.code);
    if (input.attribute) acc.attribution = attributeFailure(input.attempted, files);
    acc.outputDigests = digestsOf(files, anchor.commitmentSha256);
    return null;
  }
  acc.set("byte_custody", "verified_local", null);
  const owner = ownerVerifyBundle(files, anchor.commitment, anchor.ownerScope);
  if (!owner.ok) {
    acc.ownerCodes = owner.codes.map((code) => code.slice(0, 96));
    acc.fail("owner_integrity", owner.codes[0] ?? "OWNER_FAILED");
    acc.attribution = attributeFailure(anchor.descriptors, files);
    acc.outputDigests = digestsOf(files, anchor.commitmentSha256);
    return null;
  }
  acc.set("owner_integrity", "verified_owner", null);
  acc.bundle = freeze({ hash: ref.content_hash as string, id: ref.id, revision: ref.revision });
  const manifest = owner.value.bundle;
  acc.specRef = freeze({ state: "declared_by_manifest_unverified" as const, contentHash: manifest.spec_ref.content_hash as string });
  const bytesByName = new Map(files.map((file) => [file.filename, file.bytes]));
  const observation = observePrintOutputs(manifest.files, bytesByName);
  acc.set("png_pixels", observation.pixels, observation.pixelsCode);
  acc.set("png_effective_dpi", observation.dpi, observation.dpiCode);
  acc.set("png_phys_metadata", observation.phys, observation.physCode);
  acc.set("pdf_svg_signature", observation.signature, observation.signatureCode);
  for (const reason of observation.reasons) acc.reason(reason);
  const observed = [observation.pixels, observation.dpi, observation.phys, observation.signature];
  if (observed.includes("failed")) acc.set("observed_geometry_consistency", "failed", observation.failures[0] ?? "SIGNATURE_MISMATCH");
  else if (observed.includes("verified_local")) acc.set("observed_geometry_consistency", "verified_local", null);
  else acc.set("observed_geometry_consistency", "not_observed", "NOT_OBSERVED");
  acc.outputDigests = digestsOf(files, anchor.commitmentSha256);
  return owner.value;
}

// ---------------------------------------------------------------------------------------------------------
// 7. Trusted order terms cross-binding (PBR-11, PBR-22)
// ---------------------------------------------------------------------------------------------------------

async function bindTrustedTerms(acc: Accumulator, verified: OwnerVerified, terms: TrustedTermsSource | undefined, request: ProductionBundleGateRequest, context: PortContext): Promise<void> {
  if (terms === undefined) { acc.set("authorization_terms_binding", "blocked", "TERMS_SOURCE_ABSENT"); acc.termsBinding = "source_absent"; return; }
  const outcome = await runWithDeadline(() => terms.resolve({ trustedScope: request.trustedScope, providerId: request.providerId, mode: request.runtimeMode, productionBundleDigest: request.bundleDigest, quote: request.quote }), context.limits.resolveMs, context.signal);
  if (outcome.status !== "ok") { acc.fail("authorization_terms_binding", "TERMS_SOURCE_FAILED"); acc.termsBinding = "source_failed"; return; }
  const result = outcome.value as unknown;
  try {
    if (result === null || typeof result !== "object") throw new TypeError("terms");
    const status = (result as { readonly status?: unknown }).status;
    if (status === "missing") { acc.set("authorization_terms_binding", "blocked", "TERMS_SOURCE_ABSENT"); acc.termsBinding = "source_missing_fields"; return; }
    const bound = result as { readonly status?: unknown; readonly terms?: { readonly design?: { readonly compositionHash?: unknown; readonly factsHash?: unknown }; readonly approvalId?: unknown }; readonly provenance?: { readonly kind?: unknown } };
    if (status !== "bound" || bound.provenance?.kind !== "development_fixture" || bound.terms === undefined || bound.terms === null) throw new TypeError("terms");
    const manifest = verified.bundle;
    const strip = (value: string): string => value.startsWith("sha256:") ? value.slice(7) : value;
    const matches = bound.terms.design?.compositionHash === strip(manifest.composition.composition_hash as string) &&
      bound.terms.design?.factsHash === strip(manifest.composition.facts_hash as string) &&
      bound.terms.approvalId === manifest.approval_ref.id;
    if (matches) { acc.set("authorization_terms_binding", "blocked", "TERMS_BINDING_FIXTURE_ONLY"); acc.termsBinding = "matched_development_fixture"; }
    else { acc.fail("authorization_terms_binding", "TERMS_BINDING_MISMATCH"); acc.termsBinding = "mismatch"; }
  } catch {
    acc.fail("authorization_terms_binding", "TERMS_SOURCE_FAILED");
    acc.termsBinding = "source_failed";
  }
}

// ---------------------------------------------------------------------------------------------------------
// 8. Public synchronous API over caller-supplied bytes
// ---------------------------------------------------------------------------------------------------------

export interface ValidateBytesOptions {
  readonly clock: Clock;
  readonly consumerRevision?: string | null;
}

/**
 * Validates a caller-supplied file list against an ISSUED trust anchor. The files are snapshotted with the native
 * rule first; the owner and the observers only ever see the private copies. A hand-built anchor is rejected.
 */
export function validateProductionBundleBytes(input: { readonly files: unknown }, anchor: ProductionBundleTrustAnchor, options: ValidateBytesOptions): ProductionBundleReport {
  const acc = new Accumulator();
  const revision = options.consumerRevision ?? null;
  if (!isIssuedTrustAnchor(anchor)) {
    acc.fail("anchor_resolution", "ANCHOR_NOT_ISSUED");
    return buildReport(acc, options.clock, revision);
  }
  const byName = new Map(anchor.descriptors.map((descriptor) => [descriptor.filename, descriptor]));
  const limits = ownerLimits();
  // Bounds-before-copy for the pure API (PBR-05): the count, the per-name caps (an unnamed file gets the generic entry cap), the
  // aggregate and the payload group are all checked on intrinsic lengths before a single byte is copied. Unknown names are payload-group
  // members, so an extra file is bounded yet still reaches the owner, which rejects it with its own attribution.
  const snapshot = snapshotProductionBundleFiles(input.files, (filename) => byName.get(filename)?.cap ?? limits.entryBytes, {
    maxCount: limits.outerDescriptors,
    aggregateCap: aggregateCapOf(limits),
    payloadGroupCap: limits.payloadBytes,
    isPayload: (filename) => !SINGLE_FILE_ROLES.has(byName.get(filename)?.role ?? "")
  });
  if (!snapshot.ok) {
    acc.set("anchor_resolution", "verified_local", null);
    acc.anchor = freeze({ provenance: anchor.provenance, commitmentSha256: anchor.commitmentSha256 });
    acc.fail("byte_custody", "SNAPSHOT_REJECTED");
    acc.reason(`SNAPSHOT_${snapshot.reason.toUpperCase()}`);
    return buildReport(acc, options.clock, revision);
  }
  evaluate(acc, { anchor, files: snapshot.files, missing: [], rejected: [], attempted: anchor.descriptors, attribute: true });
  return buildReport(acc, options.clock, revision);
}

// ---------------------------------------------------------------------------------------------------------
// 9. The gate
// ---------------------------------------------------------------------------------------------------------

export interface CreateProductionBundleGateOptions {
  readonly publication: ProductionBundlePublicationSource;
  readonly bytes: ProductionBundleByteSource;
  /** Optional trusted order terms source (the same kind PR #40 uses). Absent => critical blocked TERMS_SOURCE_ABSENT. */
  readonly terms?: TrustedTermsSource;
  readonly clock: Clock;
  readonly consumerRevision?: string | null;
  /** Resource bounds only. There is deliberately no criteria, severity, mode or policy option. */
  readonly limits?: ProductionBundleGateLimits;
}

function envelopeReferenceDigest(value: unknown): string | null {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value) || getPrototypeOf(value) !== ObjectPrototype) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 5) return null;
    const contract = dataValue(value, "contract"), schema = dataValue(value, "schema_version"), id = dataValue(value, "id"), revision = dataValue(value, "revision"), hash = dataValue(value, "content_hash");
    if (contract === null || schema === null || id === null || revision === null || hash === null) return null;
    if (contract.value !== "ProductionBundle" || schema.value !== "2.0.0" || typeof hash.value !== "string") return null;
    return hash.value;
  } catch {
    return null;
  }
}

/** The only constructor of a gate the runtime accepts: returns a frozen, branded object. */
export function createProductionBundleGate(options: CreateProductionBundleGateOptions): ProductionBundleGate {
  const limits = resolveLimits(options.limits);
  const revision = options.consumerRevision ?? null;
  if (revision !== null && !/^[0-9a-f]{7,64}$/.test(revision)) throw new TypeError("consumerRevision must be a lowercase hex git revision or null");
  const semaphore = new BoundedSemaphore(limits.maxConcurrent, limits.maxQueued);
  const publication = options.publication;
  const bytes = options.bytes;
  const terms = options.terms;
  const clock = options.clock;

  async function run(request: ProductionBundleGateRequest): Promise<ProductionBundleReport> {
    const acc = new Accumulator();
    const total = new AbortController();
    const totalTimer = realSetTimeout(() => total.abort(), limits.totalMs);
    let release: (() => void) | undefined;
    try {
      if (request.runtimeMode !== "simulated" || request.transportMode !== "simulated") { acc.fail("anchor_resolution", "MODE_NOT_SIMULATED"); return buildReport(acc, clock, revision); }
      const scope = request.trustedScope;
      if (scope === null || typeof scope !== "object" || typeof scope.tenantId !== "string" || scope.tenantId === "" || typeof scope.projectId !== "string" || scope.projectId === "") { acc.fail("anchor_resolution", "SCOPE_INVALID"); return buildReport(acc, clock, revision); }
      if (!isSha256Digest(request.bundleDigest)) { acc.fail("anchor_resolution", "BUNDLE_DIGEST_INVALID"); return buildReport(acc, clock, revision); }
      const envelopeDigest = envelopeReferenceDigest(request.envelopeBundle);
      if (envelopeDigest !== null && envelopeDigest !== request.bundleDigest) { acc.fail("anchor_resolution", "ENVELOPE_REFERENCE_MISMATCH"); return buildReport(acc, clock, revision); }

      const slot = await semaphore.acquire(limits.totalMs, total.signal);
      if (slot.status !== "acquired") { acc.fail("anchor_resolution", slot.status === "queue_full" ? "RESOURCE_LIMIT" : slot.status === "timeout" ? "DEADLINE" : "ABORTED"); return buildReport(acc, clock, revision); }
      release = slot.release;
      const context: PortContext = { limits, signal: total.signal };

      const resolved = await resolveTrustAnchor({ trustedScope: freeze({ tenantId: scope.tenantId, projectId: scope.projectId }), bundleDigest: request.bundleDigest }, { publication, bytes }, context);
      if (!resolved.ok) {
        acc.fail("anchor_resolution", resolved.codes[0] ?? "ANCHOR_FAILED");
        for (const code of resolved.codes) acc.reason(code);
        if (resolved.commitmentSha256 !== undefined && resolved.provenance !== undefined) acc.anchor = freeze({ provenance: resolved.provenance, commitmentSha256: resolved.commitmentSha256 });
        return buildReport(acc, clock, revision);
      }
      const anchor = resolved.anchor;
      const files: SnapshotFile[] = [];
      const missing: string[] = [];
      const rejectedFiles: { filename: string; code: string }[] = [];
      const attempted: AnchoredDescriptor[] = [];
      for (const descriptor of anchor.descriptors) {
        attempted.push(descriptor);
        const read = await runWithDeadline<ByteReadResult>((signal) => bytes.read({ trustedScope: anchor.trustedScope, role: "file", filename: descriptor.filename, byteHash: descriptor.byteHash, maxLength: descriptor.byteSize, signal }), limits.readMs, total.signal);
        if (read.status !== "ok") { rejectedFiles.push({ filename: descriptor.filename, code: read.status === "failed" ? "BYTE_SOURCE_FAILED" : read.status === "deadline" ? "DEADLINE" : "ABORTED" }); break; }
        const copy = snapshotByteSourceResult(read.value, descriptor.cap);
        if (!copy.ok) { rejectedFiles.push({ filename: descriptor.filename, code: "SNAPSHOT_REJECTED" }); acc.reason(`SNAPSHOT_${String(copy.reason).toUpperCase()}`); break; }
        if (copy.missing) { missing.push(descriptor.filename); continue; }
        if (copy.bytes.length !== descriptor.byteSize) { rejectedFiles.push({ filename: descriptor.filename, code: "BYTE_LENGTH_MISMATCH" }); files.push(freeze({ filename: descriptor.filename, bytes: copy.bytes })); break; }
        files.push(freeze({ filename: descriptor.filename, bytes: copy.bytes }));
      }
      const operational = rejectedFiles.length > 0 && rejectedFiles[0]!.code !== "BYTE_LENGTH_MISMATCH";
      const verified = evaluate(acc, { anchor, files, missing, rejected: rejectedFiles, attempted, attribute: !operational });
      if (verified !== null) await bindTrustedTerms(acc, verified, terms, request, context);
      return buildReport(acc, clock, revision);
    } catch {
      acc.fail("anchor_resolution", "GATE_INTERNAL");
      return buildReport(acc, clock, revision);
    } finally {
      realClearTimeout(totalTimer);
      total.abort();
      if (release !== undefined) release();
    }
  }

  const gate: ProductionBundleGate = {
    kind: PRODUCTION_BUNDLE_GATE_KIND,
    checkBeforeSubmit: (request) => run(request),
    recheckBeforeDispatch: (request) => run(request)
  };
  return sealGenuineProductionBundleGate(gate);
}

/** Convenience for tests and verifiers: a plain digest of bytes, using the same encoding as the report. */
export const productionBundleSha256 = (bytes: Uint8Array): string => sha256Digest(bytes);
