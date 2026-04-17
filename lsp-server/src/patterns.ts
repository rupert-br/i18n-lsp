import { I18nConfig } from "./config";

export interface TranslationCall {
  /** The full i18n key, e.g. "welcome.back". May contain ${…} placeholders
   * when detected inside a template literal. */
  key: string;
  /** True if the key was a template literal containing ${…} placeholders. */
  dynamic: boolean;
  /** Start offset of the key string in the line */
  keyStart: number;
  /** End offset of the key string in the line */
  keyEnd: number;
  /** Line number (0-based) */
  line: number;
}

/**
 * Expand a dynamic template key into all matching keys in the store.
 * `${...}` placeholders are treated as non-dot wildcards (so they don't
 * cross key segments). Returns the input unchanged for non-dynamic keys.
 */
export function expandDynamicKey(
  template: string,
  allKeys: string[]
): string[] {
  if (!template.includes("${")) return [template];
  const escaped = template
    .split(/\$\{[^}]*\}/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^.]+");
  const re = new RegExp(`^${escaped}$`);
  return allKeys.filter((k) => re.test(k));
}

/**
 * Build a combined regex that matches any of the configured function patterns.
 *
 * Matches patterns like:
 *   t('some.key')       t("some.key")
 *   $t('some.key')      i18n.t('some.key')
 *   intl.formatMessage({id: 'some.key'})
 *
 * This is a pragmatic regex approach. For production, consider using
 * tree-sitter queries for AST-accurate detection (avoids false positives
 * in comments, strings, etc.).
 */
export function buildPatternRegex(config: I18nConfig): RegExp {
  const alternatives = config.functionPatterns.map((pattern) => {
    // Normalize: only take up through the first "(" so users can write
    // either "$t(", "$t('", or "intl.formatMessage({id: '" — everything
    // past the opening paren is handled by the regex tail below.
    const parenIdx = pattern.indexOf("(");
    const core = parenIdx >= 0 ? pattern.slice(0, parenIdx + 1) : pattern;
    const escaped = core.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // Reject when preceded by an identifier char, so `t(` doesn't match
    // inside e.g. `document.createElement('canvas')`.
    const boundary = `(?<![\\w$])`;

    // Matches a key inside single, double, or backtick quotes.
    // Backtick form allows ${...} placeholders for dynamic keys.
    const keyCapture = "['\"`]([^'\"`]+)['\"`]";

    // intl.formatMessage({id: 'key'})
    if (core.includes("formatMessage")) {
      return boundary + escaped + `\\s*\\{\\s*id\\s*:\\s*` + keyCapture;
    }

    // Standard: t('key') / t("key") / t(`key_${x}`) / $t(key: 'key')
    return boundary + escaped + `\\s*(?:key\\s*:\\s*)?` + keyCapture;
  });

  return new RegExp(`(?:${alternatives.join("|")})`, "g");
}

/**
 * Find all translation calls in a single line of text.
 */
export function findTranslationCallsInLine(
  line: string,
  lineNumber: number,
  regex: RegExp
): TranslationCall[] {
  const calls: TranslationCall[] = [];
  regex.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(line)) !== null) {
    // The key is in whichever capture group matched (one per alternative)
    const key = match.slice(1).find((g) => g !== undefined);
    if (!key) continue;

    // Find the position of the key within the match
    const keyInMatch = match[0].indexOf(key);
    if (keyInMatch < 0) continue;
    const keyStart = match.index + keyInMatch;
    const keyEnd = keyStart + key.length;

    calls.push({
      key,
      dynamic: key.includes("${"),
      keyStart,
      keyEnd,
      line: lineNumber,
    });
  }

  return calls;
}

/**
 * Find all translation calls in a document.
 */
export function findAllTranslationCalls(
  text: string,
  config: I18nConfig,
  regex?: RegExp
): TranslationCall[] {
  const re = regex ?? buildPatternRegex(config);
  const lines = text.split("\n");
  const results: TranslationCall[] = [];

  for (let i = 0; i < lines.length; i++) {
    results.push(...findTranslationCallsInLine(lines[i], i, re));
  }

  return results;
}

/**
 * Find the translation call at a specific position (for hover/definition).
 */
export function findTranslationCallAtPosition(
  text: string,
  line: number,
  character: number,
  config: I18nConfig,
  regex?: RegExp
): TranslationCall | null {
  const lines = text.split("\n");
  if (line >= lines.length) return null;

  const re = regex ?? buildPatternRegex(config);
  const calls = findTranslationCallsInLine(lines[line], line, re);

  return (
    calls.find((c) => character >= c.keyStart && character <= c.keyEnd) ?? null
  );
}
