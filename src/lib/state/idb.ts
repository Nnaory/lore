/**
 * IndexedDB — a minimal promise wrapper (browser only)
 *
 * One database, "lore", with two object stores keyed by `id`:
 *   projects  → full Project objects
 *   summaries → ProjectSummary for the home page list
 *
 * `transact` runs a unit of work in ONE transaction and resolves only when
 * it commits, so writes to both stores land together or not at all. Work is
 * written with request callbacks (not awaits) so the transaction stays
 * active between a read and the write that depends on it.
 */

export const DB_NAME = "lore";
const DB_VERSION = 1;
export const PROJECTS = "projects";
export const SUMMARIES = "summaries";

let dbPromise: Promise<IDBDatabase> | null = null;

/** False on the server, in old browsers, and where storage is disabled. */
export function indexedDbAvailable(): boolean {
  try {
    return typeof indexedDB !== "undefined" && indexedDB !== null;
  } catch {
    return false;
  }
}

function openDatabase(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of [PROJECTS, SUMMARIES]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "id" });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // Another tab upgrading the schema: let it, and reopen next time.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      dbPromise = null;
      reject(request.error);
    };
  });
  return dbPromise;
}

/**
 * Run `work` in one transaction. `work` receives the transaction and a
 * `setResult` callback; the promise resolves with that result once the
 * transaction commits, and rejects if it aborts (e.g. QuotaExceededError).
 */
export async function transact<T>(
  stores: string[],
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction, setResult: (value: T) => void) => void
): Promise<T> {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    let result: T | undefined;
    const tx = db.transaction(stores, mode);
    tx.oncomplete = () => resolve(result as T);
    tx.onabort = () => reject(tx.error ?? new DOMException("Transaction aborted", "AbortError"));
    try {
      work(tx, (value) => {
        result = value;
      });
    } catch (err) {
      try {
        tx.abort();
      } catch {
        // already finished
      }
      reject(err);
    }
  });
}

/** Close and forget the connection (tests swap in a fresh database). */
export async function resetDatabaseConnection(): Promise<void> {
  const pending = dbPromise;
  dbPromise = null;
  if (pending) (await pending.catch(() => null))?.close();
}
