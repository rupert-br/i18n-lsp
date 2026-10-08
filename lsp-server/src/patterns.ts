import { I18nConfig } from "./config";

export interface TranslationCall {
  /** The key as written in code, e.g. "welcome.back" or "common:welcome".
   * May contain ${…} placeholders when detected inside a template literal. */
  key: string;
  /** True if the key was a template literal containing ${…} placeholders. */
  dynamic: boolean;
  /** Start offset of the key string in its line */
  keyStart: number;
  /** End offset of the key string in its line */
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
 * Replace the contents of comments with spaces (keeping newlines and every
 * offset intact) so call detection doesn't fire on commented-out code.
 *
 * Understands line comments, block comments and HTML comments, and skips
 * over string literals so
 * that `'http://x'` isn't mistaken for a comment. Single/double-quoted
 * strings end at a newline, which bounds the damage of a stray apostrophe in
 * markup text to one line.
 */
export function maskComments(text: string): string {
  let out = "";
  let last = 0;
  const n = text.length;

  const blank = (from: number, to: number) => {
    out += text.slice(last, from) + text.slice(from, to).replace(/[^\r\n]/g, " ");
    last = to;
  };

  let i = 0;
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];

    if (c === "'" || c === '"') {
      i++;
      while (i < n && text[i] !== c && text[i] !== "\n") {
        i += text[i] === "\\" ? 2 : 1;
      }
      i++;
    } else if (c === "`") {
      i++;
      while (i < n && text[i] !== "`") {
        i += text[i] === "\\" ? 2 : 1;
      }
      i++;
    } else if (c === "/" && next === "/") {
      let end = text.indexOf("\n", i);
      if (end < 0) end = n;
      blank(i, end);
      i = end;
    } else if (c === "/" && next === "*") {
      const close = text.indexOf("*/", i + 2);
      const end = close < 0 ? n : close + 2;
      blank(i, end);
      i = end;
    } else if (c === "<" && text.startsWith("<!--", i)) {
      const close = text.indexOf("-->", i + 4);
      const end = close < 0 ? n : close + 3;
      blank(i, end);
      i = end;
    } else {
      i++;
    }
  }

  return last === 0 ? text : out + text.slice(last);
}

/**
 * Build a combined regex that matches any of the configured function patterns.
 *
 * Matches patterns like:
 *   t('some.key')       t("some.key")       t(\n  'some.key'\n)
 *   $t('some.key')      i18n.t('some.key')
 *   intl.formatMessage({id: 'some.key'})
 *   <Trans i18nKey="some.key" />
 *
 * Every alternative ends at the key's closing quote, which is what lets
 * callers locate the key without searching for it.
 */
export function buildPatternRegex(config: I18nConfig): RegExp {
  // Matches a key inside single, double, or backtick quotes.
  // Backtick form allows ${...} placeholders for dynamic keys.
  const keyCapture = "['\"`]([^'\"`\\r\\n]+)['\"`]";
  // The key must be the whole argument: rejects t('prefix.' + suffix).
  const argEnd = "(?=\\s*[,)}])";
  // Reject when preceded by an identifier char, so `t(` doesn't match
  // inside e.g. `document.createElement('canvas')`.
  const boundary = "(?<![\\w$])";

  const alternatives = config.functionPatterns.map((pattern) => {
    // Normalize: only take up through the first "(" so users can write
    // either "$t(", "$t('", or "intl.formatMessage({id: '" — everything
    // past the opening paren is handled by the regex tail below.
    const parenIdx = pattern.indexOf("(");
    const core = parenIdx >= 0 ? pattern.slice(0, parenIdx + 1) : pattern;
    const escaped = core.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    if (core.includes("formatMessage")) {
      return boundary + escaped + `\\s*\\{\\s*id\\s*:\\s*` + keyCapture + argEnd;
    }

    // Standard: t('key') / t("key") / t(`key_${x}`) / $t(key: 'key')
    return boundary + escaped + `\\s*(?:key\\s*:\\s*)?` + keyCapture + argEnd;
  });

  // react-i18next: <Trans i18nKey="some.key" /> or i18nKey={'some.key'}
  alternatives.push(boundary + "i18nKey\\s*=\\s*\\{?\\s*" + keyCapture);

  return new RegExp(`(?:${alternatives.join("|")})`, "g");
}

/** Start offsets of every line in `text`. */
export function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function lineOf(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function callFromMatch(
  match: RegExpExecArray,
  lineStarts: number[] | null,
  fixedLine: number
): TranslationCall | null {
  // The key is in whichever capture group matched (one per alternative)
  const key = match.slice(1).find((g) => g !== undefined);
  if (!key) return null;

  // Every alternative ends at the key's closing quote.
  const absEnd = match.index + match[0].length - 1;
  const absStart = absEnd - key.length;

  if (!lineStarts) {
    return {
      key,
      dynamic: key.includes("${"),
      keyStart: absStart,
      keyEnd: absEnd,
      line: fixedLine,
    };
  }

  const line = lineOf(lineStarts, absStart);
  return {
    key,
    dynamic: key.includes("${"),
    keyStart: absStart - lineStarts[line],
    keyEnd: absEnd - lineStarts[line],
    line,
  };
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
    const call = callFromMatch(match, null, lineNumber);
    if (call) calls.push(call);
  }

  return calls;
}

/**
 * Find all translation calls in a document. Works on the whole text so calls
 * split over several lines are found, with comments masked out.
 */
export function findAllTranslationCalls(
  text: string,
  config: I18nConfig,
  regex?: RegExp
): TranslationCall[] {
  const re = regex ?? buildPatternRegex(config);
  const masked = maskComments(text);
  const lineStarts = computeLineStarts(text);
  const calls: TranslationCall[] = [];

  re.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(masked)) !== null) {
    const call = callFromMatch(match, lineStarts, 0);
    if (call) calls.push(call);
  }
  re.lastIndex = 0;

  return calls;
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
  return (
    findAllTranslationCalls(text, config, regex).find(
      (c) => c.line === line && character >= c.keyStart && character <= c.keyEnd
    ) ?? null
  );
}

/**
 * Namespaces declared with react-i18next's `useTranslation('ns')` or
 * `useTranslation(['a', 'b'])`. Unprefixed keys in that file resolve
 * against them first.
 */
export function findNamespaces(text: string): string[] {
  const masked = maskComments(text);
  const found: string[] = [];
  const hook = /\buseTranslation\s*\(\s*(\[[^\]]*\]|['"`][^'"`\r\n]+['"`])/g;
  let m: RegExpExecArray | null;
  while ((m = hook.exec(masked)) !== null) {
    const str = /['"`]([^'"`\r\n]+)['"`]/g;
    let s: RegExpExecArray | null;
    while ((s = str.exec(m[1])) !== null) {
      if (!found.includes(s[1])) found.push(s[1]);
    }
  }
  return found;
}
