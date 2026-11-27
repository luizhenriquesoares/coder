const BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  json: "json",
  yml: "yaml",
  yaml: "yaml",
  md: "markdown",
  sql: "sql",
  sh: "shell",
  css: "css",
  scss: "scss",
  html: "html",
  xml: "xml",
  toml: "ini",
  tf: "hcl",
};

const BY_FILENAME: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
};

/** Maps a path to a language id understood by the workspace editor. */
export function languageFromPath(path: string): string {
  const fileName = path.split("/").pop()?.toLowerCase() ?? "";
  const byName = BY_FILENAME[fileName];
  if (byName) return byName;
  const extension = fileName.includes(".") ? fileName.split(".").pop()! : "";
  return BY_EXTENSION[extension] ?? "plaintext";
}

const TEST_PATH = /(^|\/)(__tests__|tests?|spec)(\/|$)|\.(test|spec)\.[a-z]+$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/i;

export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path);
}

const BINARY_EXTENSION =
  /\.(png|jpe?g|gif|webp|bmp|ico|icns|tiff?|psd|pdf|zip|gz|tgz|bz2|xz|7z|rar|tar|jar|war|woff2?|ttf|otf|eot|mp[34]|mov|avi|mkv|webm|wav|ogg|flac|exe|dll|so|dylib|bin|dat|class|pyc|o|a|wasm|sqlite|db|lockb|keystore|p12|pfx)$/i;

/** Files whose content is not text: nothing to diff line by line, nothing to show a reviewer. */
export function isBinaryPath(path: string): boolean {
  return BINARY_EXTENSION.test(path);
}
