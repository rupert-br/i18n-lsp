import * as fs from "fs";
import * as path from "path";
import { parse as parseJsonc, ParseError, printParseErrorCode } from "jsonc-parser";
import { detectConfig } from "./detect";

export const CONFIG_FILE_NAME = ".i18n-lsp.json";

export interface I18nConfig {
  /**
   * Glob patterns for translation files. Supports the placeholders
   * `{locale}` and `{namespace}`, e.g. "src/locales/{locale}.json" or
   * "public/locales/{locale}/{namespace}.json". Accepts a string or an array
   * in `.i18n-lsp.json`; always normalized to an array.
   */
  translationFiles: string[];
  /** Default/display locale for inlay hints */
  defaultLocale: string;
  /** Namespace used for unprefixed keys when `{namespace}` is in use */
  defaultNamespace: string;
  /** Function call patterns to detect i18n usage */
  functionPatterns: string[];
  /** "flat" = dot-separated keys, "nested" = nested object keys */
  keyStyle: "flat" | "nested";
  /** Additional locales to show in hover (beyond defaultLocale) */
  hoverLocales: string[];
  /** Max length for inlay hint display before truncation */
  maxInlayLength: number;
  /** Globs (relative to the project root) of source files scanned for key usages */
  sourceFiles: string[];
  /** Extra ignore globs for the source scan (on top of node_modules, dist, …) */
  sourceIgnore: string[];
  /** Report translation keys that no source file uses */
  reportUnusedKeys: boolean;
}

export const DEFAULT_SOURCE_FILES = ["**/*.{ts,tsx,js,jsx,mjs,cjs,vue,svelte,dart}"];

export const DEFAULT_SOURCE_IGNORE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/coverage/**",
  "**/.dart_tool/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/target/**",
];

const DEFAULT_CONFIG: I18nConfig = {
  translationFiles: ["src/locales/{locale}.json"],
  defaultLocale: "en",
  defaultNamespace: "translation",
  functionPatterns: ["t(", "i18n.t(", "$t(", "intl.formatMessage("],
  keyStyle: "nested",
  hoverLocales: [],
  maxInlayLength: 50,
  sourceFiles: DEFAULT_SOURCE_FILES,
  sourceIgnore: [],
  reportUnusedKeys: true,
};

export interface ConfigResult {
  config: I18nConfig;
  warnings: string[];
  /** True when the config text could not be parsed at all */
  parseError: boolean;
  /** True when `translationFiles` was found by scanning the project */
  detected: boolean;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * Merge user-supplied (untrusted) config values over the defaults, dropping
 * anything with the wrong type and reporting why.
 */
export function normalizeConfig(raw: unknown): { config: I18nConfig; warnings: string[] } {
  const warnings: string[] = [];
  const config: I18nConfig = {
    ...DEFAULT_CONFIG,
    translationFiles: [...DEFAULT_CONFIG.translationFiles],
    functionPatterns: [...DEFAULT_CONFIG.functionPatterns],
    hoverLocales: [],
    sourceFiles: [...DEFAULT_CONFIG.sourceFiles],
    sourceIgnore: [],
  };

  if (raw === undefined || raw === null) return { config, warnings };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push("Config must be a JSON object; using defaults.");
    return { config, warnings };
  }

  const input = raw as Record<string, unknown>;
  const known = new Set(Object.keys(DEFAULT_CONFIG));

  for (const key of Object.keys(input)) {
    if (!known.has(key)) warnings.push(`Unknown option "${key}" ignored.`);
  }

  const str = (name: keyof I18nConfig) => {
    const v = input[name];
    if (v === undefined) return;
    if (typeof v === "string" && v.trim() !== "") {
      (config as unknown as Record<string, unknown>)[name] = v;
    } else {
      warnings.push(`"${name}" must be a non-empty string; using default.`);
    }
  };

  const strArray = (name: keyof I18nConfig, allowEmpty: boolean) => {
    const v = input[name];
    if (v === undefined) return;
    if (isStringArray(v) && (allowEmpty || v.length > 0)) {
      (config as unknown as Record<string, unknown>)[name] = v;
    } else {
      warnings.push(`"${name}" must be an array of strings; using default.`);
    }
  };

  // translationFiles: string | string[]
  const tf = input.translationFiles;
  if (tf !== undefined) {
    if (typeof tf === "string" && tf.trim() !== "") {
      config.translationFiles = [tf];
    } else if (isStringArray(tf) && tf.length > 0) {
      config.translationFiles = tf;
    } else {
      warnings.push('"translationFiles" must be a string or a non-empty array of strings; using default.');
    }
  }
  for (const pattern of config.translationFiles) {
    if (!pattern.includes("{locale}")) {
      warnings.push(`translationFiles pattern "${pattern}" has no {locale} placeholder; it will be ignored.`);
    }
  }
  config.translationFiles = config.translationFiles.filter((p) => p.includes("{locale}"));
  if (config.translationFiles.length === 0) {
    config.translationFiles = [...DEFAULT_CONFIG.translationFiles];
  }

  str("defaultLocale");
  str("defaultNamespace");
  strArray("functionPatterns", false);
  strArray("hoverLocales", true);
  strArray("sourceFiles", true);
  strArray("sourceIgnore", true);

  if (input.keyStyle !== undefined) {
    if (input.keyStyle === "flat" || input.keyStyle === "nested") {
      config.keyStyle = input.keyStyle;
    } else {
      warnings.push('"keyStyle" must be "flat" or "nested"; using default.');
    }
  }

  if (input.maxInlayLength !== undefined) {
    const n = input.maxInlayLength;
    if (typeof n === "number" && Number.isFinite(n) && n >= 4) {
      config.maxInlayLength = Math.floor(n);
    } else {
      warnings.push('"maxInlayLength" must be a number >= 4; using default.');
    }
  }

  if (input.reportUnusedKeys !== undefined) {
    if (typeof input.reportUnusedKeys === "boolean") {
      config.reportUnusedKeys = input.reportUnusedKeys;
    } else {
      warnings.push('"reportUnusedKeys" must be a boolean; using default.');
    }
  }

  return { config, warnings };
}

/** Editor settings that are unset arrive as null, "" or []; drop those. */
function explicitSettings(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw).filter(
      ([, v]) => v !== null && v !== "" && !(Array.isArray(v) && v.length === 0)
    )
  );
}

/**
 * Resolve the config for the project at `root`. Nothing is required:
 * translation files are auto-detected unless set explicitly. Precedence,
 * lowest to highest: defaults, auto-detection, `editorSettings` (the client's
 * initializationOptions), `.i18n-lsp.json`.
 *
 * `textOverride` lets callers supply the contents of an unsaved editor buffer
 * instead of the config file on disk.
 */
export function readConfig(
  root: string,
  textOverride?: string,
  editorSettings?: unknown
): ConfigResult {
  const configPath = path.join(root, CONFIG_FILE_NAME);
  const warnings: string[] = [];
  let parseError = false;
  let fileSettings: unknown;

  let text = textOverride;
  if (text === undefined) {
    try {
      text = fs.readFileSync(configPath, "utf-8");
    } catch {
      // No config file: detection and editor settings apply.
    }
  }

  if (text !== undefined) {
    const errors: ParseError[] = [];
    const parsed = parseJsonc(text, errors, { allowTrailingComma: true });
    if (errors.length > 0) {
      warnings.push(`Failed to parse ${configPath}: ${printParseErrorCode(errors[0].error)}`);
      parseError = true;
    } else {
      fileSettings = parsed;
    }
  }

  let raw: unknown = fileSettings;
  let detected = false;
  if (fileSettings === undefined || (typeof fileSettings === "object" && !Array.isArray(fileSettings))) {
    let merged: Record<string, unknown> = { ...explicitSettings(editorSettings), ...(fileSettings as object) };
    if (merged.translationFiles === undefined) {
      try {
        const found = detectConfig(root);
        if (found) {
          merged = { ...found, ...merged };
          detected = true;
        }
      } catch {
        // Unreadable project directory: defaults apply.
      }
    }
    raw = merged;
  }

  const normalized = normalizeConfig(raw);
  return {
    config: normalized.config,
    warnings: [...warnings, ...normalized.warnings],
    parseError,
    detected,
  };
}

export function loadConfig(root: string): I18nConfig {
  return readConfig(root).config;
}

// --- Translation path patterns ---

export interface TranslationPathInfo {
  locale: string;
  namespace?: string;
}

const PLACEHOLDER = /\{(locale|namespace)\}/g;

/** Glob(s) used to discover translation files: placeholders become `*`. */
export function getTranslationGlobs(config: I18nConfig): string[] {
  return config.translationFiles.map((p) =>
    p.replace(/\\/g, "/").replace(/^\.\//, "").replace(PLACEHOLDER, "*")
  );
}

export function hasNamespacePlaceholder(config: I18nConfig): boolean {
  return config.translationFiles.some((p) => p.includes("{namespace}"));
}

const regexCache = new Map<string, RegExp>();

/** Compile a translation file pattern to a regex with named locale/namespace groups. */
function patternToRegex(pattern: string, anchored: boolean): RegExp {
  const cacheKey = `${anchored ? "a" : "s"}:${pattern}`;
  const cached = regexCache.get(cacheKey);
  if (cached) return cached;

  const p = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  const seen = new Set<string>();
  let re = "";

  for (let i = 0; i < p.length; ) {
    if (p.startsWith("{locale}", i) || p.startsWith("{namespace}", i)) {
      const name = p.startsWith("{locale}", i) ? "locale" : "namespace";
      re += seen.has(name) ? `\\k<${name}>` : `(?<${name}>[^/]+?)`;
      seen.add(name);
      i += name.length + 2;
    } else if (p.startsWith("**/", i)) {
      re += "(?:.*/)?";
      i += 3;
    } else if (p.startsWith("**", i)) {
      re += ".*";
      i += 2;
    } else if (p[i] === "*") {
      re += "[^/]*";
      i++;
    } else if (p[i] === "?") {
      re += "[^/]";
      i++;
    } else {
      re += p[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i++;
    }
  }

  const regex = new RegExp((anchored ? "^" : "(?:^|/)") + re + "$");
  regexCache.set(cacheKey, regex);
  return regex;
}

/**
 * Match a file path against the configured translation patterns.
 *
 * With `root`, the path is made relative to it and the pattern must match
 * from the start; paths outside the root never match. Without `root`, the
 * pattern may match any path suffix.
 */
export function matchTranslationPath(
  filePath: string,
  config: I18nConfig,
  root?: string
): TranslationPathInfo | null {
  let candidate = filePath.replace(/\\/g, "/");
  let anchored = false;

  if (root && path.isAbsolute(filePath)) {
    const rel = path.relative(root, filePath).replace(/\\/g, "/");
    if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
    candidate = rel;
    anchored = true;
  }

  for (const pattern of config.translationFiles) {
    const m = patternToRegex(pattern, anchored).exec(candidate);
    if (m?.groups?.locale) {
      return { locale: m.groups.locale, namespace: m.groups.namespace };
    }
  }
  return null;
}

/** Check if a file path matches the translation files pattern. */
export function isTranslationFile(
  filePath: string,
  config: I18nConfig,
  root?: string
): boolean {
  return matchTranslationPath(filePath, config, root) !== null;
}

/** Extract the locale identifier from a file path based on the patterns. */
export function extractLocale(
  filePath: string,
  config: I18nConfig,
  root?: string
): string | null {
  return matchTranslationPath(filePath, config, root)?.locale ?? null;
}
