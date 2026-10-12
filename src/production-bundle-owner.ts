/**
 * The ONLY module that imports `@jevelopers/shared-contracts`. It wraps the exact owner 0.9.7 byte-verification
 * API without redefining any owner schema, canonical form, hash, ZIP rule or verdict:
 *
 * - `verifyProductionBundleFiles` is the sole authority for inventory, canonical manifest, detached protocol,
 *   ZIP and payload-set verification, and it can never return an eligible state.
 * - `validateProductionResult("exportArtifactBundle", ...)` structurally pre-validates the trusted outer
 *   `ProductionBundleRef` before this consumer derives any resource bounds from it. It does not check scope.
 * - `productionArchiveLimits` is read from the owner at call time; no limit is copied into this repository.
 *
 * The owner eligibility, approval, authority, host-approval and preflight functions are deliberately not
 * imported: the owner has no fulfillment audience, and a consumer-built context would impersonate one.
 * Every owner call is wrapped because the owner throws on hostile inputs (proxies, throwing getters).
 */
import {
  productionArchiveLimits,
  safeProductionFilename,
  validateProductionResult,
  verifyProductionBundleFiles,
  type ProductionBundleRef,
  type ProductionObservedFile,
  type ProductionScope
} from "@jevelopers/shared-contracts/production-operations";

export type OwnerBundleRef = ProductionBundleRef;
export type OwnerObservedFile = ProductionObservedFile;
export type OwnerScope = ProductionScope;
export type OwnerVerified = Extract<ReturnType<typeof verifyProductionBundleFiles>, { readonly ok: true }>["value"];

export type OwnerOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly codes: readonly string[] };

export interface OwnerLimits {
  readonly outerDescriptors: number;
  readonly entryBytes: number;
  readonly archiveBytes: number;
  readonly manifestBytes: number;
  readonly detachedBytes: number;
  readonly payloadBytes: number;
}

/** Read from the owner export at call time. Nothing is copied into this repository. */
export function ownerLimits(): OwnerLimits {
  return Object.freeze({
    outerDescriptors: productionArchiveLimits.outer_descriptors,
    entryBytes: productionArchiveLimits.entry_bytes,
    archiveBytes: productionArchiveLimits.archive_bytes,
    manifestBytes: productionArchiveLimits.manifest_bytes,
    detachedBytes: productionArchiveLimits.detached_bytes,
    payloadBytes: productionArchiveLimits.payload_bytes
  });
}

/**
 * Explicit, unit-tested mapping from the runtime's camelCase scope to the owner's snake_case scope.
 * The owner brands the identifiers; its verifier rejects malformed values with a typed code, so this boundary
 * cast cannot admit an invalid scope.
 */
export function toOwnerScope(scope: { readonly tenantId: string; readonly projectId: string }): OwnerScope {
  return { tenant_id: scope.tenantId, project_id: scope.projectId } as unknown as OwnerScope;
}

/** The owner's own filename rule, used before a name is handed to a host port. */
export function ownerSafeFilename(name: string): boolean {
  try {
    return safeProductionFilename(name);
  } catch {
    return false;
  }
}

function codesOf(errors: readonly { readonly code: string }[]): readonly string[] {
  return Object.freeze(errors.map((error) => error.code));
}

/** Structural owner pre-validation of the trusted commitment. Scope is NOT checked here (verified by probe). */
export function ownerPreValidateCommitment(candidate: unknown, scope: OwnerScope): OwnerOutcome<OwnerBundleRef> {
  try {
    const result = validateProductionResult("exportArtifactBundle", { ok: true, value: candidate }, scope);
    if (!result.ok) return { ok: false, codes: codesOf(result.errors) };
    const inner = result.value;
    if (!inner.ok) return { ok: false, codes: ["OWNER_UNEXPECTED_RESULT"] };
    return { ok: true, value: inner.value as OwnerBundleRef };
  } catch {
    return { ok: false, codes: ["OWNER_THREW"] };
  }
}

/** The single authoritative byte verification. Success is always `integrity: passed`, `eligibility: blocked`. */
export function ownerVerifyBundle(
  files: readonly OwnerObservedFile[],
  commitment: OwnerBundleRef,
  scope: OwnerScope
): OwnerOutcome<OwnerVerified> {
  try {
    const result = verifyProductionBundleFiles(files, { trusted_commitment: commitment, scope });
    if (!result.ok) return { ok: false, codes: codesOf(result.errors) };
    return { ok: true, value: result.value };
  } catch {
    return { ok: false, codes: ["OWNER_THREW"] };
  }
}
