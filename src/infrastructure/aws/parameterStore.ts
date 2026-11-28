import { travelsSafely } from "../claude/credential.js";

/**
 * A secret kept in AWS Systems Manager Parameter Store, read once when CodeR
 * starts. The AWS SDK finds its own credentials as the AWS CLI does: the
 * AWS_* variables, a profile of ~/.aws, a single sign-on session, or the role
 * of the machine, container or function CodeR runs in. It is loaded only when
 * a parameter is to be read.
 */

export interface ParameterReference {
  /** The name of the parameter, or its ARN. */
  readonly name: string;
  /** Where it is kept. Without one, the region of the AWS profile. */
  readonly region?: string | undefined;
  /** Another address for Systems Manager: a VPC endpoint, or a stand-in. */
  readonly endpoint?: string | undefined;
}

export interface StoredValue {
  readonly value: string;
  /** The region it was read in. */
  readonly region: string;
  /** Whether it is kept encrypted, as a SecureString. */
  readonly encrypted: boolean;
}

/** Why a parameter could not be read, in words for the operator. `transient` when trying again may be all it takes. */
export class ParameterStoreError extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
  ) {
    super(message);
    this.name = "ParameterStoreError";
  }
}

/** How long the start-up waits for AWS, credentials included. */
export const READ_DEADLINE_MS = 15_000;

const ARN = /^arn:aws[a-z-]*:ssm:([a-z0-9-]+):\d{12}:parameter\/.+$/;

/** The region an ARN names, or null for a plain name. */
export function regionOfArn(name: string): string | null {
  return ARN.exec(name)?.[1] ?? null;
}

export function isArn(name: string): boolean {
  return name.startsWith("arn:");
}

export async function readParameter(reference: ParameterReference, deadlineMs = READ_DEADLINE_MS): Promise<StoredValue> {
  const { SSMClient, GetParameterCommand } = await import("@aws-sdk/client-ssm");
  // A blank AWS_REGION, as compose files leave it, would hide the profile's region from the SDK: CodeR reads it as unset.
  if (!reference.region && process.env.AWS_REGION?.trim() === "") delete process.env.AWS_REGION;
  const client = new SSMClient({
    ...(reference.region ? { region: reference.region } : {}),
    ...(reference.endpoint ? { endpoint: reference.endpoint } : {}),
  });
  // The SDK finds an address in several places: AWS_ENDPOINT_URL, a profile's endpoint_url. Wherever it came
  // from, the decrypted value does not come back over plain http from another machine.
  client.middlewareStack.add(
    (next) => async (args) => {
      const request = args.request as { protocol?: string; hostname?: string; port?: number };
      const address = `${request.protocol ?? ""}//${request.hostname ?? ""}${request.port ? `:${request.port}` : ""}`;
      if (!travelsSafely(address)) {
        throw new ParameterStoreError(`the token would travel in the clear, from ${address}. Use an https address for Systems Manager (AWS_ENDPOINT_URL_SSM, AWS_ENDPOINT_URL or the profile's endpoint_url).`, false);
      }
      return next(args);
    },
    { step: "finalizeRequest", name: "coderRefusesClearText" },
  );
  const abort = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  // The deadline covers what the abort signal does not: finding the credentials, which may ask other services.
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(new ParameterStoreError(`AWS did not answer within ${deadlineMs / 1000} seconds. Try again in a moment.`, true));
    }, deadlineMs);
  });
  try {
    const read = (async () => {
      const region = await client.config.region();
      const answer = await client.send(new GetParameterCommand({ Name: reference.name, WithDecryption: true }), { abortSignal: abort.signal });
      return { region, parameter: answer.Parameter };
    })();
    const { region, parameter } = await Promise.race([read, deadline]);
    if (typeof parameter?.Value !== "string") throw new ParameterStoreError("AWS answered without a value for it.", false);
    return { value: parameter.Value, region, encrypted: parameter.Type === "SecureString" };
  } catch (error) {
    if (error instanceof ParameterStoreError) throw error;
    throw whyNotRead(error);
  } finally {
    clearTimeout(timer);
    client.destroy();
  }
}

/** Names AWS gives to credentials it does not take. */
const REFUSED_CREDENTIALS = new Set([
  "ExpiredTokenException",
  "ExpiredToken",
  "UnrecognizedClientException",
  "InvalidClientTokenId",
  "InvalidSignatureException",
  "SignatureDoesNotMatch",
  "IncompleteSignature",
]);
/** What STS answers when the profile cannot take on the role it names. */
const ROLE_REFUSED = new Set(["AccessDenied", "RegionDisabledException"]);
const UNREACHABLE = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EPIPE"]);

/**
 * What a failure of the SDK means. AWS's own sentence is repeated only where
 * AWS wrote it about the request, as it names the identity and the action. A
 * parser's error is not: it quotes what it choked on, which may be the value.
 */
function whyNotRead(error: unknown): ParameterStoreError {
  const failure = error instanceof Error ? error : new Error(String(error));
  const name = failure.name;
  const code = (failure as { code?: unknown }).code;
  const fault = (failure as { $fault?: unknown }).$fault;
  const said = fault === "client" || fault === "server" ? ` AWS said: ${failure.message.trim()}` : "";

  if (failure.message === "Region is missing") {
    return new ParameterStoreError("there is no AWS region to look for it in. Set AWS_REGION, give the ARN of the parameter, or name a region in the AWS profile.", false);
  }
  if (name === "CredentialsProviderError") {
    // Only the first line, and never what a credential_process command printed or was run with.
    const reason = failure.message.split("\n")[0]!.replace(/Command failed:.*$/, "a credential_process command failed").trim().replace(/\.$/, "");
    return new ParameterStoreError(
      `no AWS credentials were found (${reason}). Sign in with the AWS CLI (aws configure, aws sso login), set AWS_PROFILE, or run CodeR where a role gives it access.`,
      false,
    );
  }
  if (name === "ParameterNotFound" || name === "ParameterVersionNotFound") {
    return new ParameterStoreError("there is no such parameter there. Check its name and its region: the AWS console shows its ARN.", false);
  }
  if (name === "AccessDeniedException" && /kms:Decrypt|ciphertext|KMS key/i.test(failure.message)) {
    return new ParameterStoreError(`it is encrypted with a KMS key that the AWS identity CodeR runs as may not use: allow kms:Decrypt on that key.${said}`, false);
  }
  if (name === "AccessDeniedException") {
    return new ParameterStoreError(`the AWS identity CodeR runs as may not read it: allow ssm:GetParameter on the parameter.${said}`, false);
  }
  if (name === "InvalidKeyId" || name.startsWith("KMS")) {
    return new ParameterStoreError(`the KMS key it is encrypted with cannot be used: disabled, deleted or in another region.${said}`, false);
  }
  if (ROLE_REFUSED.has(name) || /sts:AssumeRole/.test(failure.message)) {
    return new ParameterStoreError(`the AWS profile could not take on the role it names (${name}): check the role's trust policy and the profile.${said}`, false);
  }
  if (REFUSED_CREDENTIALS.has(name)) {
    return new ParameterStoreError(`AWS refused the credentials CodeR found (${name}). Sign in again (aws sso login), or check AWS_PROFILE and the keys.`, false);
  }
  if (name === "ValidationException") {
    return new ParameterStoreError(`AWS did not take that as the name of a parameter.${said}`, false);
  }
  if (name === "ThrottlingException" || fault === "server") {
    return new ParameterStoreError(`AWS Systems Manager could not answer (${name}). Try again in a moment.`, true);
  }
  if (name === "AbortError" || name === "TimeoutError" || (typeof code === "string" && UNREACHABLE.has(code))) {
    return new ParameterStoreError(`AWS Systems Manager could not be reached (${typeof code === "string" ? code : name}). Check the network, or AWS_ENDPOINT_URL_SSM. Try again in a moment.`, true);
  }
  if (fault === "client") {
    return new ParameterStoreError(`AWS refused to give it (${name}).${said}`, false);
  }
  // A parser's error or one of the runtime's: only what kind it is.
  const status = (failure as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode;
  return new ParameterStoreError(`what came back is not a parameter (${name}${typeof status === "number" ? `, HTTP ${status}` : ""}). Check AWS_ENDPOINT_URL_SSM.`, false);
}
