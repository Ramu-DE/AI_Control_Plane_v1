// Registers the test-only resolver hook on the module loader thread.
// Imported via `node --import ./tests/register.mjs` in the test script.
import { mkdtempSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// THE SUITE MUST NOT READ THE RUNNING APP'S STATE.
//
// Once the store became durable it loaded `.data/control-plane.json` on
// import — so the tests started reading whatever the live dev server had
// written. `tests/a2a.test.ts` immediately failed: it asserts the seeded peers
// are placeholders, and the snapshot held the real CloudFront peer created
// during live testing.
//
// A suite whose result depends on local runtime state is worse than no suite.
// Pointing the snapshot at a fresh temp directory per run makes every test
// start from `seed()`, deterministically, while still exercising the real
// persistence code path rather than stubbing it out.
//
// Set before the hook is registered, so nothing can import the store first.
if (!process.env.CONTROL_PLANE_STORE_PATH) {
  process.env.CONTROL_PLANE_STORE_PATH = join(
    mkdtempSync(join(tmpdir(), "cp-test-store-")),
    "control-plane.json"
  );
}

register("./resolver.mjs", pathToFileURL("./tests/"));
