// Durable store — survive a restart without rewriting every call site.
//
// THE PROBLEM. The store is a plain object on `globalThis`, mutated directly
// from ~40 places: `store.agents.unshift(a)`, `record.status = "Approved"`,
// `store.audit.unshift(evt)`. Every restart wiped it. That cost real work
// twice in one session — a set of hand-built agents, and then the demo data
// again when an env var needed a restart.
//
// WHY NOT A DATABASE. Converting those call sites to async queries is a large,
// risky change to code that currently cannot fail. The state is small
// (kilobytes), single-process, and read far more than written. A file is the
// right size of answer.
//
// WHY A PROXY, NOT `persist()` CALLS. An explicit save at every mutation is
// ~40 chances to forget one, and the failure is silent: the console looks
// right until a restart loses exactly the records nobody saved. A deep Proxy
// marks the state dirty on ANY write — including in-place field edits like
// `peer.status = next` — so persistence cannot be forgotten, and no existing
// line changes.
//
// WHAT THIS DELIBERATELY IS NOT: not multi-process safe, not transactional,
// not a migration system. Two app instances sharing one file would clobber
// each other, and that is called out rather than guarded against, because
// pretending otherwise is worse than the limitation.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Env var pointing at the snapshot file. */
export const STORE_PATH_VAR = "CONTROL_PLANE_STORE_PATH";

/**
 * Bump when the Store shape changes in a way an old snapshot cannot satisfy.
 *
 * A mismatched snapshot is DISCARDED, loudly, and the seed runs instead. The
 * alternative — merging an old shape into a new one — produces a store that is
 * half-migrated and looks fine, which is the worst of the three outcomes.
 */
export const SCHEMA_VERSION = 1;

export function storePath(): string {
  const configured = (process.env[STORE_PATH_VAR] || "").trim();
  return configured || join(process.cwd(), ".data", "control-plane.json");
}

interface Snapshot<T> {
  schemaVersion: number;
  savedAt: string;
  state: T;
}

export interface LoadResult<T> {
  state: T | null;
  /** Why there is no state, when there is none. Always safe to log. */
  reason: string;
}

/**
 * Read a snapshot, or explain why we are seeding instead.
 *
 * Every failure path returns null rather than throwing: a corrupt or
 * unreadable snapshot must not stop the platform from booting. It must,
 * however, SAY SO — a silent fallback to seed data looks identical to a fresh
 * install, and that is how someone concludes their data was never saved.
 */
export function loadSnapshot<T>(path = storePath()): LoadResult<T> {
  if (!existsSync(path)) {
    return { state: null, reason: `no snapshot at ${path}; seeding` };
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    return { state: null, reason: `snapshot unreadable (${(e as Error).message}); seeding` };
  }
  let parsed: Snapshot<T>;
  try {
    parsed = JSON.parse(raw) as Snapshot<T>;
  } catch (e) {
    return {
      state: null,
      reason:
        `snapshot at ${path} is not valid JSON (${(e as Error).message}); ` +
        `seeding. The file is left in place for inspection`,
    };
  }
  if (parsed?.schemaVersion !== SCHEMA_VERSION) {
    return {
      state: null,
      reason:
        `snapshot schema is v${parsed?.schemaVersion}, this build expects ` +
        `v${SCHEMA_VERSION}; seeding rather than half-migrating`,
    };
  }
  if (!parsed.state || typeof parsed.state !== "object") {
    return { state: null, reason: "snapshot has no state object; seeding" };
  }
  return { state: parsed.state, reason: `restored from ${path} (saved ${parsed.savedAt})` };
}

/**
 * Write the snapshot ATOMICALLY: temp file, then rename.
 *
 * `rename` within a filesystem is atomic, so a reader sees either the old
 * snapshot or the new one. Writing in place would leave a truncated file if
 * the process died mid-write, and a corrupt snapshot is worse than a stale
 * one — it discards everything rather than the last few seconds.
 */
export function writeSnapshot<T>(state: T, path = storePath()): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const body: Snapshot<T> = {
    schemaVersion: SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    state,
  };
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(body, null, 2), "utf8");
  renameSync(tmp, path);
}

// --------------------------------------------------------------------------- //
// Change tracking
// --------------------------------------------------------------------------- //

/**
 * Array methods that mutate. Calling one has to mark dirty even though the
 * `set` trap also fires for the index writes it performs — `pop()` on an empty
 * array, for instance, writes nothing but still changes `length` semantics.
 */
const MUTATING_ARRAY_METHODS = new Set([
  "push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin",
]);

/**
 * Wrap `target` so any nested mutation calls `onChange`.
 *
 * Proxies are CACHED PER TARGET in a WeakMap. Without that, two reads of
 * `store.agents[0]` would return two different Proxy objects and `===` between
 * them would be false — quietly breaking any identity comparison, `indexOf`,
 * or `splice(arr.indexOf(x), 1)` in code that has every right to expect plain
 * objects.
 */
export function trackChanges<T extends object>(target: T, onChange: () => void): T {
  const cache = new WeakMap<object, unknown>();

  const wrap = (value: unknown): unknown => {
    if (value === null || typeof value !== "object") return value;
    // EXOTIC OBJECTS ARE LEFT ALONE, and this is not just an optimisation.
    //
    // These traps run methods with `this = receiver` (the proxy), which is
    // required so array methods see proxied elements. But Map and Set methods
    // read an internal slot, so `map.get(k)` through a proxy throws
    // "Method Map.prototype.get called on incompatible receiver". Verified.
    //
    // The cost of skipping them is that mutations INSIDE a Map are invisible
    // here, so a store built on Maps must mark itself dirty explicitly — see
    // LocalGraphControlStore. Dates and RegExps have the same slot problem and
    // are immutable in practice.
    if (
      value instanceof Date ||
      value instanceof RegExp ||
      value instanceof Map ||
      value instanceof Set
    ) {
      return value;
    }
    const existing = cache.get(value as object);
    if (existing) return existing;

    const proxy = new Proxy(value as object, {
      get(obj, prop, receiver) {
        const got = Reflect.get(obj, prop, receiver);
        if (typeof got === "function") {
          const fn = got as (...a: unknown[]) => unknown;
          const mutates =
            Array.isArray(obj) &&
            typeof prop === "string" &&
            MUTATING_ARRAY_METHODS.has(prop);
          // METHODS RUN AGAINST THE PROXY, not the raw object.
          //
          // Binding to the raw object was a real bug, and a quiet one. A
          // method reading elements off the raw array returns RAW elements, so
          // `peers.find(...)` handed back an unproxied object and mutating it
          // marked nothing dirty — the change simply never persisted. Worse,
          // `indexOf(someProxy)` compared a proxy against raw elements,
          // returned -1, and `splice(-1, 1)` then deleted the LAST row instead
          // of the intended one.
          //
          // Running with `this = receiver` costs trap re-entry per element
          // access. For a kilobyte-scale store that is irrelevant next to
          // being correct.
          return (...args: unknown[]) => {
            const result = fn.apply(receiver, args);
            // `pop()` on an empty array writes no index, so the `set` trap
            // never fires; the explicit mark covers it.
            if (mutates) onChange();
            return result;
          };
        }
        return wrap(got);
      },
      set(obj, prop, value, receiver) {
        const had = Reflect.has(obj, prop);
        const before = had ? Reflect.get(obj, prop, receiver) : undefined;
        const ok = Reflect.set(obj, prop, value, receiver);
        // `length` changes as a side effect of the array methods above, which
        // already marked dirty; comparing avoids a second flush per push.
        if (ok && (!had || before !== value)) onChange();
        return ok;
      },
      deleteProperty(obj, prop) {
        const ok = Reflect.deleteProperty(obj, prop);
        if (ok) onChange();
        return ok;
      },
    });
    cache.set(value as object, proxy);
    return proxy;
  };

  return wrap(target) as T;
}

// --------------------------------------------------------------------------- //
// The persister
// --------------------------------------------------------------------------- //

export interface PersisterOptions<T extends object> {
  /** The live state. Read at flush time, so later mutations are included. */
  getState: () => T;
  path?: string;
  /**
   * Coalescing window. A workflow run mutates the store many times in a
   * second; one write per mutation would be pure waste.
   */
  debounceMs?: number;
  /** Called with a one-line description of each flush or failure. */
  onEvent?: (message: string) => void;
}

export interface Persister {
  markDirty: () => void;
  /** Write now if dirty. Used on shutdown and by tests. */
  flush: () => void;
  /** Writes performed, for diagnostics and tests. */
  stats: () => { writes: number; failures: number; dirty: boolean };
}

export function createPersister<T extends object>(
  opts: PersisterOptions<T>
): Persister {
  const path = opts.path ?? storePath();
  const debounceMs = opts.debounceMs ?? 400;
  let dirty = false;
  let timer: NodeJS.Timeout | null = null;
  let writes = 0;
  let failures = 0;

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!dirty) return;
    // Cleared BEFORE the write, so a mutation arriving during it marks dirty
    // again and gets its own flush. Clearing afterwards would drop that write.
    dirty = false;
    try {
      writeSnapshot(opts.getState(), path);
      writes += 1;
    } catch (e) {
      failures += 1;
      dirty = true; // keep trying
      // A failed write must never take the request down with it: the
      // in-memory store is still correct, only its durability is lost.
      opts.onEvent?.(`snapshot write FAILED (${(e as Error).message})`);
    }
  };

  const markDirty = () => {
    dirty = true;
    if (timer) return;
    timer = setTimeout(flush, debounceMs);
    // Do not hold the event loop open for a pending snapshot.
    timer.unref?.();
  };

  return { markDirty, flush, stats: () => ({ writes, failures, dirty }) };
}

/**
 * Flush on the way out, so the last few hundred milliseconds are not lost.
 *
 * `unref()` on the debounce timer means a pending write would otherwise be
 * abandoned at exit — which is correct for keeping the process alive but wrong
 * for durability, hence this.
 */
export function flushOnExit(persister: Persister, onEvent?: (m: string) => void): void {
  let done = false;
  const once = (signal: string) => () => {
    if (done) return;
    done = true;
    persister.flush();
    onEvent?.(`flushed snapshot on ${signal}`);
    if (signal !== "beforeExit") process.exit(0);
  };
  process.once("beforeExit", once("beforeExit"));
  process.once("SIGTERM", once("SIGTERM"));
  process.once("SIGINT", once("SIGINT"));
}

/** Cap a log array in place, returning how many entries were dropped. */
export function capLog<T>(items: T[], max: number): number {
  if (items.length <= max) return 0;
  const dropped = items.length - max;
  // The array is newest-first, so the tail is the oldest.
  items.splice(max, dropped);
  return dropped;
}

// --------------------------------------------------------------------------- //
// Durable singletons
// --------------------------------------------------------------------------- //

export interface DurableSingletonOptions<T extends object, W extends object = T> {
  /** Key on globalThis, so the value survives `next dev` hot-reloads. */
  cacheKey: string;
  /** Appended to the base snapshot path, e.g. ".graph" -> store.graph.json. */
  fileSuffix: string;
  seed: () => T;
  /** Short name for log lines. */
  label: string;
  /**
   * Convert to and from a JSON-safe shape. REQUIRED for any state holding a
   * Map or a Set: `JSON.stringify(new Map([["a",1]]))` is `{}`, so without
   * these the snapshot silently loses everything. Verified, not assumed.
   */
  toJSON?: (state: T) => W;
  fromJSON?: (raw: W) => T | null;
  /**
   * False for state whose mutations cannot be observed by a Proxy (Maps), so
   * the owner calls `markDirty` itself.
   */
  track?: boolean;
}

export interface DurableSingleton<T> {
  state: T;
  markDirty: () => void;
  flush: () => void;
  stats: () => { writes: number; failures: number; dirty: boolean };
  path: string;
  bootNote: string;
}

/**
 * Boot one durable singleton: restore, else seed; then persist on change.
 *
 * Each singleton gets its OWN file rather than sharing one. They already have
 * independent lifecycles and seeds, and a shared file would mean a write to
 * any of them rewrites all of them — plus one corrupt section would discard
 * four stores instead of one.
 */
export function durableSingleton<T extends object, W extends object = T>(
  opts: DurableSingletonOptions<T, W>
): DurableSingleton<T> {
  const g = globalThis as unknown as Record<string, unknown>;
  const path = storePath().replace(/\.json$/, "") + `${opts.fileSuffix}.json`;
  const persisterKey = `${opts.cacheKey}__persister`;

  let bootNote = "";
  if (!g[opts.cacheKey]) {
    const loaded = loadSnapshot<W>(path);
    let restored: T | null = null;
    if (loaded.state !== null) {
      try {
        restored = opts.fromJSON
          ? opts.fromJSON(loaded.state)
          : (loaded.state as unknown as T);
      } catch (e) {
        // A snapshot that parses but cannot be rebuilt into the live shape is
        // as untrustworthy as a corrupt one. Seed, and say so.
        restored = null;
        bootNote = `${opts.label}: snapshot could not be rebuilt ` +
          `(${(e as Error).message}); seeding`;
      }
    }
    g[opts.cacheKey] = restored ?? opts.seed();
    if (!bootNote) {
      bootNote = restored ? `${opts.label}: ${loaded.reason}` : `${opts.label}: ${loaded.reason}`;
    }
  }

  const raw = g[opts.cacheKey] as T;

  if (!g[persisterKey]) {
    g[persisterKey] = createPersister<W>({
      getState: () => (opts.toJSON ? opts.toJSON(raw) : (raw as unknown as W)),
      path,
      onEvent: (m) => console.warn(`[${opts.label}] ${m}`),
    });
    flushOnExit(g[persisterKey] as Persister);
    if (bootNote) console.log(`[store] ${bootNote}`);
  }
  const persister = g[persisterKey] as Persister;

  return {
    state:
      opts.track === false ? raw : trackChanges(raw, persister.markDirty),
    markDirty: persister.markDirty,
    flush: persister.flush,
    stats: persister.stats,
    path,
    bootNote,
  };
}
