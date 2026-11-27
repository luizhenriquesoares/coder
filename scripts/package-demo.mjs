/**
 * Packs the standalone build (web/dist-standalone) into single files:
 *
 *   coder-demo.html      a complete page: open it from disk, no server needed
 *   coder-artifact.html  the same page as a fragment, for hosts that supply
 *                        their own <html>/<head>/<body> around it
 *
 * Run `npm run build:demo`, which builds first.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../web/dist-standalone/", import.meta.url));
const assets = join(dist, "assets");
const only = (extension) => {
  const matches = readdirSync(assets).filter((name) => name.endsWith(extension));
  if (matches.length !== 1) throw new Error(`Expected one ${extension} file in ${assets}, found ${matches.length}. Run the standalone build first.`);
  return readFileSync(join(assets, matches[0]), "utf8");
};

/**
 * Inside an inline <script>, the HTML parser reacts to "<!--", "<script" and
 * "</script" even when they sit in a JavaScript string. Writing their "<" as
 * the escape \x3C means the same thing to JavaScript (in strings, template
 * literals and regular expressions) and nothing to the HTML parser.
 */
function safeForInlineScript(code) {
  const escaped = code.replace(/<(?=!--|\/?script)/gi, "\\x3C");
  // If one of those sequences was code rather than a literal, the escape is a syntax error. Check.
  const scratch = mkdtempSync(join(tmpdir(), "coder-demo-"));
  try {
    const file = join(scratch, "bundle.mjs");
    writeFileSync(file, escaped);
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return escaped;
}

const script = safeForInlineScript(only(".js"));
const style = only(".css");
if (/<\/style/i.test(style)) throw new Error("The stylesheet contains </style and cannot be inlined as is.");

const TITLE = "CodeR Review Council";
const body = `<style>${style}</style>
<div id="root"></div>
<script type="module">${script}</script>`;

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
<title>${TITLE}</title>
</head>
<body>
${body}
</body>
</html>
`;
const fragment = `<title>${TITLE}</title>
${body}
`;

writeFileSync(join(dist, "coder-demo.html"), page);
writeFileSync(join(dist, "coder-artifact.html"), fragment);
const megabytes = (text) => `${(Buffer.byteLength(text) / 1024 / 1024).toFixed(1)} MB`;
console.log(`coder-demo.html      ${megabytes(page)}`);
console.log(`coder-artifact.html  ${megabytes(fragment)}`);
