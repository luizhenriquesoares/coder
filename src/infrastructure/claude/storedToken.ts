import { readParameter, type ParameterReference } from "../aws/parameterStore.js";
import { HEADER_SAFE, isOAuthToken, NOT_HEADER_SAFE, type ClaudeCredential } from "./credential.js";

/**
 * The auth token as it is kept in AWS Systems Manager Parameter Store, read
 * when CodeR starts and held to the rule of a token pasted in .env. A new
 * value in the parameter is read at the next start.
 */

export interface StoredToken {
  readonly credential: ClaudeCredential;
  /** Where it was read, for the log: the parameter and its region. Never the value. */
  readonly from: string;
}

export interface StoredTokenCheck {
  /** The variable that names the parameter, for the messages. */
  readonly variable: string;
  /** ANTHROPIC_BASE_URL, which tells an OAuth token from a gateway's. */
  readonly baseUrl?: string | undefined;
  readonly warn: (message: string) => void;
  /** How long to wait for AWS. */
  readonly deadlineMs?: number;
}

export async function readStoredToken(parameter: ParameterReference, check: StoredTokenCheck): Promise<StoredToken> {
  const where = parameter.region ? `"${parameter.name}" (AWS Systems Manager, ${parameter.region})` : `"${parameter.name}" (AWS Systems Manager)`;
  const stored = await readParameter(parameter, check.deadlineMs).catch((error: Error & { transient?: boolean }) => {
    const heading = error.transient ? "CodeR could not start" : "Invalid configuration";
    throw new Error(`${heading}:\n  ${check.variable}: the parameter ${where} could not be read: ${error.message}`);
  });
  const from = `AWS Systems Manager parameter ${parameter.name} in ${stored.region}`;
  const token = stored.value.trim();
  const problem = token === "" ? "holds no token" : HEADER_SAFE.test(token) ? null : `holds a value CodeR cannot send: ${NOT_HEADER_SAFE.replace(/^the value has/, "it has")}`;
  if (problem) throw new Error(`Invalid configuration:\n  ${check.variable}: the parameter ${where} ${problem}.`);
  if (!stored.encrypted) {
    check.warn(`The Claude token is kept in ${from} as plain text. Make it a SecureString: anyone allowed to list parameters there can read it.`);
  }
  return { credential: { kind: "auth-token", token, oauth: isOAuthToken(token, check.baseUrl) }, from };
}
