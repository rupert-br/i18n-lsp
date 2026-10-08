import {
  InlayHint,
  InlayHintKind,
  InlayHintParams,
  Position,
} from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import { TranslationStore } from "./translationIndex";
import { I18nConfig } from "./config";
import { sortedLocales } from "./utils";
import { analyzeDocument, resolveCall, preferredKey } from "./analysis";
import { Project } from "./project";

/**
 * Provides LSP inlay hints that show translated values inline.
 *
 * Example rendering:
 *
 *   const msg = t('welcome.back')  → en: "Welcome back" | de: "Willkommen zurück"
 *
 * The hints appear after the closing quote (and parenthesis) of each
 * translation call, using InlayHintKind.Type for consistent dimmed styling.
 */
export function provideInlayHints(
  params: InlayHintParams,
  document: TextDocument,
  project: Project
): InlayHint[] {
  const { store, config } = project;
  const hints: InlayHint[] = [];
  const analysis = analyzeDocument(document, config);

  const startLine = params.range.start.line;
  const endLine = params.range.end.line;

  for (const call of analysis.calls) {
    if (call.line < startLine || call.line > endLine) continue;

    const resolved = resolveCall(call, analysis.namespaces, store);
    if (resolved.length === 0) continue;

    let value: string | undefined;
    let key: string | undefined;
    if (call.dynamic) {
      value = formatDynamicValues(resolved, store, config.maxInlayLength);
    } else {
      key = preferredKey(resolved);
      value = key ? formatAllLocales(key, store, config) : undefined;
    }
    if (!value) continue;

    // Truncate long values
    const displayValue =
      value.length > config.maxInlayLength
        ? value.substring(0, config.maxInlayLength - 1) + "…"
        : value;

    // Place the hint after the closing quote and, if present, the paren.
    const line = document.getText({
      start: Position.create(call.line, 0),
      end: Position.create(call.line + 1, 0),
    });
    const afterKey = line.substring(call.keyEnd);
    const closeMatch = afterKey.match(/^['"`][ \t]*\)?/);
    const hintCol = call.keyEnd + (closeMatch ? closeMatch[0].length : 1);

    hints.push({
      position: Position.create(call.line, hintCol),
      label: `→ ${displayValue}`,
      kind: InlayHintKind.Type,
      paddingLeft: true,
      paddingRight: false,
      tooltip: call.dynamic
        ? buildTooltip(call.key, store, config, resolved)
        : buildTooltip(key!, store, config),
    });
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
