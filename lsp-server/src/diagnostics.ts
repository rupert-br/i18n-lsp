import {
  Diagnostic,
  DiagnosticSeverity,
  DiagnosticTag,
  Range,
  Position,
} from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import { analyzeDocument, resolveCall, preferredKey } from "./analysis";
import { Project } from "./project";

export const SOURCE = "i18n-lsp";

/**
 * Diagnostics for a source file:
 *  - Missing keys: key used in code but not found in any translation file
 *  - Partial translations: key exists but not in all locales
 *  - Template keys that match nothing
 */
export function provideDiagnostics(document: TextDocument, project: Project): Diagnostic[] {
  const { store, config } = project;
  const analysis = analyzeDocument(document, config);
  const diagnostics: Diagnostic[] = [];

  // No translation files (yet): this may not be an i18n project at all.
  if (store.allLocales().length === 0) return diagnostics;

  for (const call of analysis.calls) {
    const range = Range.create(
      Position.create(call.line, call.keyStart),
      Position.create(call.line, call.keyEnd)
    );
    const resolved = resolveCall(call, analysis.namespaces, store);

    if (call.dynamic) {
      // For template-literal keys, warn only if no candidate keys exist.
      if (resolved.length === 0) {
        diagnostics.push({
          range,
          severity: DiagnosticSeverity.Warning,
          source: SOURCE,
          message: `No keys match template: "${call.key}"`,
          code: "no-dynamic-matches",
          data: { key: call.key },
        });
      }
      continue;
    }

    const key = preferredKey(resolved);
    if (!key) {
      diagnostics.push({
        range,
        severity: DiagnosticSeverity.Error,
        source: SOURCE,
        message: `Missing translation key: "${call.key}"`,
        code: "missing-key",
        data: { key: call.key, canonicalKey: store.canonicalForNew(call.key, analysis.namespaces) },
      });
      continue;
    }

    // Key exists — check if it's in all locales of its namespace
    const present = store.getEntries(key);
    const missingLocales = store
      .allLocales(store.namespaceOf(key))
      .filter((l) => !present?.has(l));
    if (missingLocales.length > 0) {
      diagnostics.push({
        range,
        severity: DiagnosticSeverity.Warning,
        source: SOURCE,
        message: `Key "${call.key}" missing in locales: ${missingLocales.join(", ")}`,
        code: "partial-translation",
        data: { key, missingLocales },
      });
    }
  }

  return diagnostics;
}

/**
 * Diagnostics for a translation file:
 *  - Unused keys (faded out, never an error) when no source file references them
 *  - In the default locale's file: keys that other locales don't have yet
 */
export function provideTranslationFileDiagnostics(
  filePath: string,
  project: Project
): Diagnostic[] {
  const { store, config, usage } = project;
  const diagnostics: Diagnostic[] = [];

  // Without any recognized call the usage data says nothing (e.g. generated
  // Flutter accessors): don't flag every key as unused.
  const checkUnused = config.reportUnusedKeys && usage.ready && usage.hasAnyCalls();

  for (const { key, locale, entry } of store.entriesForFile(filePath)) {
    const loc = entry.location;
    const range = Range.create(
      Position.create(loc.line, loc.character),
      Position.create(loc.endLine, loc.endCharacter)
    );

    if (checkUnused && !usage.isUsed(key)) {
      diagnostics.push({
        range,
        severity: DiagnosticSeverity.Hint,
        tags: [DiagnosticTag.Unnecessary],
        source: SOURCE,
        message: `Translation key "${key}" is not used in any source file`,
        code: "unused-key",
        data: { key },
      });
    }

    if (locale === config.defaultLocale) {
      const present = store.getEntries(key);
      const missingLocales = store
        .allLocales(store.namespaceOf(key))
        .filter((l) => !present?.has(l));
      if (missingLocales.length > 0) {
        diagnostics.push({
          range,
          severity: DiagnosticSeverity.Warning,
          source: SOURCE,
          message: `Key "${key}" missing in locales: ${missingLocales.join(", ")}`,
          code: "missing-locales",
          data: { key, missingLocales },
        });
      }
    }
  }

  return diagnostics;
}
