import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, execFileSync, ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  MessageConnection,
  InitializeRequest,
  InitializedNotification,
  ShutdownRequest,
  ExitNotification,
  DidOpenTextDocumentNotification,
  DidChangeTextDocumentNotification,
  PublishDiagnosticsNotification,
  InlayHintRequest,
  InlayHintRefreshRequest,
  RenameRequest,
  DefinitionRequest,
  ExecuteCommandRequest,
  Diagnostic,
} from "vscode-languageserver/node";

const SERVER_DIR = path.resolve(__dirname, "../..");
const SERVER_JS = path.join(SERVER_DIR, "dist/server.js");

let root: string;
let proc: ChildProcess;
let conn: MessageConnection;
const diagnostics = new Map<string, Diagnostic[]>();
let inlayRefreshes = 0;

const uri = (rel: string) => `file://${path.join(root, rel)}`;
const write = (rel: string, content: string) => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
};

async function waitFor<T>(
  fn: () => T | undefined | false | Promise<T | undefined | false>,
  what: string,
  timeoutMs = 10000
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

const open = (rel: string, text: string, languageId = "typescript") =>
  conn.sendNotification(DidOpenTextDocumentNotification.type, {
    textDocument: { uri: uri(rel), languageId, version: 1, text },
  });

const hintsFor = (rel: string, lastLine = 20) =>
  conn.sendRequest(InlayHintRequest.type, {
    textDocument: { uri: uri(rel) },
    range: { start: { line: 0, character: 0 }, end: { line: lastLine, character: 0 } },
  });

/** Poll inlay hints until `predicate` accepts them (the index loads asynchronously). */
async function waitForHints(rel: string, predicate: (labels: string[]) => boolean, what: string) {
  return waitFor(async () => {
    const hints = (await hintsFor(rel)) ?? [];
    const labels = hints.map((h) => String(h.label));
    return predicate(labels) ? hints : undefined;
  }, what);
}

beforeAll(async () => {
  // Build the real server, exactly as it ships.
  execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], { cwd: SERVER_DIR, stdio: "pipe" });

  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "i18n-lsp-e2e-")));
  write(".i18n-lsp.json", '{\n  // comments are fine\n  "translationFiles": "locales/{locale}.json",\n}\n');
  write("locales/en.json", '{\n  "greet": { "hi": "Hello", "bye": "Goodbye" },\n  "orphan": "unused"\n}\n');
  write("locales/de.json", '{\n  "greet": { "hi": "Hallo" }\n}\n');
  write("src/app.ts", "t('greet.hi');\n");

  // A package with its own config inside the same workspace.
  write("packages/web/.i18n-lsp.json", '{ "translationFiles": "i18n/{locale}.json" }');
  write("packages/web/i18n/en.json", '{ "web": { "title": "Web" } }');
  write("packages/web/src/page.ts", "t('web.title');\n");

  proc = spawn(process.execPath, [SERVER_JS, "--stdio"], { stdio: ["pipe", "pipe", "inherit"] });
  conn = createMessageConnection(new StreamMessageReader(proc.stdout!), new StreamMessageWriter(proc.stdin!));
  conn.onNotification(PublishDiagnosticsNotification.type, (p) => diagnostics.set(p.uri, p.diagnostics));
  conn.onRequest(InlayHintRefreshRequest.type, () => {
    inlayRefreshes++;
  });
  conn.onNotification("window/logMessage", () => {});
  conn.onNotification("window/showMessage", () => {});
  conn.onRequest("window/showMessageRequest", () => null);
  conn.listen();

  const init = await conn.sendRequest(InitializeRequest.type, {
    processId: process.pid,
    rootUri: `file://${root}`,
    workspaceFolders: [{ uri: `file://${root}`, name: "root" }],
    capabilities: { workspace: { inlayHint: { refreshSupport: true } } },
  });
  expect(init.capabilities.renameProvider).toBeTruthy();
  await conn.sendNotification(InitializedNotification.type, {});
}, 60000);

afterAll(async () => {
  try {
    await conn.sendRequest(ShutdownRequest.type);
    conn.sendNotification(ExitNotification.type);
  } catch {
    proc.kill();
  }
  conn.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("i18n-lsp over stdio", () => {
  it("serves inlay hints from the indexed translation files", async () => {
    open("src/app.ts", "t('greet.hi');\n");
    const hints = await waitForHints("src/app.ts", (l) => l.length > 0, "inlay hints");
    expect(String(hints[0].label)).toBe('→ en: "Hello" | de: "Hallo"');
  });

  it("applies incremental edits and re-diagnoses", async () => {
    await waitFor(() => diagnostics.has(uri("src/app.ts")), "initial diagnostics");

    // Replace `greet.hi` (line 0, chars 3..11) with a key that doesn't exist.
    conn.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri: uri("src/app.ts"), version: 2 },
      contentChanges: [{ range: { start: { line: 0, character: 3 }, end: { line: 0, character: 11 } }, text: "nope.key" }],
    });
    const diags = await waitFor(() => {
      const d = diagnostics.get(uri("src/app.ts"));
      return d?.some((x) => x.code === "missing-key") ? d : undefined;
    }, "missing-key diagnostic");
    expect(diags[0].message).toContain("nope.key");

    // And back again.
    conn.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri: uri("src/app.ts"), version: 3 },
      contentChanges: [{ range: { start: { line: 0, character: 3 }, end: { line: 0, character: 11 } }, text: "greet.bye" }],
    });
    await waitFor(() => diagnostics.get(uri("src/app.ts"))?.every((x) => x.code !== "missing-key"), "diagnostic cleared");
  });

  it("picks up translation changes made on disk and asks the client to refresh hints", async () => {
    const before = inlayRefreshes;
    write("locales/de.json", '{\n  "greet": { "hi": "Hallo", "bye": "Tschüss" }\n}\n');
    await waitForHints("src/app.ts", (l) => l.some((x) => x.includes("Tschüss")), "hint with new German text");
    await waitFor(() => inlayRefreshes > before, "inlayHint/refresh request");
    // The partial-translation warning for greet.bye is gone.
    await waitFor(() => !diagnostics.get(uri("src/app.ts"))?.some((x) => x.code === "partial-translation"), "partial warning cleared");
  });

  it("reports unused keys in an open translation file", async () => {
    open("locales/en.json", fs.readFileSync(path.join(root, "locales/en.json"), "utf-8"), "json");
    const diags = await waitFor(() => {
      const d = diagnostics.get(uri("locales/en.json"));
      return d?.some((x) => x.code === "unused-key") ? d : undefined;
    }, "unused-key diagnostic");
    // The open buffer of app.ts now uses greet.bye, so greet.hi is unused too —
    // unsaved edits count, not just what's on disk.
    expect(diags.filter((d) => d.code === "unused-key").map((d) => d.message)).toEqual([
      expect.stringContaining('"greet.hi"'),
      expect.stringContaining('"orphan"'),
    ]);
  });

  it("finds definitions with exact positions", async () => {
    const locations = await conn.sendRequest(DefinitionRequest.type, {
      textDocument: { uri: uri("src/app.ts") },
      position: { line: 0, character: 5 },
    });
    const first = Array.isArray(locations) ? locations[0] : locations;
    expect(first).toMatchObject({ uri: uri("locales/en.json") });
  });

  it("renames a key across code and every locale file", async () => {
    const edit = await conn.sendRequest(RenameRequest.type, {
      textDocument: { uri: uri("src/app.ts") },
      position: { line: 0, character: 5 },
      newName: "greet.farewell",
    });
    expect(Object.keys(edit!.changes!).sort()).toEqual(
      [uri("locales/de.json"), uri("locales/en.json"), uri("src/app.ts")].sort()
    );
  });

  it("uses the nearest .i18n-lsp.json for files in a sub-package", async () => {
    open("packages/web/src/page.ts", "t('web.title');\n");
    const hints = await waitForHints("packages/web/src/page.ts", (l) => l.length > 0, "sub-package hints");
    expect(String(hints[0].label)).toBe('→ en: "Web"');
    // The root package's keys are not visible here, and vice versa.
    await waitFor(() => diagnostics.has(uri("packages/web/src/page.ts")), "diagnostics for sub-package");
    expect(diagnostics.get(uri("packages/web/src/page.ts"))!.filter((d) => d.code === "missing-key")).toEqual([]);
  });

  it("reloads when .i18n-lsp.json changes", async () => {
    write(".i18n-lsp.json", '{ "translationFiles": "locales/{locale}.json", "defaultLocale": "de" }\n');
    const hints = await waitForHints("src/app.ts", (l) => l[0]?.startsWith("→ de:"), "hints in the new default locale");
    expect(String(hints[0].label)).toContain("→ de:");
  });

  it("answers the report command", async () => {
    // The previous test reloaded the project; its usage index may still be loading.
    const unused = await waitFor(async () => {
      const result = (await conn.sendRequest(ExecuteCommandRequest.type, { command: "i18n-lsp.report" })) as {
        projects: Array<{ root: string; unusedKeys: Array<{ key: string }> }>;
      };
      const keys = result.projects.find((p) => p.root === root)?.unusedKeys.map((u) => u.key);
      return keys?.length ? keys : undefined;
    }, "unused keys in the report");
    expect(unused).toContain("orphan");
  });
});
