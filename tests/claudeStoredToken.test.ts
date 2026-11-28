import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/composition/config.js";
import { startupSummary } from "../src/composition/server.js";
import { readParameter } from "../src/infrastructure/aws/parameterStore.js";
import { betas, claudeApi, CODER_BETA, leftBehind, OAUTH_BETA, recordingLogger, review, startServer, temporaryDirectory, tidyUp } from "./support/claudeServer.js";
import { startFakeParameterStore, type ParameterAnswer, type RecordedRead } from "./support/fakeParameterStore.js";

/**
 * The auth token kept in AWS Systems Manager Parameter Store: named in the
 * configuration, read at start-up through the real AWS SDK from a local
 * stand-in, and sent to the Claude API like a token pasted in .env.
 *
 * The configuration reads the test's own variables; the AWS SDK finds its
 * credentials in the process environment, which each test stubs.
 */

const PARAMETER = "/coder/anthropic-auth-token";
const OAUTH_TOKEN = "sk-ant-oat01-token-kept-in-ssm-0123456789abcdef";
const GATEWAY_TOKEN = "gateway-token-kept-in-ssm";
const VARIABLE = "ANTHROPIC_AUTH_TOKEN_SSM_PARAMETER";

const stores: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  await tidyUp();
});

function awsKeys(): void {
  vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIACODERTESTKEY0001");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "secret-access-key-of-the-test");
}

async function parameterStore(answer: (read: RecordedRead) => ParameterAnswer) {
  const store = await startFakeParameterStore(answer);
  stores.push(store);
  return store;
}

/** Starts the server on a token kept at the stand-in, and returns why it refused to, or "". */
async function refusalOf(store: { endpoint: string }, variables: NodeJS.ProcessEnv = {}): Promise<string> {
  try {
    await startServer({ [VARIABLE]: PARAMETER, AWS_REGION: "eu-west-1", AWS_ENDPOINT_URL_SSM: store.endpoint, ...variables });
    return "";
  } catch (error) {
    return (error as Error).message;
  }
}

describe("naming the parameter", () => {
  const claudeOf = (env: NodeJS.ProcessEnv) => loadConfig(env).claude;
  const configRefusal = (env: NodeJS.ProcessEnv): string => {
    try {
      loadConfig(env);
      return "";
    } catch (error) {
      return (error as Error).message;
    }
  };

  it("comes before every other credential", () => {
    const all = { [VARIABLE]: PARAMETER, ANTHROPIC_AUTH_TOKEN: "sk-ant-oat01-token", ANTHROPIC_PROFILE: "work", ANTHROPIC_API_KEY: "sk-ant-api03-key", AWS_REGION: "eu-west-1" };
    expect(claudeOf(all)).toMatchObject({
      credential: { kind: "stored-auth-token", variable: VARIABLE, parameter: { name: PARAMETER, region: "eu-west-1" } },
      ignoredCredentials: ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_PROFILE", "ANTHROPIC_API_KEY"],
    });
  });

  it("looks for it in the region of its ARN, then AWS_REGION, then AWS_DEFAULT_REGION", () => {
    const arn = "arn:aws:ssm:sa-east-1:123456789012:parameter/coder/anthropic-auth-token";
    const regionOf = (env: NodeJS.ProcessEnv) => (claudeOf(env).credential as { parameter: { region?: string } }).parameter.region;
    expect(regionOf({ [VARIABLE]: arn, AWS_REGION: "us-east-1" })).toBe("sa-east-1");
    expect(regionOf({ [VARIABLE]: PARAMETER, AWS_REGION: "us-east-1", AWS_DEFAULT_REGION: "eu-west-3" })).toBe("us-east-1");
    expect(regionOf({ [VARIABLE]: PARAMETER, AWS_DEFAULT_REGION: "eu-west-3" })).toBe("eu-west-3");
    // Left to the AWS profile.
    expect(regionOf({ [VARIABLE]: PARAMETER })).toBeUndefined();
  });

  it("refuses the token itself on that line, without repeating it", () => {
    for (const secret of ["sk-ant-oat01-SECRETPART", "ghp_SECRETPART0123456789", "Bearer SECRETPART"]) {
      const refusal = configRefusal({ [VARIABLE]: secret });
      expect(refusal, secret).toContain(`${VARIABLE}: this looks like a token, not the name of a parameter.`);
      expect(refusal).not.toContain("SECRETPART");
    }
    expect(configRefusal({ [VARIABLE]: "/coder/my token" })).toContain(`${VARIABLE}: the name of a parameter has only letters`);
    expect(configRefusal({ [VARIABLE]: "arn:aws:s3:::bucket/token" })).toContain(`${VARIABLE}: this begins like an ARN but is not the ARN of a parameter`);
  });

  it("holds the AWS settings to a rule only when the parameter is used", () => {
    const odd = { AWS_REGION: "Europe (Ireland)", AWS_ENDPOINT_URL_SSM: "http://ssm.example.com" };
    expect(claudeOf({ ...odd, ANTHROPIC_API_KEY: "sk-ant-api03-key" }).credential).toMatchObject({ kind: "api-key" });
    expect(configRefusal({ ...odd, [VARIABLE]: PARAMETER })).toContain('AWS_REGION: "Europe (Ireland)" is not an AWS region');
    expect(configRefusal({ AWS_REGION: "eu-west-1", AWS_ENDPOINT_URL_SSM: "http://ssm.example.com", [VARIABLE]: PARAMETER })).toContain("AWS_ENDPOINT_URL_SSM: the token would travel in the clear");
    expect(configRefusal({ AWS_REGION: "eu-west-1", AWS_ENDPOINT_URL_SSM: "https://vpce-1.ssm.eu-west-1.vpce.amazonaws.com", [VARIABLE]: PARAMETER })).toBe("");
  });
});

describe("the token read from Parameter Store", () => {
  it("is read once, decrypted, signed for its region, and sent to the Claude API as an OAuth token", async () => {
    awsKeys();
    const store = await parameterStore(() => ({ value: OAUTH_TOKEN }));
    const api = await claudeApi();
    const { logger, lines } = recordingLogger();
    const run = await review(api, { [VARIABLE]: PARAMETER, AWS_REGION: "eu-west-1", AWS_ENDPOINT_URL_SSM: store.endpoint }, logger);

    expect(run.state.status).toBe("concluded");
    expect(store.reads).toHaveLength(1);
    expect(store.reads[0]).toMatchObject({ target: "AmazonSSM.GetParameter", body: { Name: PARAMETER, WithDecryption: true }, signedFor: "eu-west-1", accessKeyId: "AKIACODERTESTKEY0001" });
    expect(api.requests.length).toBeGreaterThan(0);
    for (const request of api.requests) {
      expect(request.headers.authorization).toBe(`Bearer ${OAUTH_TOKEN}`);
      expect(betas(request).sort()).toEqual([OAUTH_BETA, CODER_BETA].sort());
    }
    expect(run.claude).toEqual({
      model: "claude-opus-5-5",
      credential: "auth token (OAuth)",
      tokenFrom: `AWS Systems Manager parameter ${PARAMETER} in eu-west-1`,
      api: api.baseURL,
    });
    expect(JSON.stringify(startupSummary(run.config, run.claude))).not.toContain(OAUTH_TOKEN);
    expect(lines.filter((line) => line.level === "warn")).toEqual([]);
    expect(await leftBehind(run, lines)).not.toContain(OAUTH_TOKEN);
  });

  it("is a gateway's own when the reviews go to a gateway, and is trimmed", async () => {
    awsKeys();
    const store = await parameterStore(() => ({ value: `${GATEWAY_TOKEN}\n` }));
    const api = await claudeApi();
    const run = await review(api, { [VARIABLE]: PARAMETER, AWS_REGION: "eu-west-1", AWS_ENDPOINT_URL_SSM: store.endpoint });
    expect(run.claude?.credential).toBe("auth token");
    for (const request of api.requests) {
      expect(request.headers.authorization).toBe(`Bearer ${GATEWAY_TOKEN}`);
      expect(betas(request)).toEqual([CODER_BETA]);
    }
  });

  it("goes to the region of its ARN, and with AWS_DEFAULT_REGION, which the AWS SDK alone would not read", async () => {
    awsKeys();
    const store = await parameterStore(() => ({ value: OAUTH_TOKEN }));
    await startServer({ [VARIABLE]: "arn:aws:ssm:sa-east-1:123456789012:parameter/coder/token", AWS_REGION: "us-east-1", AWS_ENDPOINT_URL_SSM: store.endpoint });
    await startServer({ [VARIABLE]: PARAMETER, AWS_DEFAULT_REGION: "eu-west-3", AWS_ENDPOINT_URL_SSM: store.endpoint });
    expect(store.reads.map((read) => read.signedFor)).toEqual(["sa-east-1", "eu-west-3"]);
  });

  it("finds the region and the credentials in an AWS profile", async () => {
    const directory = await temporaryDirectory("coder-aws-profile-");
    await mkdir(join(directory, "aws"));
    await writeFile(join(directory, "aws", "config"), "[default]\nregion = us-east-1\n[profile reviews]\nregion = ap-southeast-2\n");
    await writeFile(join(directory, "aws", "credentials"), "[reviews]\naws_access_key_id = AKIAPROFILEKEY000001\naws_secret_access_key = secret-of-the-profile\n");
    vi.stubEnv("AWS_CONFIG_FILE", join(directory, "aws", "config"));
    vi.stubEnv("AWS_SHARED_CREDENTIALS_FILE", join(directory, "aws", "credentials"));
    vi.stubEnv("AWS_PROFILE", "reviews");
    const store = await parameterStore(() => ({ value: OAUTH_TOKEN }));
    const { claude } = await startServer({ [VARIABLE]: PARAMETER, AWS_ENDPOINT_URL_SSM: store.endpoint });
    expect(store.reads[0]).toMatchObject({ signedFor: "ap-southeast-2", accessKeyId: "AKIAPROFILEKEY000001" });
    expect(claude?.tokenFrom).toBe(`AWS Systems Manager parameter ${PARAMETER} in ap-southeast-2`);
  });

  it("warns when the token is kept as plain text", async () => {
    awsKeys();
    const store = await parameterStore(() => ({ value: OAUTH_TOKEN, type: "String" }));
    const { logger, lines } = recordingLogger();
    await startServer({ [VARIABLE]: PARAMETER, AWS_REGION: "eu-west-1", AWS_ENDPOINT_URL_SSM: store.endpoint }, logger);
    expect(lines).toContainEqual({
      level: "warn",
      message: `The Claude token is kept in AWS Systems Manager parameter ${PARAMETER} in eu-west-1 as plain text. Make it a SecureString: anyone allowed to list parameters there can read it.`,
      data: undefined,
    });
  });

  it("is taken out of a failure that repeats it", async () => {
    awsKeys();
    const opaque = "opaque-token-kept-in-ssm";
    const store = await parameterStore(() => ({ value: opaque }));
    const api = await claudeApi(() => ({ status: 401, errorType: "authentication_error", message: `no such token: ${opaque}` }));
    const { logger, lines } = recordingLogger();
    const run = await review(api, { [VARIABLE]: PARAMETER, AWS_REGION: "eu-west-1", AWS_ENDPOINT_URL_SSM: store.endpoint }, logger);
    expect(run.failure).toContain("(no such token: [credential removed])");
    expect(await leftBehind(run, lines)).not.toContain(opaque);
  });

  it("stops the start when it could not travel in a header, or is empty, without repeating it", async () => {
    awsKeys();
    let value = "sk-ant-oat01-SECRETPART\nSECRETPART";
    const store = await parameterStore(() => ({ value }));
    let refusal = await refusalOf(store);
    expect(refusal).toBe(
      `Invalid configuration:\n  ${VARIABLE}: the parameter "${PARAMETER}" (AWS Systems Manager, eu-west-1) holds a value CodeR cannot send: it has a space, a quote, a backslash, a line break or a character outside ASCII. Paste it alone, on one line.`,
    );
    expect(refusal).not.toContain("SECRETPART");
    value = "  \n";
    refusal = await refusalOf(store);
    expect(refusal).toBe(`Invalid configuration:\n  ${VARIABLE}: the parameter "${PARAMETER}" (AWS Systems Manager, eu-west-1) holds no token.`);
  });
});

describe("a parameter that cannot be read", () => {
  const because = (refusal: string) => refusal.replace(/^[^\n]*\n {2}ANTHROPIC_AUTH_TOKEN_SSM_PARAMETER: the parameter "[^"]+" \([^)]+\) could not be read: /, "");

  it("says what AWS refused, and what to change", async () => {
    awsKeys();
    const cases: [ParameterAnswer, string][] = [
      [{ status: 400, error: "ParameterNotFound" }, "there is no such parameter there. Check its name and its region: the AWS console shows its ARN."],
      [
        { status: 400, error: "AccessDeniedException", message: "User: arn:aws:sts::123456789012:assumed-role/coder/task is not authorized to perform: ssm:GetParameter on resource: arn:aws:ssm:eu-west-1:123456789012:parameter/coder/anthropic-auth-token" },
        "the AWS identity CodeR runs as may not read it: allow ssm:GetParameter on the parameter. AWS said: User: arn:aws:sts::123456789012:assumed-role/coder/task is not authorized to perform: ssm:GetParameter on resource: arn:aws:ssm:eu-west-1:123456789012:parameter/coder/anthropic-auth-token",
      ],
      [
        { status: 400, error: "AccessDeniedException", message: "User: arn:aws:sts::123456789012:assumed-role/coder/task is not authorized to perform: kms:Decrypt on resource: arn:aws:kms:eu-west-1:123456789012:key/k1" },
        "it is encrypted with a KMS key that the AWS identity CodeR runs as may not use: allow kms:Decrypt on that key. AWS said: User: arn:aws:sts::123456789012:assumed-role/coder/task is not authorized to perform: kms:Decrypt on resource: arn:aws:kms:eu-west-1:123456789012:key/k1",
      ],
      [{ status: 400, error: "InvalidKeyId", message: "arn:aws:kms:eu-west-1:123456789012:key/k1 is disabled." }, "the KMS key it is encrypted with cannot be used: disabled, deleted or in another region. AWS said: arn:aws:kms:eu-west-1:123456789012:key/k1 is disabled."],
      [{ status: 400, error: "ExpiredTokenException", message: "The security token included in the request is expired" }, "AWS refused the credentials CodeR found (ExpiredTokenException). Sign in again (aws sso login), or check AWS_PROFILE and the keys."],
      [{ status: 400, error: "UnrecognizedClientException", message: "The security token included in the request is invalid." }, "AWS refused the credentials CodeR found (UnrecognizedClientException). Sign in again (aws sso login), or check AWS_PROFILE and the keys."],
      [{ status: 400, error: "ValidationException", message: "Parameter name: can't be prefixed with \"ssm\"" }, 'AWS did not take that as the name of a parameter. AWS said: Parameter name: can\'t be prefixed with "ssm"'],
    ];
    let index = 0;
    const store = await parameterStore(() => cases[index]![0]);
    for (; index < cases.length; index++) {
      const refusal = await refusalOf(store);
      expect(refusal.split("\n")[0], cases[index]![1]).toBe("Invalid configuration:");
      expect(because(refusal)).toBe(cases[index]![1]);
    }
  });

  it("says to try again when AWS is busy, failing, out of reach or silent", async () => {
    awsKeys();
    let answer: ParameterAnswer = { status: 400, error: "ThrottlingException", message: "Rate exceeded" };
    const store = await parameterStore(() => answer);
    let refusal = await refusalOf(store);
    expect(refusal.split("\n")[0]).toBe("CodeR could not start:");
    expect(because(refusal)).toBe("AWS Systems Manager could not answer (ThrottlingException). Try again in a moment.");

    answer = { status: 500, error: "InternalServerError", message: "boom" };
    expect(because(await refusalOf(store))).toBe("AWS Systems Manager could not answer (InternalServerError). Try again in a moment.");

    refusal = await refusalOf({ endpoint: "http://127.0.0.1:9" });
    expect(refusal.split("\n")[0]).toBe("CodeR could not start:");
    expect(because(refusal)).toBe("AWS Systems Manager could not be reached (ECONNREFUSED). Check the network, or AWS_ENDPOINT_URL_SSM. Try again in a moment.");

    answer = { stall: true };
    await expect(readParameter({ name: PARAMETER, region: "eu-west-1", endpoint: store.endpoint }, 300)).rejects.toMatchObject({
      message: "AWS did not answer within 0.3 seconds. Try again in a moment.",
      transient: true,
    });
  });

  it("says where to find a region or credentials when there are none", async () => {
    const store = await parameterStore(() => ({ value: OAUTH_TOKEN }));
    expect(because(await refusalOf(store, { AWS_REGION: "" }))).toBe(
      "there is no AWS region to look for it in. Set AWS_REGION, give the ARN of the parameter, or name a region in the AWS profile.",
    );
    expect(because(await refusalOf(store))).toMatch(
      /^no AWS credentials were found \(.+\)\. Sign in with the AWS CLI \(aws configure, aws sso login\), set AWS_PROFILE, or run CodeR where a role gives it access\.$/,
    );
    expect(store.reads).toHaveLength(0);
  });

  it("does not repeat an answer that is not a parameter, which may hold the token", async () => {
    awsKeys();
    const store = await parameterStore(() => ({ status: 200, rawBody: `{"Parameter":{"Name":"/coder/token","Value":"sk-ant-oat01-SECRETPART-0123456789abcdef" "Version":1}}` }));
    const refusal = await refusalOf(store);
    expect(because(refusal)).toMatch(/^what came back is not a parameter \(\w+(, HTTP 200)?\)\. Check AWS_ENDPOINT_URL_SSM\.$/);
    expect(refusal).not.toContain("SECRETPART");
  });
});
