import * as fs from "fs";
import * as path from "path";
import { glob } from "glob";
import * as chokidar from "chokidar";
import { I18nConfig, DEFAULT_SOURCE_IGNORE } from "./config";
import { DocumentAnalysis, analyzeText, resolveCall } from "./analysis";
import { TranslationCall } from "./patterns";
import { TranslationStore } from "./translationIndex";
import { PathDebouncer } from "./debounce";

const MAX_FILE_BYTES = 1024 * 1024;
const READ_CONCURRENCY = 16;

interface FileUsage {
  analysis: DocumentAnalysis;
  /** Keys this file references, valid for one store version */
  resolved: { storeVersion: number; keys: string[] } | null;
}

export interface UsageSite {
  filePath: string;
  call: TranslationCall;
}

/**
 * Tracks where translation keys are used across the project's source files.
 * Disk contents are scanned in the background; open editor buffers take
 * precedence so results always reflect unsaved edits.
 */
export class UsageIndex {
  private files = new Map<string, FileUsage>();
  private openBuffers = new Set<string>();
  private watcher: chokidar.FSWatcher | null = null;
  private debouncer = new PathDebouncer(150);
  private usedCache: { usageVersion: number; storeVersion: number; keys: Set<string> } | null = null;

  /** True once the initial scan has finished (and scanning is enabled). */
  ready = false;
  version = 0;

  constructor(
    private root: string,
    private config: I18nConfig,
    private store: TranslationStore,
    private onChanged: () => void,
    private log: (msg: string) => void = console.log
  ) {}

  async initialize(): Promise<void> {
    if (this.config.sourceFiles.length === 0) return; // scanning disabled

    const ignore = [...DEFAULT_SOURCE_IGNORE, ...this.config.sourceIgnore];
    const found = await glob(this.config.sourceFiles, {
      cwd: this.root,
      absolute: true,
      nodir: true,
      ignore,
    });

    let next = 0;
    const worker = async () => {
      while (next < found.length) {
        const file = found[next++];
        await this.scanFile(file);
      }
    };
    await Promise.all(Array.from({ length: READ_CONCURRENCY }, worker));

    this.ready = true;
    this.version++;
    this.log(`Indexed key usages in ${this.files.size} source files`);

    this.watcher = chokidar.watch(this.config.sourceFiles, {
      cwd: this.root,
      ignoreInitial: true,
      ignored: [/(^|[/\\])(node_modules|\.git|dist|build|out|coverage|\.dart_tool|\.next|\.nuxt|target)([/\\]|$)/, ...this.config.sourceIgnore],
    });

    const changed = (rel: string) => {
      const filePath = path.resolve(this.root, rel);
      this.debouncer.schedule(filePath, async () => {
        if (this.openBuffers.has(filePath)) return;
        await this.scanFile(filePath);
        this.touch();
      });
    };
    this.watcher.on("add", changed);
    this.watcher.on("change", changed);
    this.watcher.on("unlink", (rel) => {
      const filePath = path.resolve(this.root, rel);
      this.debouncer.cancel(filePath);
      if (this.files.delete(filePath)) this.touch();
    });

    this.onChanged();
  }

  /** An editor buffer changed; `analysis` was computed from its text. */
  setBuffer(filePath: string, analysis: DocumentAnalysis): void {
    this.openBuffers.add(filePath);
    this.files.set(filePath, { analysis, resolved: null });
    this.touch(false);
  }

  /** The editor closed a buffer: re-read the file from disk. */
  async closeBuffer(filePath: string): Promise<void> {
    if (!this.openBuffers.delete(filePath)) return;
    if (!(await this.scanFile(filePath))) this.files.delete(filePath);
    this.touch();
  }

  /** Every non-dynamic call whose key resolves to `canonicalKey`. */
  findUsages(canonicalKey: string): UsageSite[] {
    const sites: UsageSite[] = [];
    for (const [filePath, { analysis }] of this.files) {
      for (const call of analysis.calls) {
        if (call.dynamic) continue;
        if (this.store.resolveAll(call.key, analysis.namespaces).includes(canonicalKey)) {
          sites.push({ filePath, call });
        }
      }
    }
    return sites;
  }

  /** True if any source file contains a recognizable translation call. */
  hasAnyCalls(): boolean {
    for (const { analysis } of this.files.values()) {
      if (analysis.calls.length > 0) return true;
    }
    return false;
  }

  /** Canonical keys referenced somewhere (plural families and dynamic templates included). */
  usedKeys(): Set<string> {
    if (
      this.usedCache &&
      this.usedCache.usageVersion === this.version &&
      this.usedCache.storeVersion === this.store.version
    ) {
      return this.usedCache.keys;
    }

    // Only files that changed (or all of them, after a translation change) are re-resolved.
    const keys = new Set<string>();
    for (const file of this.files.values()) {
      if (file.resolved?.storeVersion !== this.store.version) {
        const resolved = new Set<string>();
        for (const call of file.analysis.calls) {
          for (const key of resolveCall(call, file.analysis.namespaces, this.store)) resolved.add(key);
        }
        file.resolved = { storeVersion: this.store.version, keys: Array.from(resolved) };
      }
      for (const key of file.resolved.keys) keys.add(key);
    }

    this.usedCache = { usageVersion: this.version, storeVersion: this.store.version, keys };
    return keys;
  }

  isUsed(canonicalKey: string): boolean {
    return this.usedKeys().has(canonicalKey);
  }

  dispose(): void {
    this.debouncer.dispose();
    void this.watcher?.close();
    this.watcher = null;
  }

  // --- Private ---

  private touch(notify = true): void {
    this.version++;
    if (notify) this.onChanged();
  }

  private async scanFile(filePath: string): Promise<boolean> {
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.size > MAX_FILE_BYTES) return false;
      const text = await fs.promises.readFile(filePath, "utf-8");
      // A buffer may have been opened while we were reading.
      if (this.openBuffers.has(filePath)) return true;
      this.files.set(filePath, { analysis: analyzeText(text, this.config), resolved: null });
      return true;
    } catch {
      this.files.delete(filePath);
      return false;
    }
  }
}
