#!/usr/bin/env node

import {
  createConnection,
  ProposedFeatures,
  InitializeParams,
  InitializeResult,
  TextDocuments,
  TextDocumentSyncKind,
  Diagnostic,
  CodeActionKind,
  ResponseError,
  LSPErrorCodes,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import * as path from "path";

import { CONFIG_FILE_NAME } from "./config";
import { Project, ProjectManager } from "./project";
import { analyzeDocument } from "./analysis";
import { provideInlayHints } from "./inlayHints";
import { provideCompletions } from "./completion";
import { provideHover } from "./hover";
import { provideDefinition } from "./definition";
import { provideDiagnostics, provideTranslationFileDiagnostics } from "./diagnostics";
import { provideCodeActions } from "./codeActions";
import { prepareRename, provideRename } from "./rename";
import { buildReport } from "./reports";
import { Coalescer, PathDebouncer } from "./debounce";

const COMMAND_REPORT = "i18n-lsp.report";
const COMMAND_RELOAD = "i18n-lsp.reload";

/** Files that hold data rather than code; never scanned for translation calls. */
const DATA_EXTENSIONS = new Set([".json", ".jsonc", ".arb", ".yml", ".yaml"]);

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let manager: ProjectManager;
let supportsInlayRefresh = false;

// --- Refresh scheduling ---

// Bursts of changes (typing, formatter runs, git checkouts) collapse into one pass.
let pendingInlayRefresh = false;
const refresher = new Coalescer(200, () => {
  for (const doc of documents.all()) publishDiagnostics(doc);
  if (pendingInlayRefresh && supportsInlayRefresh) {
    connection.languages.inlayHint.refresh();
  }
  pendingInlayRefresh = false;
});

function scheduleRefresh(inlay: boolean) {
  pendingInlayRefresh ||= inlay;
  refresher.trigger();
}

const configReloads = new PathDebouncer(400);

// --- Helpers ---

function fsPathOf(uri: string): string | null {
  const parsed = URI.parse(uri);
  return parsed.scheme === "file" ? parsed.fsPath : null;
}

function isCodeFile(fsPath: string): boolean {
  return !DATA_EXTENSIONS.has(path.extname(fsPath).toLowerCase());
}

/** The project and file path for a document URI, or null for non-file documents. */
function contextFor(uri: string): { fsPath: string; project: Project } | null {
  const fsPath = fsPathOf(uri);
  if (!fsPath || !manager) return null;
  return { fsPath, project: manager.projectFor(fsPath) };
}

function publishDiagnostics(doc: TextDocument) {
  const ctx = contextFor(doc.uri);
  if (!ctx) return;
  const { fsPath, project } = ctx;

  let diagnostics: Diagnostic[];
  if (project.store.isTranslationFile(fsPath)) {
    diagnostics = provideTranslationFileDiagnostics(fsPath, project);
  } else if (isCodeFile(fsPath)) {
    diagnostics = provideDiagnostics(doc, project);
  } else {
    diagnostics = [];
  }
  connection.sendDiagnostics({ uri: doc.uri, diagnostics });
}

// --- Lifecycle ---

connection.onInitialize((params: InitializeParams): InitializeResult => {
  supportsInlayRefresh = !!params.capabilities.workspace?.inlayHint?.refreshSupport;

  const folders = (
    params.workspaceFolders?.map((f) => f.uri) ??
    (params.rootUri ? [params.rootUri] : [])
  )
    .map(fsPathOf)
    .filter((p): p is string => p !== null);
  if (folders.length === 0) folders.push(process.cwd());

  manager = new ProjectManager(
    folders,
    {
      onTranslationsChanged: () => scheduleRefresh(true),
      onUsagesChanged: () => scheduleRefresh(false),
      onConfigFileChanged: (root) => manager.reload(root),
      log: (msg) => connection.console.log(msg),
    },
    (msg) => {
      connection.console.warn(msg);
      connection.window.showWarningMessage(msg);
    },
    params.initializationOptions
  );

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      inlayHintProvider: { resolveProvider: false },
      completionProvider: { triggerCharacters: ["'", '"', "."] },
      hoverProvider: true,
      definitionProvider: true,
      codeActionProvider: {
        codeActionKinds: [CodeActionKind.QuickFix, CodeActionKind.RefactorExtract],
      },
      renameProvider: { prepareProvider: true },
      executeCommandProvider: { commands: [COMMAND_REPORT, COMMAND_RELOAD] },
    },
  };
});

connection.onInitialized(() => {
  manager.startFolders();
  connection.console.log(`i18n-lsp ready (${process.version})`);
});

connection.onShutdown(() => {
  refresher.dispose();
  configReloads.dispose();
  manager.dispose();
});

// --- Document management ---

// Fires on open and on every change.
documents.onDidChangeContent(({ document }) => {
  const ctx = contextFor(document.uri);
  if (!ctx) return;
  const { fsPath, project } = ctx;

  if (path.basename(fsPath) === CONFIG_FILE_NAME) {
    // Apply unsaved edits to the config, once the user pauses.
    configReloads.schedule(fsPath, () => {
      const current = documents.get(document.uri);
      if (current) manager.reload(path.dirname(fsPath), current.getText());
    });
    return;
  }

  if (project.store.isTranslationFile(fsPath)) {
    project.store.setBuffer(fsPath, document.getText());
    scheduleRefresh(true);
  } else if (isCodeFile(fsPath)) {
    project.usage.setBuffer(fsPath, analyzeDocument(document, project.config));
    scheduleRefresh(false);
  }
});

documents.onDidClose(({ document }) => {
  connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
  const ctx = contextFor(document.uri);
  if (!ctx) return;
  const { fsPath, project } = ctx;

  if (project.store.isTranslationFile(fsPath)) {
    project.store.closeBuffer(fsPath);
  } else if (isCodeFile(fsPath)) {
    void project.usage.closeBuffer(fsPath);
  }
});

documents.listen(connection);

// --- Feature providers ---

/** Run a provider for source documents only (not translation or config files). */
function withCodeDocument<T>(uri: string, fallback: T, fn: (doc: TextDocument, project: Project) => T): T {
  const doc = documents.get(uri);
  const ctx = contextFor(uri);
  if (!doc || !ctx || !isCodeFile(ctx.fsPath) || ctx.project.store.isTranslationFile(ctx.fsPath)) {
    return fallback;
  }
  return fn(doc, ctx.project);
}

connection.languages.inlayHint.on((params) =>
  withCodeDocument(params.textDocument.uri, [], (doc, project) =>
    provideInlayHints(params, doc, project)
  )
);

connection.onCompletion((params) =>
  withCodeDocument(params.textDocument.uri, [], (doc, project) =>
    provideCompletions(params, doc, project)
  )
);

connection.onHover((params) =>
  withCodeDocument(params.textDocument.uri, null, (doc, project) =>
    provideHover(params, doc, project)
  )
);

connection.onDefinition((params) =>
  withCodeDocument(params.textDocument.uri, null, (doc, project) =>
    provideDefinition(params, doc, project)
  )
);

connection.onCodeAction((params) => {
  const ctx = contextFor(params.textDocument.uri);
  if (!ctx) return [];
  return provideCodeActions(params, documents.get(params.textDocument.uri), ctx.fsPath, ctx.project);
});

connection.onPrepareRename((params) => {
  const doc = documents.get(params.textDocument.uri);
  const ctx = contextFor(params.textDocument.uri);
  if (!doc || !ctx) return null;
  return prepareRename(doc, ctx.fsPath, params.position, ctx.project);
});

connection.onRenameRequest((params) => {
  const doc = documents.get(params.textDocument.uri);
  const ctx = contextFor(params.textDocument.uri);
  if (!doc || !ctx) return null;
  return provideRename(doc, ctx.fsPath, params.position, params.newName, ctx.project);
});

connection.onExecuteCommand((params) => {
  switch (params.command) {
    case COMMAND_REPORT:
      return { projects: manager.all().map(buildReport) };
    case COMMAND_RELOAD:
      manager.reloadAll();
      return null;
    default:
      throw new ResponseError(LSPErrorCodes.RequestFailed, `Unknown command: ${params.command}`);
  }
});

// --- Start ---

connection.listen();
