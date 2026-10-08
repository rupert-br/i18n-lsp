import { workspace, ExtensionContext } from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;

/** The server bundled with the extension, unless `i18n-lsp.serverPath` points elsewhere. */
function serverOptions(context: ExtensionContext): ServerOptions {
  const customPath = workspace.getConfiguration("i18n-lsp").get<string>("serverPath");
  if (customPath) {
    return { command: customPath, args: ["--stdio"] };
  }

  // Runs on VS Code's own Node runtime, so no Node or global install is needed.
  const module = context.asAbsolutePath("dist/server.js");
  return {
    run: { module, transport: TransportKind.ipc },
    debug: { module, transport: TransportKind.ipc, options: { execArgv: ["--nolazy", "--inspect=6009"] } },
  };
}

const SERVER_SETTINGS = [
  "translationFiles",
  "defaultLocale",
  "defaultNamespace",
  "functionPatterns",
  "keyStyle",
  "maxInlayLength",
  "reportUnusedKeys",
];

/** Settings the user set explicitly; anything unset is left to the server to detect. */
function serverSettings(): Record<string, unknown> {
  const config = workspace.getConfiguration("i18n-lsp", workspace.workspaceFolders?.[0]);
  const settings: Record<string, unknown> = {};
  for (const key of SERVER_SETTINGS) {
    const info = config.inspect(key);
    const value = info?.workspaceFolderValue ?? info?.workspaceValue ?? info?.globalValue;
    if (value !== undefined) settings[key] = value;
  }
  return settings;
}

export function activate(context: ExtensionContext) {
  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: "file", language: "typescript" },
      { scheme: "file", language: "typescriptreact" },
      { scheme: "file", language: "javascript" },
      { scheme: "file", language: "javascriptreact" },
      { scheme: "file", language: "vue" },
      { scheme: "file", language: "svelte" },
      { scheme: "file", language: "dart" },
      { scheme: "file", language: "json" },
    ],
    initializationOptions: serverSettings(),
  };

  client = new LanguageClient(
    "i18n-lsp",
    "i18n LSP",
    serverOptions(context),
    clientOptions
  );

  client.start();
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
