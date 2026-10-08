import { CodeAction, CodeActionKind, CodeActionParams } from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import { buildInsertKeyEdit, buildRemoveKeyEdit } from "./translationEdits";
import { provideExtractAction } from "./extract";
import { SOURCE } from "./diagnostics";
import { Project } from "./project";

const PLACEHOLDER = "TODO";

export function provideCodeActions(
  params: CodeActionParams,
  doc: TextDocument | undefined,
  fsPath: string,
  project: Project
): CodeAction[] {
  const { store } = project;
  const actions: CodeAction[] = [];

  for (const diag of params.context.diagnostics) {
    if (diag.source !== SOURCE) continue;

    if (diag.code === "missing-key") {
      const data = diag.data as { key: string; canonicalKey?: string } | undefined;
      if (!data?.key) continue;
      const canonical = data.canonicalKey ?? data.key;

      const edit = buildInsertKeyEdit(
        project,
        canonical,
        store.allLocales(store.namespaceOf(canonical)),
        () => PLACEHOLDER
      );
      if (edit) {
        actions.push({
          title: `Add "${data.key}" to all translation files`,
          kind: CodeActionKind.QuickFix,
          diagnostics: [diag],
          isPreferred: true,
          edit,
        });
      }
    }

    if (diag.code === "partial-translation" || diag.code === "missing-locales") {
      const data = diag.data as { key: string; missingLocales: string[] } | undefined;
      if (!data?.key || !data?.missingLocales) continue;

      const edit = buildInsertKeyEdit(project, data.key, data.missingLocales, () => PLACEHOLDER);
      if (edit) {
        actions.push({
          title: `Add "${data.key}" to ${data.missingLocales.join(", ")}`,
          kind: CodeActionKind.QuickFix,
          diagnostics: [diag],
          isPreferred: true,
          edit,
        });
      }
    }

    if (diag.code === "unused-key") {
      const data = diag.data as { key: string } | undefined;
      if (!data?.key) continue;

      const edit = buildRemoveKeyEdit(project, data.key);
      if (edit) {
        actions.push({
          title: `Remove unused key "${data.key}" from all translation files`,
          kind: CodeActionKind.QuickFix,
          diagnostics: [diag],
          edit,
        });
      }
    }
  }

  if (doc && !store.isTranslationFile(fsPath)) {
    const wantsRefactor =
      !params.context.only || params.context.only.some((k) => CodeActionKind.RefactorExtract.startsWith(k));
    if (wantsRefactor) {
      const extract = provideExtractAction(params, doc, fsPath, project);
      if (extract) actions.push(extract);
    }
  }

  return actions;
}
