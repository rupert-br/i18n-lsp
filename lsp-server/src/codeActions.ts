import {
  CodeAction,
  CodeActionKind,
  CodeActionParams,
  TextEdit,
  WorkspaceEdit,
  Range,
  Position,
} from "vscode-languageserver";
import { TranslationStore } from "./translationIndex";
import { I18nConfig } from "./config";
import { URI } from "vscode-uri";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";

export function provideCodeActions(
  params: CodeActionParams,
  store: TranslationStore,
  config: I18nConfig,
  workspaceRoot: string
): CodeAction[] {
  const actions: CodeAction[] = [];

  for (const diag of params.context.diagnostics) {
    if (diag.source !== "i18n-lsp") continue;

    if (diag.code === "missing-key") {
      const data = diag.data as { key: string } | undefined;
      if (!data?.key) continue;
      const key = data.key;

      const edit = buildInsertKeyEdit(
        key,
        store.allLocales(),
        config,
        workspaceRoot
      );
      if (edit) {
        actions.push({
          title: `Add "${key}" to all translation files`,
          kind: CodeActionKind.QuickFix,
          diagnostics: [diag],
          isPreferred: true,
          edit,
        });
      }
    }

    if (diag.code === "partial-translation") {
      const data = diag.data as { key: string; missingLocales: string[] } | undefined;
      if (!data?.key || !data?.missingLocales) continue;
      const key = data.key;
      const missingLocales = data.missingLocales;

      const edit = buildInsertKeyEdit(
        key,
        missingLocales,
        config,
        workspaceRoot
      );
      if (edit) {
        actions.push({
          title: `Add "${key}" to ${missingLocales.join(", ")}`,
          kind: CodeActionKind.QuickFix,
          diagnostics: [diag],
          isPreferred: true,
          edit,
        });
      }
    }
  }

  return actions;
}

function buildInsertKeyEdit(
  key: string,
  locales: string[],
  config: I18nConfig,
  workspaceRoot: string
): WorkspaceEdit | null {
  const changes: { [uri: string]: TextEdit[] } = {};

  for (const locale of locales) {
    const relativePath = config.translationFiles.replace("{locale}", locale);
    const filePath = path.join(workspaceRoot, relativePath);

    if (!fs.existsSync(filePath)) continue;

    const content = fs.readFileSync(filePath, "utf-8");
    const ext = path.extname(filePath).toLowerCase();

    let data: Record<string, unknown>;
    try {
      if (ext === ".json" || ext === ".arb") {
        data = JSON.parse(content);
      } else if (ext === ".yml" || ext === ".yaml") {
        data = yaml.parse(content);
      } else {
        continue;
      }
    } catch {
      continue;
    }

    // Insert the key with a TODO placeholder
    if (config.keyStyle === "nested") {
      setNestedValue(data, key, "TODO");
    } else {
      data[key] = "TODO";
    }

    // Serialize back, preserving format
    let newContent: string;
    if (ext === ".json" || ext === ".arb") {
      newContent = JSON.stringify(data, null, 2) + "\n";
    } else {
      newContent = yaml.stringify(data);
    }

    // Build a full-file replacement edit
    const lines = content.split("\n");
    const lastLine = lines.length - 1;
    const lastLineLen = lines[lastLine].length;

    const uri = URI.file(filePath).toString();
    changes[uri] = [
      TextEdit.replace(
        Range.create(
          Position.create(0, 0),
          Position.create(lastLine, lastLineLen)
        ),
        newContent
      ),
    ];
  }

  if (Object.keys(changes).length === 0) return null;
  return { changes };
}

function setNestedValue(
  obj: Record<string, unknown>,
  key: string,
  value: string
): void {
  const parts = key.split(".");
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (
      !(parts[i] in current) ||
      typeof current[parts[i]] !== "object" ||
      current[parts[i]] === null
    ) {
      current[parts[i]] = {};
    }
    current = current[parts[i]] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}
