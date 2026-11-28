import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** A request the fake Systems Manager received. */
export interface RecordedRead {
  readonly target: string;
  readonly body: { Name?: string; WithDecryption?: boolean };
  /** The region the request was signed for, from the credential scope of its Authorization header. */
  readonly signedFor: string | null;
  readonly accessKeyId: string | null;
  readonly raw: string;
}

export type ParameterAnswer =
  | { readonly value: string; readonly type?: "String" | "SecureString" | "StringList" }
  | { readonly status: number; readonly error: string; readonly message?: string }
  | { readonly status: number; readonly rawBody: string; readonly contentType?: string }
  | { readonly stall: true };

export interface FakeParameterStore {
  readonly endpoint: string;
  readonly reads: RecordedRead[];
  close(): Promise<void>;
}

/** A local stand-in for AWS Systems Manager that answers GetParameter in its own JSON protocol. */
export async function startFakeParameterStore(answer: (read: RecordedRead) => ParameterAnswer): Promise<FakeParameterStore> {
  const reads: RecordedRead[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const scope = /Credential=([^/]+)\/\d{8}\/([^/]+)\/ssm\//.exec(String(req.headers.authorization ?? ""));
      const read: RecordedRead = {
        target: String(req.headers["x-amz-target"] ?? ""),
        body: JSON.parse(raw || "{}"),
        signedFor: scope?.[2] ?? null,
        accessKeyId: scope?.[1] ?? null,
        raw,
      };
      reads.push(read);
      const reply = answer(read);
      if ("stall" in reply) return;
      if ("rawBody" in reply) {
        res.writeHead(reply.status, { "content-type": reply.contentType ?? "application/x-amz-json-1.1" });
        res.end(reply.rawBody);
        return;
      }
      res.writeHead("status" in reply ? reply.status : 200, { "content-type": "application/x-amz-json-1.1", "x-amzn-requestid": "req-fake-ssm" });
      if ("status" in reply) {
        res.end(JSON.stringify({ __type: reply.error, message: reply.message ?? "" }));
        return;
      }
      const name = read.body.Name ?? "";
      res.end(JSON.stringify({ Parameter: { Name: name, Type: reply.type ?? "SecureString", Value: reply.value, Version: 1, DataType: "text" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    reads,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
