/** Development-only canonical projection. Not imported by the runtime/package root. */
import { types } from "node:util";
import { checkTrustedContext } from "@jevelopers/shared-contracts";
import {
  adaptFulfillmentCatalogV1,
  checkFulfillmentCapabilitySnapshot,
  type CapabilityContext,
  type FulfillmentCapabilitySnapshot
} from "@jevelopers/shared-contracts/capability";
import { captureCatalogSnapshot, type CatalogSnapshot, type CatalogSource } from "./catalog.js";

export type CapabilityCaptureResult =
  | { readonly ok: true; readonly privateSnapshot: CatalogSnapshot;
      readonly canonicalSnapshot: FulfillmentCapabilitySnapshot; readonly eligibility: "not_established" }
  | { readonly ok: false; readonly code: "invalid_context" | "capture_failed" | "canonical_rejected" };

// Context is independently supplied by the host, never read from catalog metadata.
// Copy own primitive data before awaiting source I/O; getters and proxies cannot confer scope.
function ownFields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value)) throw new Error();
  if (Reflect.ownKeys(value).length !== keys.length) throw new Error();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error();
    result[key] = descriptor.value;
  }
  return result;
}

function ownedContext(value: unknown): CapabilityContext {
  const context = ownFields(value, ["trusted_scope", "now"]);
  const scope = ownFields(context.trusted_scope, ["tenant_id", "project_id"]);
  if (typeof scope.tenant_id !== "string" || typeof scope.project_id !== "string") throw new Error();
  const trusted_scope = Object.freeze(scope) as CapabilityContext["trusted_scope"];
  if (!checkTrustedContext(trusted_scope, trusted_scope).ok) throw new Error();
  if (typeof context.now !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(context.now)) throw new Error();
  const epoch = Date.parse(context.now);
  if (!Number.isSafeInteger(epoch) || new Date(epoch).toISOString() !== context.now) throw new Error();
  return Object.freeze({ trusted_scope, now: context.now });
}

/** One read, one owned raw capture, two separately identified projections. No quote/submit/authority port. */
export async function discoverDevelopmentCapability(
  source: CatalogSource,
  context: CapabilityContext
): Promise<CapabilityCaptureResult> {
  let trusted: CapabilityContext;
  try { trusted = ownedContext(context); }
  catch { return Object.freeze({ ok: false, code: "invalid_context" }); }

  let capture: Awaited<ReturnType<typeof captureCatalogSnapshot>>;
  try { capture = await captureCatalogSnapshot(source); }
  catch { return Object.freeze({ ok: false, code: "capture_failed" }); }

  try {
    const mapped = adaptFulfillmentCatalogV1(capture.input, trusted);
    if (!mapped.ok) return Object.freeze({ ok: false, code: "canonical_rejected" });
    const checked = checkFulfillmentCapabilitySnapshot(mapped.value, trusted);
    if (!checked.ok) return Object.freeze({ ok: false, code: "canonical_rejected" });
    return Object.freeze({ ok: true, privateSnapshot: capture.snapshot,
      canonicalSnapshot: checked.value, eligibility: "not_established" });
  } catch {
    // Owner exceptions/raw source errors are never published as diagnostics.
    return Object.freeze({ ok: false, code: "canonical_rejected" });
  }
}
