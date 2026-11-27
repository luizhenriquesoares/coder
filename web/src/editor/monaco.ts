/**
 * Monaco, the editor that powers VS Code, bundled with only what a review
 * workspace needs: the diff editor, a handful of editor features and syntax
 * colouring. No language servers, so nothing here needs more than one worker.
 */
import * as monaco from "monaco-editor/editor/editor.api.js";
import "monaco-editor/features/codicon/register.js";
import "monaco-editor/features/diffEditor/register.js";
import "monaco-editor/features/hover/register.js";
import "monaco-editor/features/find/register.js";
import "monaco-editor/features/clipboard/register.js";
import "monaco-editor/features/bracketMatching/register.js";
import "monaco-editor/features/wordHighlighter/register.js";
import "monaco-editor/features/folding/register.js";
import "monaco-editor/languages/definitions/typescript/register.js";
import "monaco-editor/languages/definitions/javascript/register.js";
import "monaco-editor/languages/definitions/python/register.js";
import "monaco-editor/languages/definitions/go/register.js";
import "monaco-editor/languages/definitions/rust/register.js";
import "monaco-editor/languages/definitions/java/register.js";
import "monaco-editor/languages/definitions/kotlin/register.js";
import "monaco-editor/languages/definitions/csharp/register.js";
import "monaco-editor/languages/definitions/cpp/register.js";
import "monaco-editor/languages/definitions/ruby/register.js";
import "monaco-editor/languages/definitions/php/register.js";
import "monaco-editor/languages/definitions/swift/register.js";
import "monaco-editor/languages/definitions/sql/register.js";
import "monaco-editor/languages/definitions/yaml/register.js";
import "monaco-editor/languages/definitions/markdown/register.js";
import "monaco-editor/languages/definitions/shell/register.js";
import "monaco-editor/languages/definitions/dockerfile/register.js";
import "monaco-editor/languages/definitions/html/register.js";
import "monaco-editor/languages/definitions/css/register.js";
import "monaco-editor/languages/definitions/scss/register.js";
import "monaco-editor/languages/definitions/xml/register.js";
import "monaco-editor/languages/definitions/ini/register.js";
import "monaco-editor/languages/definitions/hcl/register.js";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker&inline";

globalThis.MonacoEnvironment = { getWorker: () => new EditorWorker() };

// JSON ships in Monaco as a full language service with its own worker. A review
// only needs colours, so a small tokenizer does the job.
monaco.languages.register({ id: "json", extensions: [".json"], aliases: ["JSON"] });
monaco.languages.setMonarchTokensProvider("json", {
  tokenizer: {
    root: [
      [/"(?:[^"\\]|\\.)*"(?=\s*:)/, "type"],
      [/"(?:[^"\\]|\\.)*"/, "string"],
      [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, "number"],
      [/\b(?:true|false|null)\b/, "keyword"],
      [/[{}[\],:]/, "delimiter"],
    ],
  },
});

export const CODE_FONT = 'ui-monospace, "SF Mono", "Cascadia Code", "Cascadia Mono", Menlo, Consolas, "Liberation Mono", monospace';

// The editor's palette follows the workspace tokens in web/src/styles/tokens.css.
monaco.editor.defineTheme("coder-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#151922",
    "editorGutter.background": "#151922",
    "editor.lineHighlightBackground": "#1c212d80",
    "editorLineNumber.foreground": "#586073",
    "editorLineNumber.activeForeground": "#b4bac8",
    "editorIndentGuide.background1": "#232836",
    "editorOverviewRuler.border": "#00000000",
    "diffEditor.insertedTextBackground": "#4cc38a38",
    "diffEditor.removedTextBackground": "#ff6b6b38",
    "diffEditor.insertedLineBackground": "#4cc38a1a",
    "diffEditor.removedLineBackground": "#ff6b6b1a",
    "diffEditor.diagonalFill": "#23283699",
    "diffEditor.unchangedRegionBackground": "#11141b",
    "diffEditor.unchangedRegionForeground": "#808899",
    "diffEditor.unchangedCodeBackground": "#11141b80",
    "diffEditor.border": "#232836",
    "scrollbarSlider.background": "#343c5066",
    "scrollbarSlider.hoverBackground": "#343c50aa",
    "scrollbarSlider.activeBackground": "#586073aa",
    "editorWidget.background": "#1c212d",
    "editorWidget.border": "#343c50",
    "editorHoverWidget.background": "#1c212d",
    "editorHoverWidget.border": "#343c50",
    focusBorder: "#7ea6ff",
  },
});

monaco.editor.defineTheme("coder-light", {
  base: "vs",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#ffffff",
    "editorGutter.background": "#ffffff",
    "editor.lineHighlightBackground": "#eaedf280",
    "editorLineNumber.foreground": "#98a0b2",
    "editorLineNumber.activeForeground": "#3d4555",
    "editorIndentGuide.background1": "#dcdfe7",
    "editorOverviewRuler.border": "#00000000",
    "diffEditor.insertedTextBackground": "#1b855633",
    "diffEditor.removedTextBackground": "#cf303033",
    "diffEditor.insertedLineBackground": "#1b855618",
    "diffEditor.removedLineBackground": "#cf303014",
    "diffEditor.diagonalFill": "#dcdfe7aa",
    "diffEditor.unchangedRegionBackground": "#f4f5f8",
    "diffEditor.unchangedRegionForeground": "#636c80",
    "diffEditor.unchangedCodeBackground": "#f4f5f880",
    "diffEditor.border": "#dcdfe7",
    "scrollbarSlider.background": "#c2c9d655",
    "scrollbarSlider.hoverBackground": "#c2c9d6aa",
    "scrollbarSlider.activeBackground": "#98a0b2aa",
    "editorWidget.background": "#ffffff",
    "editorWidget.border": "#c2c9d6",
    "editorHoverWidget.background": "#ffffff",
    "editorHoverWidget.border": "#c2c9d6",
    focusBorder: "#2c5fd6",
  },
});

export type EditorTheme = "dark" | "light";

export function applyEditorTheme(theme: EditorTheme): void {
  monaco.editor.setTheme(theme === "dark" ? "coder-dark" : "coder-light");
}

export { monaco };
