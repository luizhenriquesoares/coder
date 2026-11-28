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
  if (name.startsWith("ANTHROPIC_") || name.startsWith("AWS_")) delete process.env[name];
}
process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9";
process.env.ANTHROPIC_CONFIG_DIR = join(tmpdir(), "coder-tests-no-sign-in-here");

/**
 * The same for the AWS SDK, which finds credentials, a region and addresses
 * on its own: no AWS_* variable of the machine, no ~/.aws, no instance
 * metadata service, and Systems Manager at an address nothing listens on.
 */
process.env.AWS_CONFIG_FILE = join(tmpdir(), "coder-tests-no-aws-here", "config");
process.env.AWS_SHARED_CREDENTIALS_FILE = join(tmpdir(), "coder-tests-no-aws-here", "credentials");
process.env.AWS_EC2_METADATA_DISABLED = "true";
process.env.AWS_ENDPOINT_URL = "http://127.0.0.1:9";

/**
 * And no test talks to another machine. One that drops the address above, to
 * see where the SDK goes without it, must not find the real API there.
 */
const send = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const { hostname, origin } = new URL(input instanceof Request ? input.url : input);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(hostname)) throw new Error(`A test called ${origin}. The tests talk to this machine only.`);
  return send(input, init);
};
