/** Private single-host development persistence. No canonical payload or financial authority. */
import { DatabaseSync } from "node:sqlite";
import { lstatSync, openSync, closeSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { types } from "node:util";
import { validatePrivateQuoteSnapshot, type PrivateQuoteSnapshot, type QuoteSnapshotPersistence } from "./quotes.js";
import type { TrustedScope } from "./types.js";

const MAX_QUOTE_BYTES = 512 * 1024;
export class QuoteStoreError extends Error {
  readonly code = "quote_store_unavailable";
  constructor() { super("The private quote store could not safely complete the operation."); this.name = "QuoteStoreError"; }
}

export interface LocalQuoteStore extends QuoteSnapshotPersistence {
  get(quoteId: string, trustedScope: TrustedScope): Promise<PrivateQuoteSnapshot | undefined>;
  close(): void;
}

function scopeCopy(value: TrustedScope): TrustedScope {
  if (!value || typeof value !== "object" || types.isProxy(value)) throw new QuoteStoreError();
  const fields: string[] = [];
  for (const key of ["tenantId", "projectId"]) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !("value" in d) || typeof d.value !== "string" || !d.value.trim() || d.value.length > 128) throw new QuoteStoreError();
    fields.push(d.value);
  }
  return Object.freeze({ tenantId: fields[0]!, projectId: fields[1]! });
}

function validId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^quote:sha256:[a-f0-9]{64}$/.test(value)) throw new QuoteStoreError();
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

/**
 * The host provisions an exclusive directory (0700, current uid, no symlink path).
 * SQLite FULL synchronous transactions retain immutable snapshots across restart.
 * This is not encrypted, shared production storage, retention automation or accepted quote mapping.
 */
export function createLocalQuoteStore(directory: string): LocalQuoteStore {
  let db: DatabaseSync | undefined;
  try {
    const root = resolve(directory);
    const info = lstatSync(root);
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(root) !== root ||
        (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) throw new QuoteStoreError();
    const filename = join(root, "quotes.sqlite");
    try { closeSync(openSync(filename, "wx", 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const file = lstatSync(filename);
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || (file.mode & 0o077) !== 0 || file.uid !== info.uid) throw new QuoteStoreError();
    db = new DatabaseSync(filename, { timeout: 1_000 });
    db.exec("PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE;");
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    if (version === 0) {
      // New databases only: never interpret an unrelated pre-existing schema as a migration.
      if (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length !== 0) throw new QuoteStoreError();
      db.exec("BEGIN IMMEDIATE; CREATE TABLE quotes (tenant TEXT NOT NULL, project TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (tenant, project, id)); PRAGMA user_version=1; COMMIT;");
    } else if (version !== 1) throw new QuoteStoreError();
    const database = db;
    const size = database.prepare("SELECT length(CAST(payload AS BLOB)) AS bytes FROM quotes WHERE tenant=? AND project=? AND id=?");
    const select = database.prepare("SELECT payload FROM quotes WHERE tenant=? AND project=? AND id=?");
    const insert = database.prepare("INSERT INTO quotes (tenant,project,id,payload) VALUES (?,?,?,?) ON CONFLICT (tenant,project,id) DO NOTHING");
    let closed = false;
    const get = async (quoteId: string, trustedScope: TrustedScope): Promise<PrivateQuoteSnapshot | undefined> => {
      try {
        if (closed) throw new QuoteStoreError();
        const scope = scopeCopy(trustedScope); validId(quoteId);
        const storedSize = size.get(scope.tenantId, scope.projectId, quoteId);
        if (!storedSize) return undefined;
        if (typeof storedSize.bytes !== "number" || storedSize.bytes > MAX_QUOTE_BYTES) throw new QuoteStoreError();
        const row = select.get(scope.tenantId, scope.projectId, quoteId);
        if (!row) return undefined;
        if (typeof row.payload !== "string" || Buffer.byteLength(row.payload) > MAX_QUOTE_BYTES) throw new QuoteStoreError();
        const quote = await validatePrivateQuoteSnapshot(JSON.parse(row.payload));
        if (quote.quoteId !== quoteId || quote.binding.tenantId !== scope.tenantId || quote.binding.projectId !== scope.projectId) throw new QuoteStoreError();
        return freeze(quote);
      } catch { throw new QuoteStoreError(); }
    };
    return Object.freeze({
      async save(value: PrivateQuoteSnapshot, trustedScope: TrustedScope): Promise<void> {
        try {
          if (closed) throw new QuoteStoreError();
          const scope = scopeCopy(trustedScope);
          const quote = await validatePrivateQuoteSnapshot(value);
          if (quote.binding.tenantId !== scope.tenantId || quote.binding.projectId !== scope.projectId) throw new QuoteStoreError();
          const payload = JSON.stringify(quote);
          if (Buffer.byteLength(payload) > MAX_QUOTE_BYTES || closed) throw new QuoteStoreError();
          insert.run(scope.tenantId, scope.projectId, quote.quoteId, payload);
          // Existing rows must also pass integrity verification; never overwrite a corrupt record.
          if (!(await get(quote.quoteId, scope))) throw new QuoteStoreError();
        } catch { throw new QuoteStoreError(); }
      },
      get,
      close() { if (!closed) { database.close(); closed = true; } }
    });
  } catch {
    try { db?.close(); } catch { /* Do not expose native SQLite diagnostics. */ }
    throw new QuoteStoreError();
  }
}
