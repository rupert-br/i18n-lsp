import * as fs from "fs";
import * as path from "path";
import * as chokidar from "chokidar";
import { I18nConfig, ConfigResult, CONFIG_FILE_NAME, readConfig } from "./config";
import { TranslationStore } from "./translationIndex";
import { UsageIndex } from "./usageIndex";
import { PathDebouncer } from "./debounce";

export interface ProjectHooks {
  /** Translations changed: diagnostics and inlay hints need refreshing. */
  onTranslationsChanged: () => void;
  /** Only usages changed: diagnostics need refreshing. */
  onUsagesChanged: () => void;
  /** `.i18n-lsp.json` changed on disk. */
  onConfigFileChanged: (root: string) => void;
  log: (msg: string) => void;
}

/** One translation setup: a config, its translation store and its usage index. */
export class Project {
  readonly store: TranslationStore;
  readonly usage: UsageIndex;
  private configWatcher: chokidar.FSWatcher | null = null;
  private debouncer = new PathDebouncer(250);
  private disposed = false;

  constructor(
    readonly root: string,
    readonly config: I18nConfig,
    private hooks: ProjectHooks
  ) {
    this.store = new TranslationStore(root, config, hooks.onTranslationsChanged, hooks.log);
    this.usage = new UsageIndex(root, config, this.store, hooks.onUsagesChanged, hooks.log);
  }

  async initialize(): Promise<void> {
    this.configWatcher = chokidar.watch(CONFIG_FILE_NAME, {
      cwd: this.root,
      ignoreInitial: true,
    });
    const changed = () =>
      this.debouncer.schedule("config", () => this.hooks.onConfigFileChanged(this.root));
    this.configWatcher.on("add", changed);
    this.configWatcher.on("change", changed);
    this.configWatcher.on("unlink", changed);

    await this.store.initialize();
    if (this.disposed) return;
    this.hooks.onTranslationsChanged();

    await this.usage.initialize();
    if (this.disposed) return;
    this.hooks.onUsagesChanged();
  }

  dispose(): void {
    this.disposed = true;
    this.debouncer.dispose();
    void this.configWatcher?.close();
    this.store.dispose();
    this.usage.dispose();
  }
}

/**
 * Owns all projects of a workspace. A file belongs to the project whose
 * directory holds the nearest `.i18n-lsp.json` above it (so monorepo packages
 * can each have their own), falling back to the enclosing workspace folder.
 */
export class ProjectManager {
  private projects = new Map<string, Project>();
  private rootCache = new Map<string, string>();

  constructor(
    private folders: string[],
    private hooks: ProjectHooks,
    private warn: (msg: string) => void,
    /** Settings sent by the editor; `.i18n-lsp.json` overrides them */
    private editorSettings?: unknown
  ) {}

  /** Directory of the project a file belongs to. */
  projectRootFor(fsPath: string): string {
    const dir = path.dirname(fsPath);
    const cached = this.rootCache.get(dir);
    if (cached) return cached;

    const folder = this.folders
      .filter((f) => isInside(f, fsPath))
      .sort((a, b) => b.length - a.length)[0];

    let root: string | undefined;
    for (let d = dir; ; d = path.dirname(d)) {
      if (fs.existsSync(path.join(d, CONFIG_FILE_NAME))) {
        root = d;
        break;
      }
      if ((folder && d === folder) || path.dirname(d) === d) break;
    }
    root ??= folder ?? this.folders[0] ?? process.cwd();

    this.rootCache.set(dir, root);
    return root;
  }

  projectFor(fsPath: string): Project {
    return this.getOrCreate(this.projectRootFor(fsPath));
  }

  /** Make sure the project for each workspace folder is loading. */
  startFolders(): void {
    for (const folder of this.folders) this.getOrCreate(folder);
  }

  all(): Project[] {
    return Array.from(this.projects.values());
  }

  /** Re-read a project's config (from disk, or from `text` for an unsaved buffer). */
  reload(root: string, text?: string): void {
    const existing = this.projects.get(root);
    if (!existing) {
      this.rootCache.clear();
      return;
    }

    const result = readConfig(root, text, this.editorSettings);
    // Mid-edit buffers are often invalid JSON: keep the working setup.
    if (result.parseError && text !== undefined) return;
    this.report(root, result);

    existing.dispose();
    this.projects.delete(root);
    this.rootCache.clear();
    this.getOrCreate(root, result.config);
  }

  reloadAll(): void {
    for (const root of Array.from(this.projects.keys())) this.reload(root);
  }

  dispose(): void {
    for (const p of this.projects.values()) p.dispose();
    this.projects.clear();
  }

  // --- Private ---

  private getOrCreate(root: string, config?: I18nConfig): Project {
    let project = this.projects.get(root);
    if (project) return project;

    if (!config) {
      const result = readConfig(root, undefined, this.editorSettings);
      this.report(root, result);
      config = result.config;
    }

    project = new Project(root, config, this.hooks);
    this.projects.set(root, project);
    project.initialize().catch((e) => this.hooks.log(`Failed to initialize ${root}: ${e}`));
    return project;
  }

  private report(root: string, result: ConfigResult): void {
    for (const w of result.warnings) this.warn(`${path.join(root, CONFIG_FILE_NAME)}: ${w}`);
    if (result.detected) {
      this.hooks.log(`${root}: detected translation files ${result.config.translationFiles.join(", ")}`);
    }
  }
}

function isInside(folder: string, filePath: string): boolean {
  const rel = path.relative(folder, filePath);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}
