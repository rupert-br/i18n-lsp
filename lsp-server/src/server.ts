#!/usr/bin/env node

import {
  createConnection,
  ProposedFeatures,
  InitializeParams,
  InitializeResult,
  TextDocumentSyncKind,
  DidChangeConfigurationNotification,
  CodeActionKind,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";

import { loadConfig, I18nConfig, isTranslationFile } from "./config";
import { TranslationStore } from "./translationIndex";
import { provideInlayHints } from "./inlayHints";
import { provideCompletions } from "./completion";
import { provideHover } from "./hover";
import { provideDefinition } from "./definition";
import { provideDiagnostics } from "./diagnostics";
import { provideCodeActions } from "./codeActions";

// --- Connection setup ---
const connection = createConnection(ProposedFeatures.all);
const documents = new Map<string, TextDocument>();

let config: I18nConfig;
let store: TranslationStore;
let workspaceRoot: string;

function refreshAll() {
  for (const [uri, doc] of documents) {
    connection.sendDiagnostics({ uri, diagnostics: provideDiagnostics(doc, store, config) });
  }
  connection.languages.inlayHint.refresh();
}

// --- Lifecycle ---

connection.onInitialize((params: InitializeParams): InitializeResult => {
  // Determine workspace root
  workspaceRoot = params.workspaceFolders?.[0]?.uri
    ? URI.parse(params.workspaceFolders[0].uri).fsPath
    : params.rootUri
      ? URI.parse(params.rootUri).fsPath
      : process.cwd();

  // Load config
  config = loadConfig(workspaceRoot);

  // Initialize translation index
  store = new TranslationStore(workspaceRoot, config, () => {
    refreshAll();
  }, (msg) => connection.console.log(msg));

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Full,
      inlayHintProvider: {
        resolveProvider: false,
      },
      completionProvider: {
        triggerCharacters: ["'", '"', "."],
      },
      hoverProvider: true,
      definitionProvider: true,
      codeActionProvider: {
        codeActionKinds: [CodeActionKind.QuickFix],
      },
    },
  };
});

connection.onInitialized(async () => {
  await store.initialize();
  connection.console.log(
    `i18n-lsp initialized. Loaded ${store.allKeys().length} keys ` +
      `across ${store.allLocales().length} locales. ` +
      `Patterns: ${JSON.stringify(config.functionPatterns)}`
  );

  // Refresh diagnostics for documents opened before the store finished loading
  refreshAll();
});

// --- Document management ---

connection.onDidOpenTextDocument((params) => {
  const doc = TextDocument.create(
    params.textDocument.uri,
    params.textDocument.languageId,
    params.textDocument.version,
    params.textDocument.text
  );
  documents.set(params.textDocument.uri, doc);

  // Send initial diagnostics
  const diags = provideDiagnostics(doc, store, config);
  connection.sendDiagnostics({ uri: doc.uri, diagnostics: diags });
});

connection.onDidChangeTextDocument((params) => {
  const existing = documents.get(params.textDocument.uri);
  if (!existing) return;

  const doc = TextDocument.update(
    existing,
    params.contentChanges,
    params.textDocument.version
  );
  documents.set(params.textDocument.uri, doc);

  // If this is a translation file, update the store from the editor buffer
  const fsPath = URI.parse(params.textDocument.uri).fsPath;
  if (isTranslationFile(fsPath, config)) {
    store.loadContent(fsPath, doc.getText());
    refreshAll();
    return;
  }

  // Otherwise just refresh diagnostics for this document
  const diags = provideDiagnostics(doc, store, config);
  connection.sendDiagnostics({ uri: doc.uri, diagnostics: diags });
});

connection.onDidCloseTextDocument((params) => {
  documents.delete(params.textDocument.uri);
  connection.sendDiagnostics({
    uri: params.textDocument.uri,
    diagnostics: [],
  });
});

// --- Feature providers ---

connection.languages.inlayHint.on((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  return provideInlayHints(params, doc, store, config);
});

connection.onCompletion((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  return provideCompletions(params, doc, store, config);
});

connection.onHover((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  return provideHover(params, doc, store, config);
});

connection.onDefinition((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  return provideDefinition(params, doc, store, config);
});

connection.onCodeAction((params) => {
  return provideCodeActions(params, store, config, workspaceRoot);
});

// --- Start ---

connection.listen();
