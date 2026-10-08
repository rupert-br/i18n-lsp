import * as fs from "fs";
import * as path from "path";
import { glob } from "glob";
import * as chokidar from "chokidar";
import {
  I18nConfig,
  getTranslationGlobs,
  matchTranslationPath,
  hasNamespacePlaceholder,
  TranslationPathInfo,
} from "./config";
import { parseTranslations, KeyRange } from "./translationParser";
import { PathDebouncer } from "./debounce";

export interface KeyLocation extends KeyRange {
  filePath: string;
}

export interface KeyEntry {
  value: string;
  location: KeyLocation;
  /** Dotted parent chain inside the file (no namespace) */
  prefix: string;
  /** The key token as written in the file (contains dots for flat keys) */
  name: string;
  /** Key tokens from the file's (unwrapped) root down to this entry */
  segments: string[];
}

interface FileState extends TranslationPathInfo {
  /** Canonical keys this file contributed */
  keys: Set<string>;
  content: string;
  wrapper: string | null;
}

/** Plural category suffixes used by i18next (v21+) and legacy `_plural`. */
export const PLURAL_SUFFIXES = ["_zero", "_one", "_two", "_few", "_many", "_other", "_plural"];

export const NAMESPACE_SEPARATOR = ":";

const IGNORED = /(^|[/\\])(node_modules|\.git)([/\\]|$)/;

export class TranslationStore {
  /** canonical key → locale → entry */
  private index = new Map<string, Map<string, KeyEntry>>();
  private files = new Map<string, FileState>();
  private openBuffers = new Set<string>();
  private watcher: chokidar.FSWatcher | null = null;
  private debouncer = new PathDebouncer(100);
  private cachedLocales = new Map<string, string[]>();
  private cachedKeys: string[] | null = null;

  /** Bumped on every mutation; lets dependents invalidate their caches. */
  version = 0;
  readonly hasNamespaces: boolean;

  constructor(
    private workspaceRoot: string,
    private config: I18nConfig,
    private onChanged: () => void,
    private log: (msg: string) => void = console.log
  ) {
    this.hasNamespaces = hasNamespacePlaceholder(config);
  }

  /** Initial load of all translation files, then start watching. */
  async initialize(): Promise<void> {
    const globs = getTranslationGlobs(this.config);

    const found = await glob(globs, {
      cwd: this.workspaceRoot,
      absolute: true,
      nodir: true,
      ignore: ["**/node_modules/**", "**/.git/**"],
    });

    for (const file of found.sort()) {
      this.loadFile(file);
    }

    this.watcher = chokidar.watch(globs, {
      cwd: this.workspaceRoot,
      ignoreInitial: true,
      ignored: IGNORED,
    });

    const reload = (rel: string) => {
      const filePath = path.resolve(this.workspaceRoot, rel);
      this.debouncer.schedule(filePath, () => {
        // An open buffer is the source of truth; it syncs via didChange.
        if (this.openBuffers.has(filePath)) return;
        this.loadFile(filePath);
        this.onChanged();
      });
    };

    this.watcher.on("change", reload);
    this.watcher.on("add", reload);
    this.watcher.on("unlink", (rel) => {
      const filePath = path.resolve(this.workspaceRoot, rel);
      this.debouncer.cancel(filePath);
      this.removeFile(filePath);
      this.onChanged();
    });
  }

  // --- Lookups ---

  /** Look up a canonical key's translation in a specific locale */
  get(key: string, locale?: string): string | undefined {
    return this.index.get(key)?.get(locale ?? this.config.defaultLocale)?.value;
  }

  /** All translations for a canonical key (locale → value) */
  getAll(key: string): Map<string, string> | undefined {
    const entries = this.index.get(key);
    if (!entries) return undefined;
    const result = new Map<string, string>();
    for (const [locale, entry] of entries) result.set(locale, entry.value);
    return result;
  }

  /** All entries (with locations) for a canonical key */
  getEntries(key: string): Map<string, KeyEntry> | undefined {
    return this.index.get(key);
  }

  allKeys(): string[] {
    if (!this.cachedKeys) this.cachedKeys = Array.from(this.index.keys());
    return this.cachedKeys;
  }

  /**
   * Locales that have a translation file. With a namespace, only the locales
   * that have a file for that namespace.
   */
  allLocales(namespace?: string): string[] {
    const cacheKey = namespace ?? "";
    let locales = this.cachedLocales.get(cacheKey);
    if (!locales) {
      const set = new Set<string>();
      for (const file of this.files.values()) {
        if (namespace === undefined || file.namespace === namespace) set.add(file.locale);
      }
      locales = Array.from(set).sort();
      this.cachedLocales.set(cacheKey, locales);
    }
    return locales;
  }

  /** Check if a canonical key exists in any locale */
  has(key: string): boolean {
    return this.index.has(key);
  }

  /** True if some key lives below `key` (i.e. `key` is an object, not a leaf). */
  hasChildren(key: string): boolean {
    const prefix = key + ".";
    for (const k of this.index.keys()) {
      if (k.startsWith(prefix)) return true;
    }
    return false;
  }

  /** Namespace of a canonical key, if namespaces are in use. */
  namespaceOf(key: string): string | undefined {
    if (!this.hasNamespaces) return undefined;
    const i = key.indexOf(NAMESPACE_SEPARATOR);
    return i > 0 ? key.slice(0, i) : undefined;
  }

  /** Strip the namespace from a canonical key. */
  pathOf(key: string): string {
    return this.namespaceOf(key) !== undefined
      ? key.slice(key.indexOf(NAMESPACE_SEPARATOR) + 1)
      : key;
  }

  /** Keys a raw key written in code could refer to, most specific first. */
  candidateKeys(rawKey: string, namespaces: string[] = []): string[] {
    if (!this.hasNamespaces || rawKey.includes(NAMESPACE_SEPARATOR)) return [rawKey];
    const nss = Array.from(new Set([...namespaces, this.config.defaultNamespace]));
    return [...nss.map((ns) => `${ns}${NAMESPACE_SEPARATOR}${rawKey}`), rawKey];
  }

  /**
   * Resolve a key as written in code to canonical keys in the index.
   * Returns the exact key if present, otherwise the plural family
   * (`key_one`, `key_other`, …), otherwise an empty array.
   */
  resolveAll(rawKey: string, namespaces: string[] = []): string[] {
    const candidates = this.candidateKeys(rawKey, namespaces);
    for (const c of candidates) {
      if (this.index.has(c)) return [c];
    }
    for (const c of candidates) {
      const family = PLURAL_SUFFIXES.map((s) => c + s).filter((k) => this.index.has(k));
      if (family.length > 0) return family;
    }
    return [];
  }

  /** Single best canonical key for display (prefers the `_other` plural form). */
  resolve(rawKey: string, namespaces: string[] = []): string | undefined {
    const all = this.resolveAll(rawKey, namespaces);
    return all.find((k) => k.endsWith("_other")) ?? all[0];
  }

  /** Canonical key a not-yet-existing raw key would be created under. */
  canonicalForNew(rawKey: string, namespaces: string[] = []): string {
    if (!this.hasNamespaces || rawKey.includes(NAMESPACE_SEPARATOR)) return rawKey;
    return `${namespaces[0] ?? this.config.defaultNamespace}${NAMESPACE_SEPARATOR}${rawKey}`;
  }

  // --- Locations & files ---

  /** Where a key is defined in the given (default) locale's file. */
  findKeyLocation(
    key: string,
    locale?: string
  ): { filePath: string; line: number; character: number; endCharacter: number } | null {
    const entry = this.index.get(key)?.get(locale ?? this.config.defaultLocale);
    if (!entry) return null;
    const { filePath, line, character, endCharacter } = entry.location;
    return { filePath, line, character, endCharacter };
  }

  /** All definitions of a key, default locale first. */
  findKeyLocations(key: string): KeyLocation[] {
    const entries = this.index.get(key);
    if (!entries) return [];
    const locales = Array.from(entries.keys()).sort((a, b) => {
      if (a === this.config.defaultLocale) return -1;
      if (b === this.config.defaultLocale) return 1;
      return a.localeCompare(b);
    });
    return locales.map((l) => entries.get(l)!.location);
  }

  /** Entries contributed by one file, in source order. */
  entriesForFile(filePath: string): Array<{ key: string; locale: string; entry: KeyEntry }> {
    const file = this.files.get(filePath);
    if (!file) return [];
    const result: Array<{ key: string; locale: string; entry: KeyEntry }> = [];
    for (const key of file.keys) {
      const entry = this.index.get(key)?.get(file.locale);
      if (entry && entry.location.filePath === filePath) {
        result.push({ key, locale: file.locale, entry });
      }
    }
    return result.sort(
      (a, b) =>
        a.entry.location.line - b.entry.location.line ||
        a.entry.location.character - b.entry.location.character
    );
  }

  isTranslationFile(filePath: string): boolean {
    return matchTranslationPath(filePath, this.config, this.workspaceRoot) !== null;
  }

  fileInfo(filePath: string): (TranslationPathInfo & { wrapper: string | null }) | undefined {
    const f = this.files.get(filePath);
    return f && { locale: f.locale, namespace: f.namespace, wrapper: f.wrapper };
  }

  getFileContent(filePath: string): string | undefined {
    return this.files.get(filePath)?.content;
  }

  /**
   * The file a new key for (locale, namespace) should be written to. When
   * several files qualify, prefers the one holding the sibling keys that
   * share the longest dotted prefix with the new key.
   */
  fileFor(locale: string, namespace: string | undefined, keyPath: string): string | null {
    const candidates = Array.from(this.files.entries())
      .filter(([, f]) => f.locale === locale && f.namespace === namespace)
      .map(([p]) => p)
      .sort();
    if (candidates.length <= 1) return candidates[0] ?? null;

    let best = candidates[0];
    let bestScore = -1;
    const parts = keyPath.split(".");
    for (const file of candidates) {
      let score = 0;
      for (const key of this.files.get(file)!.keys) {
        const p = this.pathOf(key).split(".");
        let n = 0;
        while (n < p.length && n < parts.length && p[n] === parts[n]) n++;
        if (n > score) score = n;
      }
      if (score > bestScore) {
        best = file;
        bestScore = score;
      }
    }
    return best;
  }

  // --- Mutation ---

  /**
   * Load translation content from a string (disk or editor buffer).
   * Returns false when the content is invalid; the previous state is kept so
   * the user mid-typing doesn't wipe every hint.
   */
  loadContent(filePath: string, content: string): boolean {
    const info = matchTranslationPath(filePath, this.config, this.workspaceRoot);
    if (!info) return false;

    const parsed = parseTranslations(content, path.extname(filePath), info.locale);
    if (!parsed) {
      this.log(`Failed to parse translation file ${filePath}`);
      return false;
    }

    this.removeEntries(filePath);

    const keys = new Set<string>();
    for (const e of parsed.entries) {
      const key = info.namespace ? `${info.namespace}${NAMESPACE_SEPARATOR}${e.path}` : e.path;
      let locales = this.index.get(key);
      if (!locales) {
        locales = new Map();
        this.index.set(key, locales);
      }
      locales.set(info.locale, {
        value: e.value,
        prefix: e.prefix,
        name: e.name,
        segments: e.segments,
        location: { filePath, ...e.range },
      });
      keys.add(key);
    }

    this.files.set(filePath, { ...info, keys, content, wrapper: parsed.wrapper });
    this.invalidate();
    return true;
  }

  /** An editor buffer for a translation file changed. */
  setBuffer(filePath: string, content: string): void {
    this.openBuffers.add(filePath);
    if (this.loadContent(filePath, content)) this.onChanged();
  }

  /** The editor closed a buffer: fall back to what's on disk. */
  closeBuffer(filePath: string): void {
    if (!this.openBuffers.delete(filePath)) return;
    if (fs.existsSync(filePath)) {
      this.loadFile(filePath);
    } else {
      this.removeFile(filePath);
    }
    this.onChanged();
  }

  dispose(): void {
    this.debouncer.dispose();
    void this.watcher?.close();
    this.watcher = null;
  }

  // --- Private ---

  private loadFile(filePath: string): void {
    try {
      this.loadContent(filePath, fs.readFileSync(filePath, "utf-8"));
    } catch (e) {
      this.log(`Failed to load translation file ${filePath}: ${e}`);
    }
  }

  private removeFile(filePath: string): void {
    this.removeEntries(filePath);
    this.files.delete(filePath);
    this.invalidate();
  }

  /** Drop everything this file contributed — and nothing else. */
  private removeEntries(filePath: string): void {
    const file = this.files.get(filePath);
    if (!file) return;
    for (const key of file.keys) {
      const locales = this.index.get(key);
      if (!locales) continue;
      if (locales.get(file.locale)?.location.filePath === filePath) {
        locales.delete(file.locale);
      }
      if (locales.size === 0) this.index.delete(key);
    }
    file.keys.clear();
  }

  private invalidate(): void {
    this.cachedKeys = null;
    this.cachedLocales.clear();
    this.version++;
  }
}
