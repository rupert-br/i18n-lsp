import { TextDocument } from "vscode-languageserver-textdocument";
import { I18nConfig } from "./config";
import {
  TranslationCall,
  findAllTranslationCalls,
  findNamespaces,
  expandDynamicKey,
} from "./patterns";
import { getCachedPatternRegex } from "./utils";
import { TranslationStore } from "./translationIndex";

export interface DocumentAnalysis {
  calls: TranslationCall[];
  /** Namespaces declared via useTranslation(...) in this file */
  namespaces: string[];
}

export function analyzeText(text: string, config: I18nConfig): DocumentAnalysis {
  return {
    calls: findAllTranslationCalls(text, config, getCachedPatternRegex(config)),
    namespaces: findNamespaces(text),
  };
}

interface CacheEntry {
  version: number;
  patterns: string;
  analysis: DocumentAnalysis;
}

// TextDocument.update mutates in place, so the version is part of the cache check.
const cache = new WeakMap<TextDocument, CacheEntry>();

/** Analyze a document, reusing the previous result while its version is unchanged. */
export function analyzeDocument(doc: TextDocument, config: I18nConfig): DocumentAnalysis {
  const patterns = config.functionPatterns.join("\0");
  const hit = cache.get(doc);
  if (hit && hit.version === doc.version && hit.patterns === patterns) return hit.analysis;

  const analysis = analyzeText(doc.getText(), config);
  cache.set(doc, { version: doc.version, patterns, analysis });
  return analysis;
}

/** The call whose key string contains the given position. */
export function callAtPosition(
  analysis: DocumentAnalysis,
  line: number,
  character: number
): TranslationCall | null {
  return (
    analysis.calls.find(
      (c) => c.line === line && character >= c.keyStart && character <= c.keyEnd
    ) ?? null
  );
}

/**
 * Canonical store keys a call refers to: the resolved key (or plural family)
 * for static calls, every matching key for template-literal calls.
 */
export function resolveCall(
  call: TranslationCall,
  namespaces: string[],
  store: TranslationStore
): string[] {
  if (!call.dynamic) return store.resolveAll(call.key, namespaces);

  const matches = new Set<string>();
  for (const candidate of store.candidateKeys(call.key, namespaces)) {
    for (const key of expandDynamicKey(candidate, store.allKeys())) matches.add(key);
  }
  return Array.from(matches);
}

/** Pick the key to show for a resolved static call (prefers plural `_other`). */
export function preferredKey(keys: string[]): string | undefined {
  return keys.find((k) => k.endsWith("_other")) ?? keys[0];
}
