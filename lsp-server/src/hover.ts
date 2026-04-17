import { Hover, HoverParams, MarkupKind } from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import { TranslationStore } from "./translationIndex";
import { findTranslationCallAtPosition, expandDynamicKey } from "./patterns";
import { I18nConfig } from "./config";
import { formatLocaleTable } from "./utils";

/**
 * Shows all locale translations on hover over a key.
 *
 * Renders a markdown table:
 *   | Locale | Translation          |
 *   |--------|----------------------|
 *   | en ●   | Welcome back         |
 *   | de     | Willkommen zurück    |
 *   | fr     | Bienvenue            |
 */
export function provideHover(
  params: HoverParams,
  document: TextDocument,
  store: TranslationStore,
  config: I18nConfig
): Hover | null {
  const text = document.getText();
  const call = findTranslationCallAtPosition(
    text,
    params.position.line,
    params.position.character,
    config
  );

  if (!call) return null;

  if (call.dynamic) {
    const matches = expandDynamicKey(call.key, store.allKeys());
    if (matches.length === 0) {
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: `⚠️ **\`${call.key}\`** — no keys match this template`,
        },
      };
    }
    const lines = [
      `### 🌐 \`${call.key}\` — ${matches.length} matches`,
      "",
      `| Key | ${config.defaultLocale} |`,
      "|-----|------|",
    ];
    for (const key of matches) {
      const value = store.get(key) ?? "—";
      lines.push(`| \`${key}\` | ${value} |`);
    }
    return {
      contents: { kind: MarkupKind.Markdown, value: lines.join("\n") },
    };
  }

  const translations = store.getAll(call.key);
  if (!translations) {
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: `⚠️ **${call.key}** — no translations found`,
      },
    };
  }

  return {
    contents: {
      kind: MarkupKind.Markdown,
      value: formatLocaleTable(call.key, translations, config.defaultLocale),
    },
  };
}
