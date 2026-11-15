import type { AppSettings, BackupData, Category, Goal, Occurrence, RoutinePlan } from "@/lib/types";

const DB_NAME = "routine-os-local";
const DB_VERSION = 1;

type StoreName = "categories" | "plans" | "occurrences" | "goals" | "settings";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (typeof window === "undefined") return Promise.reject(new Error("IndexedDB is only available in the browser."));
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("categories")) db.createObjectStore("categories", { keyPath: "id" });
      if (!db.objectStoreNames.contains("plans")) db.createObjectStore("plans", { keyPath: "id" });
      if (!db.objectStoreNames.contains("occurrences")) {
        const store = db.createObjectStore("occurrences", { keyPath: "id" });
        store.createIndex("by-date", "date", { unique: false });
        store.createIndex("by-plan", "planId", { unique: false });
      }
      if (!db.objectStoreNames.contains("goals")) db.createObjectStore("goals", { keyPath: "id" });
      if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open local database."));
    request.onblocked = () => reject(new Error("Database upgrade is blocked by another open tab."));
  });
  return dbPromise;
}

async function requestResult<T>(storeName: StoreName, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDB();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const request = run(transaction.objectStore(storeName));
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => reject(request.error ?? new Error("Database request failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Database transaction aborted."));
  });
}

export const getAll = <T>(store: StoreName) => requestResult<T[]>(store, "readonly", (s) => s.getAll());
export const put = <T extends { id: string }>(store: Exclude<StoreName, "settings">, value: T) => requestResult<IDBValidKey>(store, "readwrite", (s) => s.put(value));
export const remove = (store: Exclude<StoreName, "settings">, id: string) => requestResult<undefined>(store, "readwrite", (s) => s.delete(id));

export async function getSettings(): Promise<AppSettings | null> {
  const value = await requestResult<{ key: string; value: AppSettings } | undefined>("settings", "readonly", (s) => s.get("app"));
  return value?.value ?? null;
}

export async function saveSettings(value: AppSettings): Promise<void> {
  await requestResult<IDBValidKey>("settings", "readwrite", (s) => s.put({ key: "app", value }));
}

export async function saveBackup(data: BackupData): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["categories", "plans", "occurrences", "goals", "settings"], "readwrite");
    const stores = {
      categories: tx.objectStore("categories"),
      plans: tx.objectStore("plans"),
      occurrences: tx.objectStore("occurrences"),
      goals: tx.objectStore("goals"),
      settings: tx.objectStore("settings"),
    };
    Object.values(stores).forEach((store) => store.clear());
    data.categories.forEach((value) => stores.categories.put(value));
    data.plans.forEach((value) => stores.plans.put(value));
    data.occurrences.forEach((value) => stores.occurrences.put(value));
    data.goals.forEach((value) => stores.goals.put(value));
    stores.settings.put({ key: "app", value: data.settings });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Could not restore backup."));
    tx.onabort = () => reject(tx.error ?? new Error("Backup restore aborted."));
  });
}

export async function getAllData(settings: AppSettings): Promise<BackupData> {
  const [categories, plans, occurrences, goals] = await Promise.all([
    getAll<Category>("categories"),
    getAll<RoutinePlan>("plans"),
    getAll<Occurrence>("occurrences"),
    getAll<Goal>("goals"),
  ]);
  // Push message IDs belong to a single device/subscription and must never be restored on another device.
  const portableOccurrences = occurrences.map(({ reminderMessageId, reminderScheduledAt, reminderSubscriptionEndpoint, ...item }) => item);
  return { version: 1, exportedAt: new Date().toISOString(), categories, plans, occurrences: portableOccurrences, goals, settings };
}

export async function clearAllData(): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["categories", "plans", "occurrences", "goals", "settings"], "readwrite");
    ["categories", "plans", "occurrences", "goals", "settings"].forEach((name) => tx.objectStore(name).clear());
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Could not clear database."));
  });
}
