import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/composition/config.js";

describe("configuration", () => {
  it("refuses to listen beyond this machine without an API token", () => {
    expect(() => loadConfig({ HOST: "0.0.0.0" })).toThrow(/HOST: listening on 0\.0\.0\.0 needs CODER_API_TOKEN/);
    expect(loadConfig({ HOST: "0.0.0.0", CODER_API_TOKEN: "a-token-of-sixteen-chars" }).host).toBe("0.0.0.0");
    for (const host of ["127.0.0.1", "localhost", "::1"]) expect(loadConfig({ HOST: host }).host).toBe(host);
  });
});
