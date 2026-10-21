// Registers the test-only resolver hook on the module loader thread.
// Imported via `node --import ./tests/register.mjs` in the test script.
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./resolver.mjs", pathToFileURL("./tests/"));
