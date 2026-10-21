// Test-only ESM resolver hook (OFFLINE, no deps).
//
// The identity modules use extensionless relative imports (e.g. `./types`,
// `../types`) which Next.js / tsc resolve via "bundler" module resolution.
// Node's native TypeScript loader, however, requires explicit specifiers. This
// hook maps an unresolved extensionless relative specifier to its `.ts` (or
// index) sibling so `node --test` can run the real source unchanged.
//
// It ONLY intervenes on resolution failure, so it never changes which file a
// fully-specified import points to. Registered via `--import` in the test
// script; it has no effect on the production build.

import { stat } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

async function exists(url) {
  try {
    await stat(fileURLToPath(url));
    return true;
  } catch {
    return false;
  }
}

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    // Only attempt to repair relative specifiers without an extension.
    const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
    const hasExt = /\.(ts|tsx|js|mjs|cjs|json)$/.test(specifier);
    if (!isRelative || hasExt || !context.parentURL) throw err;

    const base = new URL(specifier, context.parentURL);
    const candidates = [
      new URL(`${base.href}.ts`),
      new URL(`${base.href}.tsx`),
      new URL(`${base.href}/index.ts`),
    ];
    for (const c of candidates) {
      if (await exists(c)) {
        return nextResolve(c.href, context);
      }
    }
    // Also support the "@/..." path alias used across the app (maps to src/).
    throw err;
  }
}
