import * as path from "path";
import * as yaml from "yaml";
import {
  Position,
  Range,
  TextEdit,
  WorkspaceEdit,
  ResponseError,
  LSPErrorCodes,
} from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import { analyzeDocument, callAtPosition, resolveCall } from "./analysis";
import { Project } from "./project";

interface RenameTarget {
  range: Range;
  /** Text offered as the initial value in the rename box */
  placeholder: string;
  /** The key in the store this rename starts from */
  canonicalKey: string;
}

function fail(message: string): never {
  throw new ResponseError(LSPErrorCodes.RequestFailed, message);
}

/** Work out which key (if any) sits under the cursor, in code or in a translation file. */
function locateTarget(
  doc: TextDocument,
  fsPath: string,
  position: Position,
  project: Project
): RenameTarget | null {
  const { store, config } = project;

  if (store.isTranslationFile(fsPath)) {
    for (const { key, entry } of store.entriesForFile(fsPath)) {
      const loc = entry.location;
      const range = Range.create(
        Position.create(loc.line, loc.character),
        Position.create(loc.endLine, loc.endCharacter)
      );
      if (contains(range, position)) return { range, placeholder: key, canonicalKey: key };
    }
    return null;
  }

  const analysis = analyzeDocument(doc, config);
  const call = callAtPosition(analysis, position.line, position.character);
  if (!call) return null;
  if (call.dynamic) fail("Keys built from template literals can't be renamed.");

  const resolved = resolveCall(call, analysis.namespaces, store);
  if (resolved.length === 0) return null;
  if (!store.candidateKeys(call.key, analysis.namespaces).includes(resolved[0])) {
    fail("Plural keys (key_one, key_other, …) can't be renamed from code yet; rename each form in the translation file.");
  }

  return {
    range: Range.create(
      Position.create(call.line, call.keyStart),
      Position.create(call.line, call.keyEnd)
    ),
    placeholder: call.key,
    canonicalKey: resolved[0],
  };
}

function contains(range: Range, p: Position): boolean {
  const afterStart =
    p.line > range.start.line || (p.line === range.start.line && p.character >= range.start.character);
  const beforeEnd =
    p.line < range.end.line || (p.line === range.end.line && p.character <= range.end.character);
  return afterStart && beforeEnd;
}

export function prepareRename(
  doc: TextDocument,
  fsPath: string,
  position: Position,
  project: Project
): { range: Range; placeholder: string } | null {
  const target = locateTarget(doc, fsPath, position, project);
  return target && { range: target.range, placeholder: target.placeholder };
}

export function provideRename(
  doc: TextDocument,
  fsPath: string,
  position: Position,
  newName: string,
  project: Project
): WorkspaceEdit {
  const { store, usage } = project;

  const target = locateTarget(doc, fsPath, position, project);
  if (!target) fail("There is no translation key to rename here.");

  const oldKey = target.canonicalKey;
  const name = newName.trim();
  if (name === "" || /[\s'"`]/.test(name)) {
    fail("A key can't be empty or contain whitespace or quotes.");
  }

  // Unprefixed names keep the namespace of the key being renamed.
  const oldNs = store.namespaceOf(oldKey);
  const newKey = store.hasNamespaces && !name.includes(":") && oldNs ? `${oldNs}:${name}` : name;
  if (newKey === oldKey) fail("The new key is the same as the old one.");
  if (store.namespaceOf(newKey) !== oldNs) fail("Moving a key to another namespace isn't supported.");
  if (store.has(newKey) || store.hasChildren(newKey)) fail(`"${newKey}" already exists.`);

  if (!usage.ready) {
    fail(
      project.config.sourceFiles.length === 0
        ? "Renaming needs source scanning, but `sourceFiles` is empty in .i18n-lsp.json."
        : "Source files are still being indexed; try again in a moment."
    );
  }

  const changes: { [uri: string]: TextEdit[] } = {};
  const add = (filePath: string, edit: TextEdit) => {
    (changes[URI.file(filePath).toString()] ??= []).push(edit);
  };

  // 1. The key token in every locale file.
  const newPath = store.pathOf(newKey);
  for (const entry of store.getEntries(oldKey)!.values()) {
    const { prefix } = entry;
    const rest = prefix ? (newPath.startsWith(prefix + ".") ? newPath.slice(prefix.length + 1) : null) : newPath;
    const file = path.basename(entry.location.filePath);

    if (!rest) {
      fail(`${file} nests this key under "${prefix}", so only the last part of the key can change.`);
    }
    if (rest.includes(".") && !entry.name.includes(".")) {
      fail(`${file} uses nested objects; a dot in the new name would need a new level. Rename only the last segment.`);
    }

    const ext = path.extname(entry.location.filePath).toLowerCase();
    const token = ext === ".yml" || ext === ".yaml" ? yaml.stringify(rest).trimEnd() : JSON.stringify(rest);
    const loc = entry.location;
    add(
      loc.filePath,
      TextEdit.replace(
        Range.create(
          Position.create(loc.line, loc.character),
          Position.create(loc.endLine, loc.endCharacter)
        ),
        token
      )
    );
  }

  // 2. Every usage in code, keeping the style (with or without namespace) it was written in.
  for (const site of usage.findUsages(oldKey)) {
    const raw = site.call.key;
    let replacement: string;
    if (raw === oldKey) {
      replacement = newKey;
    } else if (oldNs && oldKey === `${oldNs}:${raw}`) {
      replacement = store.pathOf(newKey);
    } else {
      fail("Plural keys (key_one, key_other, …) can't be renamed yet.");
    }
    add(
      site.filePath,
      TextEdit.replace(
        Range.create(
          Position.create(site.call.line, site.call.keyStart),
          Position.create(site.call.line, site.call.keyEnd)
        ),
        replacement
      )
    );
  }

  return { changes };
}
