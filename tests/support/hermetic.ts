import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Runs before every test file. The SDK reads ANTHROPIC_* variables on its own:
 * an address, extra headers, a profile, a workspace. Whatever the machine
 * exports would reach the tests through it. None does: the variables are
 * dropped, the API's address is one nothing listens on, and the directory of
 * sign-ins is one that does not exist. A test that wants one of them sets it.
 */
for (const name of Object.keys(process.env)) {
  if (name.startsWith("ANTHROPIC_")) delete process.env[name];
}
process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9";
process.env.ANTHROPIC_CONFIG_DIR = join(tmpdir(), "coder-tests-no-sign-in-here");
