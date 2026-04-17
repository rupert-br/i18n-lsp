import * as fs from "fs";
import * as path from "path";
import { glob } from "glob";
import * as yaml from "yaml";
import * as chokidar from "chokidar";
import { I18nConfig, getTranslationGlob, extractLocale } from "./config";

/** Map of: key → { locale → translated value } */
export type TranslationIndex = Map<string, Map<string, string>>;

export class TranslationStore {
  private index: TranslationIndex = new Map();
  private watcher: chokidar.FSWatcher | null = null;
  private config: I18nConfig;
  private workspaceRoot: string;
  private onChanged: () => void;
  private cachedLocales: string[] | null = null;
  private cachedKeys: string[] | null = null;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    workspaceRoot: string,
    config: I18nConfig,
    onChanged: () => void,
    private log: (msg: string) => void = console.log
  ) {
    this.workspaceRoot = workspaceRoot;
    this.config = config;
    this.onChanged = onChanged;
  }

  /** Initial load of all translation files */
  async initialize(): Promise<void> {
    const pattern = getTranslationGlob(this.config);
    const fullPattern = path.join(this.workspaceRoot, pattern);
    const files = await glob(fullPattern);

    for (const file of files) {
      this.loadFile(file);
    }

    // Watch for changes
    this.watcher = chokidar.watch(fullPattern, {
      ignoreInitial: true,
    });

    const debouncedReload = (filePath: string) => {
      if (this.reloadTimer) clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => {
        this.loadFile(filePath);
        this.onChanged();
      }, 100);
    };

    this.watcher.on("change", debouncedReload);
    this.watcher.on("add", debouncedReload);
    this.watcher.on("unlink", (filePath) => {
      this.removeFile(filePath);
      this.onChanged();
    });
  }

  /** Look up a key's translation in a specific locale */
  get(key: string, locale?: string): string | undefined {
    const loc = locale ?? this.config.defaultLocale;
    return this.index.get(key)?.get(loc);
  }

  /** Get all translations for a key (all locales) */
  getAll(key: string): Map<string, string> | undefined {
    return this.index.get(key);
  }

  /** Get all known keys */
  allKeys(): string[] {
    if (!this.cachedKeys) {
      this.cachedKeys = Array.from(this.index.keys());
    }
    return this.cachedKeys;
  }

  /** Get all locales that have been loaded */
  allLocales(): string[] {
    if (!this.cachedLocales) {
      const locales = new Set<string>();
      for (const translations of this.index.values()) {
        for (const locale of translations.keys()) {
          locales.add(locale);
        }
      }
      this.cachedLocales = Array.from(locales);
    }
    return this.cachedLocales;
  }

  /** Check if a key exists in any locale */
  has(key: string): boolean {
    return this.index.has(key);
  }

  /** Find the file path and position for a key in a given locale */
  findKeyLocation(
    key: string,
    locale?: string
  ): { filePath: string; line: number; character: number } | null {
    const loc = locale ?? this.config.defaultLocale;
    const pattern = this.config.translationFiles.replace("{locale}", loc);
    const filePath = path.join(this.workspaceRoot, pattern);

    if (!fs.existsSync(filePath)) return null;

    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");

    // For flat keys, search for the exact key string
    // For nested keys, search for the last segment
    const segments = key.split(".");
    const searchKey =
      this.config.keyStyle === "nested" ? (segments[segments.length - 1] ?? key) : key;

    for (let i = 0; i < lines.length; i++) {
      // Match both JSON ("key":) and YAML (key:) styles
      const keyPattern = new RegExp(
        `["']?${searchKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?\\s*:`
      );
      if (keyPattern.test(lines[i])) {
        const col = lines[i].search(keyPattern);
        return { filePath, line: i, character: Math.max(0, col) };
      }
    }

    return null;
  }

  dispose(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.watcher?.close();
  }

  /** Load translation content from a string (used for editor buffer updates) */
  loadContent(filePath: string, content: string): void {
    const locale = extractLocale(filePath, this.config);
    if (!locale) return;

    // Clear existing entries for this locale before reloading
    for (const [key, translations] of this.index) {
      translations.delete(locale);
      if (translations.size === 0) {
        this.index.delete(key);
      }
    }

    const ext = path.extname(filePath).toLowerCase();
    let data: Record<string, unknown>;

    try {
      if (ext === ".json" || ext === ".arb") {
        data = JSON.parse(content);
      } else if (ext === ".yml" || ext === ".yaml") {
        data = yaml.parse(content);
      } else {
        return;
      }
    } catch {
      // Content may be temporarily invalid while the user is typing
      this.log(`Failed to parse translation file ${filePath}`);
      return;
    }

    const flat = this.flattenObject(data);

    for (const [key, value] of Object.entries(flat)) {
      if (key.startsWith("@@") || key.startsWith("@")) continue;

      if (!this.index.has(key)) {
        this.index.set(key, new Map());
      }
      this.index.get(key)!.set(locale, String(value));
    }

    this.cachedKeys = null;
    this.cachedLocales = null;
  }

  // --- Private ---

  private loadFile(filePath: string): void {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      this.loadContent(filePath, content);
    } catch (e) {
      this.log(`Failed to load translation file ${filePath}: ${e}`);
    }
  }

  private removeFile(filePath: string): void {
    const locale = extractLocale(filePath, this.config);
    if (!locale) return;

    for (const [key, translations] of this.index) {
      translations.delete(locale);
      if (translations.size === 0) {
        this.index.delete(key);
      }
    }

    this.cachedKeys = null;
    this.cachedLocales = null;
  }

  private flattenObject(
    obj: Record<string, unknown>,
    prefix = ""
  ): Record<string, string> {
    const result: Record<string, string> = {};

    for (const [key, value] of Object.entries(obj)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;

      if (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
      ) {
        Object.assign(
          result,
          this.flattenObject(value as Record<string, unknown>, fullKey)
        );
      } else {
        result[fullKey] = String(value);
      }
    }

    return result;
  }
}
