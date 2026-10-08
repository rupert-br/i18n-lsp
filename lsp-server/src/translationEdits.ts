import * as path from "path";
import * as yaml from "yaml";
import {
  modify,
  applyEdits,
  parseTree,
  findNodeAtLocation,
  FormattingOptions,
  JSONPath,
} from "jsonc-parser";
import { TextEdit, Range, Position, WorkspaceEdit } from "vscode-languageserver";
import { URI } from "vscode-uri";
import { LineMap } from "./translationParser";
import { Project } from "./project";

type Changes = { [uri: string]: TextEdit[] };

function isJson(filePath: string): boolean {
  return [".json", ".arb", ".jsonc"].includes(path.extname(filePath).toLowerCase());
}

function isYaml(filePath: string): boolean {
  return [".yml", ".yaml"].includes(path.extname(filePath).toLowerCase());
}

/** Guess indentation and line endings from the existing file. */
function detectFormatting(content: string): FormattingOptions {
  const indent = content.match(/^([ \t]+)\S/m)?.[1];
  const useTabs = indent?.[0] === "\t";
  return {
    insertSpaces: !useTabs,
    tabSize: !indent || useTabs ? 2 : indent.length,
    eol: content.includes("\r\n") ? "\r\n" : "\n",
  };
}

function replaceAll(content: string, newContent: string): TextEdit {
  const end = new LineMap(content).positionAt(content.length);
  return TextEdit.replace(
    Range.create(Position.create(0, 0), Position.create(end.line, end.character)),
    newContent
  );
}

/**
 * Add a key to the given locales' files. `valueFor` supplies the text for each
 * locale. Locales without a file, or that already define the key, are skipped.
 */
export function buildInsertKeyEdit(
  project: Project,
  canonicalKey: string,
  locales: string[],
  valueFor: (locale: string) => string
): WorkspaceEdit | null {
  const { store, config } = project;
  const namespace = store.namespaceOf(canonicalKey);
  const keyPath = store.pathOf(canonicalKey);
  const changes: Changes = {};

  for (const locale of locales) {
    if (store.getEntries(canonicalKey)?.has(locale)) continue;

    const filePath = store.fileFor(locale, namespace, keyPath);
    const content = filePath ? store.getFileContent(filePath) : undefined;
    if (!filePath || content === undefined) continue;

    const segments = config.keyStyle === "nested" ? keyPath.split(".") : [keyPath];

    // A leaf already sits where an object would have to go.
    let blocked = false;
    for (let i = 1; i < segments.length; i++) {
      const parent = segments.slice(0, i).join(".");
      if (store.has(namespace ? `${namespace}:${parent}` : parent)) blocked = true;
    }
    if (blocked) continue;

    const wrapper = store.fileInfo(filePath)?.wrapper;
    const fullPath = wrapper ? [wrapper, ...segments] : segments;
    const value = valueFor(locale);
    const uri = URI.file(filePath).toString();

    if (isJson(filePath)) {
      const map = new LineMap(content);
      const last = segments[segments.length - 1];
      const edits = modify(content, fullPath, value, {
        formattingOptions: detectFormatting(content),
        // Keep alphabetical order when the file already has it.
        getInsertionIndex: (props) => {
          const sorted = props.every((p, i) => i === 0 || props[i - 1] <= p);
          if (!sorted || props.length < 2) return props.length;
          const at = props.findIndex((p) => p > last);
          return at < 0 ? props.length : at;
        },
      });
      if (edits.length === 0) continue;
      changes[uri] = edits.map((e) =>
        TextEdit.replace(
          Range.create(
            toPosition(map.positionAt(e.offset)),
            toPosition(map.positionAt(e.offset + e.length))
          ),
          e.content
        )
      );
    } else if (isYaml(filePath)) {
      const doc: yaml.Document = yaml.parseDocument(content);
      if (doc.errors.length > 0) continue;
      if (!doc.contents) doc.contents = new yaml.YAMLMap();
      doc.setIn(fullPath, value);
      changes[uri] = [replaceAll(content, doc.toString({ lineWidth: 0 }))];
    }
  }

  return Object.keys(changes).length > 0 ? { changes } : null;
}

/**
 * Remove a key from every locale file that defines it, along with any
 * parent objects left empty.
 */
export function buildRemoveKeyEdit(project: Project, canonicalKey: string): WorkspaceEdit | null {
  const { store } = project;
  const entries = store.getEntries(canonicalKey);
  if (!entries) return null;

  const changes: Changes = {};

  for (const entry of entries.values()) {
    const filePath = entry.location.filePath;
    const content = store.getFileContent(filePath);
    if (content === undefined) continue;

    const wrapper = store.fileInfo(filePath)?.wrapper;
    const fullPath = wrapper ? [wrapper, ...entry.segments] : entry.segments;
    const rootDepth = wrapper ? 1 : 0;
    let newContent: string | undefined;

    if (isJson(filePath)) {
      newContent = removeFromJson(content, fullPath, rootDepth);
    } else if (isYaml(filePath)) {
      newContent = removeFromYaml(content, fullPath, rootDepth);
    }

    if (newContent !== undefined && newContent !== content) {
      changes[URI.file(filePath).toString()] = [replaceAll(content, newContent)];
    }
  }

  return Object.keys(changes).length > 0 ? { changes } : null;
}

function removeFromJson(content: string, fullPath: JSONPath, rootDepth: number): string {
  const formattingOptions = detectFormatting(content);
  let text = applyEdits(content, modify(content, fullPath, undefined, { formattingOptions }));

  for (let depth = fullPath.length - 1; depth > rootDepth; depth--) {
    const parentPath = fullPath.slice(0, depth);
    const tree = parseTree(text);
    const node = tree && findNodeAtLocation(tree, parentPath);
    if (node?.type === "object" && (node.children?.length ?? 0) === 0) {
      text = applyEdits(text, modify(text, parentPath, undefined, { formattingOptions }));
    } else {
      break;
    }
  }
  return text;
}

function removeFromYaml(content: string, fullPath: JSONPath, rootDepth: number): string {
  const doc = yaml.parseDocument(content);
  if (doc.errors.length > 0) return content;

  doc.deleteIn(fullPath as Array<string | number>);
  for (let depth = fullPath.length - 1; depth > rootDepth; depth--) {
    const parentPath = fullPath.slice(0, depth) as Array<string | number>;
    const node = doc.getIn(parentPath, true);
    if (yaml.isMap(node) && node.items.length === 0) {
      doc.deleteIn(parentPath);
    } else {
      break;
    }
  }
  return doc.toString({ lineWidth: 0 });
}

function toPosition(p: { line: number; character: number }): Position {
  return Position.create(p.line, p.character);
}
