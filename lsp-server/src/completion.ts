import {
  CompletionItem,
  CompletionItemKind,
  CompletionParams,
  InsertTextFormat,
  MarkupKind,
  Range,
  TextEdit,
} from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import { TranslationStore } from "./translationIndex";
import { I18nConfig } from "./config";
import { sortedLocales } from "./utils";
import { findNamespaces } from "./patterns";
import { Project } from "./project";

/** Matches "the cursor is inside the (unclosed) key string of a translation call". */
const partialCache = new Map<string, RegExp>();

function partialCallRegex(config: I18nConfig): RegExp {
  const cacheKey = config.functionPatterns.join("\0");
  let re = partialCache.get(cacheKey);
  if (re) return re;

  // Patterns are normalized to just "<name>(" so configs with or without
  // an included quote both work.
  const alternatives = config.functionPatterns.map((pattern) => {
    const parenIdx = pattern.indexOf("(");
    const core = parenIdx >= 0 ? pattern.slice(0, parenIdx + 1) : pattern;
    const escaped = core.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const boundary = `(?<![\\w$])`;
    if (core.includes("formatMessage")) {
      return boundary + escaped + `\\s*\\{\\s*id\\s*:\\s*['"\`][^'"\`\\r\\n]*$`;
    }
    return boundary + escaped + `\\s*(?:key\\s*:\\s*)?['"\`][^'"\`\\r\\n]*$`;
  });
  alternatives.push(`(?<![\\w$])i18nKey\\s*=\\s*\\{?\\s*['"\`][^'"\`\\r\\n]*$`);

  re = new RegExp(`(?:${alternatives.join("|")})`);
  partialCache.set(cacheKey, re);
  return re;
}

/**
 * Provides autocompletion for translation keys.
 *
 * Triggers when the cursor is inside a translation function call,
 * offering all known keys with their default-locale values as detail.
 */
export function provideCompletions(
  params: CompletionParams,
  document: TextDocument,
  project: Project
): CompletionItem[] {
  const { store, config } = project;
  const offset = document.offsetAt(params.position);
  const text = document.getText();

  // Look backwards from the cursor for an unclosed translation call.
  const textBefore = text.substring(Math.max(0, offset - 200), offset);
  if (!partialCallRegex(config).test(textBefore)) return [];

  // Replace everything typed since the opening quote, dots included — editors
  // otherwise treat "." as a word boundary and duplicate the typed prefix.
  const typed = textBefore.match(/[^'"`\r\n]*$/)![0];
  const replaceRange = Range.create(
    document.positionAt(offset - typed.length),
    params.position
  );

  const namespaces = [...findNamespaces(text), config.defaultNamespace];

  return store.allKeys().map((key, index) => {
    const insert = shortestReference(key, store, namespaces);
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
      filterText: insert,
      textEdit: TextEdit.replace(replaceRange, insert),
      insertTextFormat: InsertTextFormat.PlainText,
    };
  });
}

/** Drop the namespace prefix when this file already resolves keys against it. */
function shortestReference(key: string, store: TranslationStore, namespaces: string[]): string {
  const ns = store.namespaceOf(key);
  if (ns !== undefined && namespaces.includes(ns)) return store.pathOf(key);
  return key;
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
