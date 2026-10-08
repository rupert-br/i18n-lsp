import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { TextDocument } from "vscode-languageserver-textdocument";
import { WorkspaceEdit } from "vscode-languageserver";
import { I18nConfig, normalizeConfig } from "../config";
import { Project } from "../project";

/** A fully-populated config with the given overrides applied. */
export function testConfig(overrides: Record<string, unknown> = {}): I18nConfig {
  return normalizeConfig(overrides).config;
}

export interface TestProject {
  project: Project;
  root: string;
  file(rel: string): string;
  doc(rel: string, text: string, languageId?: string): TextDocument;
  dispose(): void;
}

/**
 * Create a real project in a temp directory from a map of relative path → content,
 * and wait until its translations and source usages are indexed.
 */
export async function createProject(
  files: Record<string, string>,
  config: Record<string, unknown> = {}
): Promise<TestProject> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "i18n-lsp-test-")));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  const project = new Project(root, testConfig(config), {
    onTranslationsChanged: () => {},
    onUsagesChanged: () => {},
    onConfigFileChanged: () => {},
    log: () => {},
  });
  await project.initialize();

  return {
    project,
    root,
    file: (rel) => path.join(root, rel),
    doc: (rel, text, languageId = "typescript") =>
      TextDocument.create(`file://${path.join(root, rel)}`, languageId, 1, text),
    dispose: () => {
      project.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Apply a WorkspaceEdit's changes to the given file contents, returning new contents by uri. */
export function applyWorkspaceEdit(
  edit: WorkspaceEdit | null,
  contents: (uri: string) => string
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [uri, edits] of Object.entries(edit?.changes ?? {})) {
    const doc = TextDocument.create(uri, "plaintext", 1, contents(uri));
    result[uri] = TextDocument.applyEdits(doc, edits);
  }
  return result;
}

/** Edit result for one file path, reading its original contents from the project's store. */
export function editedFile(
  t: TestProject,
  edit: WorkspaceEdit | null,
  rel: string
): string | undefined {
  const uri = `file://${t.file(rel)}`;
  const out = applyWorkspaceEdit(edit, (u) => fs.readFileSync(u.replace("file://", ""), "utf-8"));
  return out[uri];
}
