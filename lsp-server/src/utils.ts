import { I18nConfig } from "./config";
import { buildPatternRegex } from "./patterns";

/** Sort locales with defaultLocale first, rest alphabetically */
export function sortedLocales(locales: Iterable<string>, defaultLocale: string): string[] {
  return Array.from(locales).sort((a, b) => {
    if (a === defaultLocale) return -1;
    if (b === defaultLocale) return 1;
    return a.localeCompare(b);
  });
}

/** Format a translations map as a markdown locale table */
export function formatLocaleTable(
  key: string,
  translations: Map<string, string>,
  defaultLocale: string
): string {
  const locales = sortedLocales(translations.keys(), defaultLocale);
  const lines = [`### 🌐 \`${key}\``, "", "| Locale | Translation |", "|--------|-------------|"];
  for (const locale of locales) {
    const value = translations.get(locale)!;
    const marker = locale === defaultLocale ? " ●" : "";
    lines.push(`| ${locale}${marker} | ${value} |`);
  }
  return lines.join("\n");
}

/** Cached regex — avoids recompiling on every request */
let cachedRegex: { patterns: string[]; regex: RegExp } | null = null;

export function getCachedPatternRegex(config: I18nConfig): RegExp {
  if (
    cachedRegex &&
    cachedRegex.patterns.length === config.functionPatterns.length &&
    cachedRegex.patterns.every((p, i) => p === config.functionPatterns[i])
  ) {
    return cachedRegex.regex;
  }
  const regex = buildPatternRegex(config);
  cachedRegex = { patterns: [...config.functionPatterns], regex };
  return regex;
}
