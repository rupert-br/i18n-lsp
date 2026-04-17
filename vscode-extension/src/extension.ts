import { workspace, ExtensionContext, window } from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
} from "vscode-languageclient/node";
import { execSync } from "child_process";

let client: LanguageClient | undefined;

function resolveServerPath(): string | null {
  const config = workspace.getConfiguration("i18n-lsp");
  const customPath = config.get<string>("serverPath");
  if (customPath) return customPath;

  // VS Code may not inherit nvm/shell PATH — resolve the full path
  try {
    return execSync("which i18n-lsp", { encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}

export function activate(context: ExtensionContext) {
  const serverPath = resolveServerPath();
  if (!serverPath) {
    window.showWarningMessage(
      "i18n-lsp not found. Install with: npm i -g i18n-lsp"
    );
    return;
  }

  const serverOptions: ServerOptions = {
    command: serverPath,
    args: ["--stdio"],
  };

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
  };

  client = new LanguageClient(
    "i18n-lsp",
    "i18n LSP",
    serverOptions,
    clientOptions
  );

  client.start();
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
