import {
  InlayHint,
  InlayHintKind,
  InlayHintParams,
  Position,
} from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import { TranslationStore } from "./translationIndex";
import {
  findTranslationCallsInLine,
  expandDynamicKey,
} from "./patterns";
import { I18nConfig } from "./config";
import { sortedLocales, getCachedPatternRegex } from "./utils";

/**
 * Provides LSP inlay hints that show translated values inline.
 *
 * Example rendering in Zed:
 *
 *   const msg = t('welcome.back')  → "Willkommen zurück"
 *   const title = t('app.title')   → "Meine App"
 *
 * The hints appear after the closing parenthesis of each translation call,
 * using InlayHintKind.Type for consistent dimmed styling.
 */
export function provideInlayHints(
  params: InlayHintParams,
  document: TextDocument,
  store: TranslationStore,
  config: I18nConfig
): InlayHint[] {
  const hints: InlayHint[] = [];
  const text = document.getText();
  const lines = text.split("\n");
  const regex = getCachedPatternRegex(config);

  // Only process lines within the requested range
  const startLine = params.range.start.line;
  const endLine = Math.min(params.range.end.line, lines.length - 1);

  for (let i = startLine; i <= endLine; i++) {
    const line = lines[i];
    const calls = findTranslationCallsInLine(line, i, regex);

    for (const call of calls) {
      let value: string | undefined;
      let matches: string[] | undefined;
      if (call.dynamic) {
        matches = expandDynamicKey(call.key, store.allKeys());
        if (matches.length === 0) continue;
        value = formatDynamicValues(matches, store, config.maxInlayLength);
      } else {
        value = formatAllLocales(call.key, store, config);
        if (!value) continue;
      }

      // Truncate long values
      const displayValue =
        value.length > config.maxInlayLength
          ? value.substring(0, config.maxInlayLength - 1) + "…"
          : value;

      // Find the closing quote + paren after the key to place the hint
      const afterKey = line.substring(call.keyEnd);
      const closeMatch = afterKey.match(/['"]\s*\)?/);
      const hintCol = closeMatch
        ? call.keyEnd + closeMatch.index! + closeMatch[0].length
        : call.keyEnd + 1;

      const hint: InlayHint = {
        position: Position.create(i, hintCol),
        label: `→ ${displayValue}`,
        kind: InlayHintKind.Type,
        paddingLeft: true,
        paddingRight: false,
        tooltip: call.dynamic && matches
          ? buildTooltip(call.key, store, config, matches)
          : buildTooltip(call.key, store, config),
      };

      hints.push(hint);
    }
  }

  return hints;
}

function formatAllLocales(
  key: string,
  store: TranslationStore,
  config: I18nConfig
): string | undefined {
  const translations = store.getAll(key);
  if (!translations) return undefined;

  const locales = sortedLocales(translations.keys(), config.defaultLocale);

  return locales
    .map((locale) => `${locale}: "${translations.get(locale)}"`)
    .join(" | ");
}

function formatDynamicValues(
  matchedKeys: string[],
  store: TranslationStore,
  maxLength: number
): string {
  const values = matchedKeys
    .map((key) => store.get(key))
    .filter((v): v is string => v !== undefined);

  if (values.length === 0)
    return `${matchedKeys.length} matches (no translations)`;

  let result = `"${values[0]}"`;
  let included = 1;

  for (let i = 1; i < values.length; i++) {
    const candidate = `${result} | "${values[i]}"`;
    const remaining = values.length - (i + 1);
    const suffix = remaining > 0 ? ` (+${remaining} more)` : "";
    if (candidate.length + suffix.length > maxLength) break;
    result = candidate;
    included++;
  }

  const remaining = values.length - included;
  if (remaining > 0) {
    result += ` (+${remaining} more)`;
  }

  return result;
}

/**
 * Build a multi-locale tooltip for hover on the inlay hint itself.
 *
 * Example:
 *   Key: welcome.back
 *   ─────────────────
 *   en: "Welcome back"
 *   de: "Willkommen zurück"
 *   fr: "Bienvenue"
 *
 * When dynamicMatches is provided, renders the dynamic format instead:
 *   **`template`** — N matches
 *   `key1`: value1
 *   `key2`: value2
 */
function buildTooltip(
  key: string,
  store: TranslationStore,
  config: I18nConfig,
  dynamicMatches?: string[]
): string {
  if (dynamicMatches) {
    const lines = [
      `**\`${key}\`** — ${dynamicMatches.length} matches`,
      "",
    ];

    for (const matchKey of dynamicMatches) {
      const value = store.get(matchKey) ?? "—";
      lines.push(`\`${matchKey}\`: ${value}`);
    }

    return lines.join("\n");
  }

  const translations = store.getAll(key);
  if (!translations) return `Key: ${key} (no translations found)`;

  const lines = [`**${key}**`, ""];

  // Show default locale first, then others alphabetically
  const locales = sortedLocales(translations.keys(), config.defaultLocale);

  for (const locale of locales) {
    const val = translations.get(locale)!;
    const marker = locale === config.defaultLocale ? " ●" : "";
    lines.push(`${locale}: "${val}"${marker}`);
  }

  return lines.join("\n");
}
