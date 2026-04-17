import * as fs from "fs";
import * as path from "path";

export interface I18nConfig {
  /** Glob pattern for translation files, e.g. "src/locales/{locale}.json" */
  translationFiles: string;
  /** Default/display locale for inlay hints */
  defaultLocale: string;
  /** Function call patterns to detect i18n usage */
  functionPatterns: string[];
  /** "flat" = dot-separated keys, "nested" = nested object keys */
  keyStyle: "flat" | "nested";
  /** Additional locales to show in hover (beyond defaultLocale) */
  hoverLocales: string[];
  /** Max length for inlay hint display before truncation */
  maxInlayLength: number;
}

const DEFAULT_CONFIG: I18nConfig = {
  translationFiles: "src/locales/{locale}.json",
  defaultLocale: "en",
  functionPatterns: ["t(", "i18n.t(", "$t(", "intl.formatMessage("],
  keyStyle: "nested",
  hoverLocales: [],
  maxInlayLength: 50,
};

export function loadConfig(workspaceRoot: string): I18nConfig {
  const configPath = path.join(workspaceRoot, ".i18n-lsp.json");

  if (fs.existsSync(configPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      return { ...DEFAULT_CONFIG, ...raw };
    } catch (e) {
      console.error(`Failed to parse ${configPath}:`, e);
    }
  }

  return DEFAULT_CONFIG;
}

/**
 * Expand the translationFiles glob pattern into actual file paths.
 * Replaces {locale} with a wildcard for discovery.
 */
export function getTranslationGlob(config: I18nConfig): string {
  return config.translationFiles.replace("{locale}", "*");
}

/**
 * Check if a file path matches the translation files pattern.
 */
export function isTranslationFile(
  filePath: string,
  config: I18nConfig
): boolean {
  return extractLocale(filePath, config) !== null;
}

/**
 * Extract the locale identifier from a file path based on the pattern.
 */
export function extractLocale(
  filePath: string,
  config: I18nConfig
): string | null {
  // Build a regex from the pattern: "src/locales/{locale}.json"
  // → /src\/locales\/(.+?)\.json$/
  const escaped = config.translationFiles
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace("\\{locale\\}", "(.+?)");
  const re = new RegExp(escaped + "$");
  const match = filePath.replace(/\\/g, "/").match(re);
  return match?.[1] ?? null;
}
