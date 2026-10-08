import * as path from "path";
import {
  CodeAction,
  CodeActionKind,
  CodeActionParams,
  Position,
  Range,
  TextEdit,
  WorkspaceEdit,
} from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import { analyzeDocument, callAtPosition } from "./analysis";
import { buildInsertKeyEdit } from "./translationEdits";
import { Project } from "./project";

interface StringLiteral {
  start: number;
  /** Index of the closing quote */
  end: number;
  quote: string;
  inner: string;
}

const JSX_LANGUAGES = new Set(["typescriptreact", "javascriptreact"]);

/** Find a single- or double-quoted string literal on one line that contains `from`..`to`. */
export function findStringLiteral(
  line: string,
  from: number,
  to: number = from
): StringLiteral | null {
  for (let i = 0; i < line.length; i++) {
    const q = line[i];
    if (q !== "'" && q !== '"' && q !== "`") continue;

    let j = i + 1;
    while (j < line.length && line[j] !== q) j += line[j] === "\\" ? 2 : 1;
    if (j >= line.length) return null; // unterminated

    if (q !== "`" && from >= i && to <= j + 1) {
      return { start: i, end: j, quote: q, inner: line.slice(i + 1, j) };
    }
    i = j;
  }
  return null;
}

export function unescapeJsString(s: string): string {
  return s.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_, e: string) => {
    switch (e[0]) {
      case "n": return "\n";
      case "t": return "\t";
      case "r": return "\r";
      case "b": return "\b";
      case "f": return "\f";
      case "0": return "\0";
      case "u":
        return String.fromCodePoint(parseInt(e.startsWith("u{") ? e.slice(2, -1) : e.slice(1), 16));
      case "x":
        return String.fromCharCode(parseInt(e.slice(1), 16));
      default: return e;
    }
  });
}

function camelCase(words: string[]): string {
  return words
    .map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join("");
}

/** `LoginForm.tsx` → `loginForm`; `pages/home/index.ts` → `home`. */
function fileKeyPart(fsPath: string): string {
  let base = path.basename(fsPath).replace(/\..*$/, "");
  if (base === "index") base = path.basename(path.dirname(fsPath));
  // Split `loginForm`/`LoginForm` on case boundaries as well as separators.
  const words = base
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  return words.length > 0 ? camelCase(words) : "app";
}

function slug(text: string): string {
  const words = text
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5);
  return words.length > 0 ? camelCase(words) : "";
}

/**
 * Offer to move the string literal under the cursor into the translation
 * files: the literal becomes a translation call, and the text is added to the
 * default locale. The generated key is a starting point — rename it with F2.
 */
export function provideExtractAction(
  params: CodeActionParams,
  doc: TextDocument,
  fsPath: string,
  project: Project
): CodeAction | null {
  const { store, config } = project;
  const { start, end } = params.range;
  if (start.line !== end.line) return null;

  const lineText = doc.getText(Range.create(Position.create(start.line, 0), Position.create(start.line + 1, 0)));
  const line = lineText.replace(/\r?\n$/, "");
  const literal = findStringLiteral(line, start.character, end.character);
  if (!literal || literal.quote === "`") return null;

  const text = unescapeJsString(literal.inner);
  if (!/\p{L}/u.test(text) || /^[\w-]+(\.[\w-]+)+$/.test(text) || text.length > 200) return null;

  // Not an import path, and not already a translation key.
  const before = line.slice(0, literal.start);
  if (/(?:\bfrom|\bimport|\brequire\s*\()\s*$/.test(before)) return null;
  const analysis = analyzeDocument(doc, config);
  if (callAtPosition(analysis, start.line, literal.start + 1)) return null;

  // Which function to call: the first configured pattern that takes a plain key.
  const fnPattern = config.functionPatterns.find((p) => !p.includes("formatMessage"));
  if (!fnPattern) return null;
  const paren = fnPattern.indexOf("(");
  const fn = paren >= 0 ? fnPattern.slice(0, paren) : fnPattern;

  // Inside a tag (`<Tag attr=`): JSX needs braces, other markup isn't handled.
  let wrap = (call: string) => call;
  if (/<[A-Za-z][\w.:-]*(?:\s[^<]*)?\s[\w:@.-]+\s*=\s*$/.test(before)) {
    if (!JSX_LANGUAGES.has(doc.languageId)) return null;
    wrap = (call) => `{${call}}`;
  }

  const base = slug(text);
  if (!base) return null;
  const prefix = `${fileKeyPart(fsPath)}.${base}`;

  // Reuse an identical existing entry, otherwise find a free key.
  let rawKey = prefix;
  let canonical = store.canonicalForNew(rawKey, analysis.namespaces);
  let reuse = false;
  for (let n = 2; store.get(canonical) !== undefined; n++) {
    if (store.get(canonical) === text) {
      reuse = true;
      break;
    }
    rawKey = `${prefix}${n}`;
    canonical = store.canonicalForNew(rawKey, analysis.namespaces);
  }

  const changes: { [uri: string]: TextEdit[] } = {};
  if (!reuse) {
    const insert = buildInsertKeyEdit(project, canonical, [config.defaultLocale], () => text);
    if (!insert?.changes) return null;
    Object.assign(changes, insert.changes);
  }

  const q = literal.quote;
  changes[URI.file(fsPath).toString()] = [
    TextEdit.replace(
      Range.create(
        Position.create(start.line, literal.start),
        Position.create(start.line, literal.end + 1)
      ),
      wrap(`${fn}(${q}${rawKey}${q})`)
    ),
  ];

  const edit: WorkspaceEdit = { changes };
  return {
    title: reuse
      ? `Use existing translation key "${rawKey}"`
      : `Extract to translation key "${rawKey}"`,
    kind: CodeActionKind.RefactorExtract,
    edit,
  };
}
