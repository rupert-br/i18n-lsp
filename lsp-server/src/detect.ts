import * as fs from "fs";
import * as path from "path";
import { globSync } from "glob";
import * as yaml from "yaml";
import type { I18nConfig } from "./config";

const TRANSLATION_GLOB = "**/*.{json,yml,yaml,arb}";

const IGNORED_DIRS = [
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  "vendor",
];

/** Directory names that conventionally hold translation files */
const HINT_DIR = /^(locales?|i18n|l10n|langs?|languages?|translations?|messages|intl)$/i;

/** Language, optionally followed by script/region subtags: en, pt-BR, zh_Hans_CN */
const LOCALE = "[A-Za-z]{2}(?:[-_](?:[A-Za-z]{2}|[A-Za-z]{4}|\\d{3}))*";
const LOCALE_NAME = new RegExp(`^${LOCALE}$`);
/** Optional prefix before the locale: app_en, messages.de */
const LOCALE_FILE = new RegExp(`^(.*?[_.-])??(${LOCALE})$`);

/** Default namespace candidates when a locale directory holds several files */
const PREFERRED_NAMESPACES = ["translation", "translations", "common", "messages", "index"];

let languageNames: Intl.DisplayNames | null | undefined;

function isLocale(candidate: string): boolean {
  if (!LOCALE_NAME.test(candidate)) return false;

  if (languageNames === undefined) {
    try {
      languageNames = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });
    } catch {
      languageNames = null;
    }
  }
  if (!languageNames) return true;

  // Rules out look-alikes such as "db.json" or "ui.json"
  try {
    return languageNames.of(candidate.slice(0, 2).toLowerCase()) !== undefined;
  } catch {
    return false;
  }
}

export interface DetectedPattern {
  /** Pattern with a {locale} and, for one directory per locale, a {namespace} placeholder */
  translationFiles: string;
  locales: string[];
  /** File names found per locale directory when {namespace} is in use */
  namespaces: string[];
}

/**
 * Pick the most likely translation file pattern from a list of
 * workspace-relative, "/"-separated file paths.
 */
export function pickTranslationPattern(relPaths: string[]): DetectedPattern | null {
  const candidates = new Map<string, { locales: Set<string>; namespaces: Set<string> }>();
  const add = (pattern: string, locale: string, namespace?: string) => {
    if (!candidates.has(pattern)) {
      candidates.set(pattern, { locales: new Set(), namespaces: new Set() });
    }
    const candidate = candidates.get(pattern)!;
    candidate.locales.add(locale);
    if (namespace !== undefined) candidate.namespaces.add(namespace);
  };

  for (const rel of relPaths) {
    const dirs = rel.split("/");
    const file = dirs.pop()!;
    const ext = path.posix.extname(file);
    const base = file.slice(0, file.length - ext.length);

    // locales/en.json, lib/l10n/app_en.arb
    const match = base.match(LOCALE_FILE);
    if (match && isLocale(match[2])) {
      add([...dirs, `${match[1] ?? ""}{locale}${ext}`].join("/"), match[2]);
    }

    // public/locales/en/translation.json
    const parent = dirs[dirs.length - 1];
    if (parent && isLocale(parent)) {
      add([...dirs.slice(0, -1), "{locale}", `{namespace}${ext}`].join("/"), parent, base);
    }
  }

  const ranked = Array.from(candidates, ([pattern, found]) => {
    const namespaces = Array.from(found.namespaces).sort();
    // A single file per locale directory needs no namespaces
    const single = namespaces.length === 1;
    const translationFiles = single ? pattern.replace("{namespace}", namespaces[0]) : pattern;
    const segments = translationFiles.split("/");
    return {
      translationFiles,
      locales: Array.from(found.locales).sort(),
      namespaces: single ? [] : namespaces,
      hinted: segments.some((s) => HINT_DIR.test(s)),
      depth: segments.length,
    };
  })
    // A lone "xx.json" outside a conventional directory is too weak a signal
    .filter((c) => c.hinted || c.locales.length >= 2)
    .sort(
      (a, b) =>
        Number(b.hinted) - Number(a.hinted) ||
        b.locales.length - a.locales.length ||
        a.depth - b.depth ||
        a.translationFiles.localeCompare(b.translationFiles)
    );

  const best = ranked[0];
  return best
    ? { translationFiles: best.translationFiles, locales: best.locales, namespaces: best.namespaces }
    : null;
}

export function pickDefaultLocale(locales: string[]): string | undefined {
  return (
    locales.find((l) => l.toLowerCase() === "en") ??
    locales.find((l) => /^en[-_]/i.test(l)) ??
    locales[0]
  );
}

/** "flat" if the file uses dotted top-level keys and no nested objects */
function detectKeyStyle(filePath: string): I18nConfig["keyStyle"] | undefined {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const data: unknown = /\.ya?ml$/i.test(filePath) ? yaml.parse(content) : JSON.parse(content);
    if (typeof data !== "object" || data === null) return undefined;

    const entries = Object.entries(data).filter(([key]) => !key.startsWith("@"));
    if (entries.some(([, value]) => typeof value === "object" && value !== null)) return "nested";
    if (entries.some(([key]) => key.includes("."))) return "flat";
  } catch {
    // Unreadable or invalid file: leave the default
  }
  return undefined;
}

/**
 * Scan the workspace for translation files and derive the settings
 * that would otherwise have to be configured by hand.
 */
export function detectConfig(workspaceRoot: string): Partial<I18nConfig> | null {
  const files = globSync(TRANSLATION_GLOB, {
    cwd: workspaceRoot,
    ignore: IGNORED_DIRS.map((dir) => `**/${dir}/**`),
    nodir: true,
    posix: true,
    maxDepth: 8,
  });

  const detected = pickTranslationPattern(files);
  if (!detected) return null;

  const result: Partial<I18nConfig> = { translationFiles: [detected.translationFiles] };

  const defaultNamespace =
    PREFERRED_NAMESPACES.find((ns) => detected.namespaces.includes(ns)) ?? detected.namespaces[0];
  if (defaultNamespace) result.defaultNamespace = defaultNamespace;

  const defaultLocale = pickDefaultLocale(detected.locales);
  if (defaultLocale) {
    result.defaultLocale = defaultLocale;
    const sample = detected.translationFiles
      .replace("{locale}", defaultLocale)
      .replace("{namespace}", defaultNamespace ?? "");
    const keyStyle = detectKeyStyle(path.join(workspaceRoot, sample));
    if (keyStyle) result.keyStyle = keyStyle;
  }

  return result;
}
