import {
  Diagnostic,
  DiagnosticSeverity,
  Range,
  Position,
} from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import { TranslationStore } from "./translationIndex";
import { findAllTranslationCalls, expandDynamicKey } from "./patterns";
import { I18nConfig } from "./config";

/**
 * Produces diagnostics for:
 *  - Missing keys: key used in code but not found in any translation file
 *  - Partial translations: key exists but not in all locales
 */
export function provideDiagnostics(
  document: TextDocument,
  store: TranslationStore,
  config: I18nConfig
): Diagnostic[] {
  const text = document.getText();
  const calls = findAllTranslationCalls(text, config);
  const diagnostics: Diagnostic[] = [];
  const allLocales = store.allLocales();

  for (const call of calls) {
    if (call.dynamic) {
      // For template-literal keys, warn only if no candidate keys exist.
      const matches = expandDynamicKey(call.key, store.allKeys());
      if (matches.length === 0) {
        diagnostics.push({
          range: Range.create(
            Position.create(call.line, call.keyStart),
            Position.create(call.line, call.keyEnd)
          ),
          severity: DiagnosticSeverity.Warning,
          source: "i18n-lsp",
          message: `No keys match template: "${call.key}"`,
          code: "no-dynamic-matches",
          data: { key: call.key },
        });
      }
      continue;
    }
    if (!store.has(call.key)) {
      // Key doesn't exist at all
      diagnostics.push({
        range: Range.create(
          Position.create(call.line, call.keyStart),
          Position.create(call.line, call.keyEnd)
        ),
        severity: DiagnosticSeverity.Error,
        source: "i18n-lsp",
        message: `Missing translation key: "${call.key}"`,
        code: "missing-key",
        data: { key: call.key },
      });
    } else {
      // Key exists — check if it's in all locales
      const translations = store.getAll(call.key);
      if (translations) {
        const missingLocales = allLocales.filter(
          (l) => !translations.has(l)
        );
        if (missingLocales.length > 0) {
          diagnostics.push({
            range: Range.create(
              Position.create(call.line, call.keyStart),
              Position.create(call.line, call.keyEnd)
            ),
            severity: DiagnosticSeverity.Warning,
            source: "i18n-lsp",
            message: `Key "${call.key}" missing in locales: ${missingLocales.join(", ")}`,
            code: "partial-translation",
            data: { key: call.key, missingLocales },
          });
        }
      }
    }
  }

  return diagnostics;
}
