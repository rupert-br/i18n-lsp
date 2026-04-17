import {
  CompletionItem,
  CompletionItemKind,
  CompletionParams,
  InsertTextFormat,
  MarkupKind,
} from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import { TranslationStore } from "./translationIndex";
import { I18nConfig } from "./config";
import { sortedLocales } from "./utils";

/**
 * Provides autocompletion for translation keys.
 *
 * Triggers when the cursor is inside a translation function call,
 * offering all known keys with their default-locale values as detail.
 */
export function provideCompletions(
  params: CompletionParams,
  document: TextDocument,
  store: TranslationStore,
  config: I18nConfig
): CompletionItem[] {
  const text = document.getText();
  const offset = document.offsetAt(params.position);

  // Look backwards from cursor for an unclosed translation call.
  // Patterns are normalized to just "<name>(" so configs with or without
  // an included quote both work.
  const textBefore = text.substring(Math.max(0, offset - 200), offset);

  const alternatives = config.functionPatterns.map((pattern) => {
    const parenIdx = pattern.indexOf("(");
    const core = parenIdx >= 0 ? pattern.slice(0, parenIdx + 1) : pattern;
    const escaped = core.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const boundary = `(?<![\\w$])`;
    if (core.includes("formatMessage")) {
      return boundary + escaped + `\\s*\\{\\s*id\\s*:\\s*['"\`][^'"\`]*$`;
    }
    return boundary + escaped + `\\s*(?:key\\s*:\\s*)?['"\`][^'"\`]*$`;
  });

  const partialRegex = new RegExp(`(?:${alternatives.join("|")})`);
  if (!partialRegex.test(textBefore)) return [];

  // Return all keys as completion items
  const keys = store.allKeys();
  return keys.map((key, index) => {
    const value = store.get(key);
    return {
      label: key,
      kind: CompletionItemKind.Text,
      detail: value ? `"${value}"` : undefined,
      documentation: {
        kind: MarkupKind.Markdown,
        value: buildCompletionDoc(key, store, config),
      },
      sortText: String(index).padStart(6, "0"),
      insertText: key,
      insertTextFormat: InsertTextFormat.PlainText,
    };
  });
}

function buildCompletionDoc(
  key: string,
  store: TranslationStore,
  config: I18nConfig
): string {
  const translations = store.getAll(key);
  if (!translations) return "";

  const locales = sortedLocales(translations.keys(), config.defaultLocale);

  const lines = [`### 🌐 \`${key}\``, "", "| Locale | Translation |", "|--------|-------------|"];
  for (const locale of locales) {
    const value = translations.get(locale) ?? "";
    const marker = locale === config.defaultLocale ? " ●" : "";
    lines.push(`| ${locale}${marker} | ${value} |`);
  }
  return lines.join("\n");
}
