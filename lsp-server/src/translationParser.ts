import { parseTree, Node as JsonNode, ParseError, getNodeValue } from "jsonc-parser";
import * as yaml from "yaml";

export interface KeyRange {
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
}

export interface ParsedEntry {
  /** Full dotted key path, without any namespace prefix */
  path: string;
  /** Translated value */
  value: string;
  /** Dotted path of the parent chain (empty for top-level keys) */
  prefix: string;
  /** Text of this entry's own key token (contains dots for flat keys) */
  name: string;
  /** Key tokens from the (unwrapped) root down to this entry */
  segments: string[];
  /** Range of the key token in the source, including quotes if present */
  range: KeyRange;
}

export interface ParseResult {
  entries: ParsedEntry[];
  /**
   * Set when the whole file is wrapped in a single top-level key equal to the
   * locale (Rails-style `en:` roots). The wrapper is stripped from entry paths.
   */
  wrapper: string | null;
}

/** Offset ↔ line/character conversion for a piece of text. */
export class LineMap {
  readonly lineStarts: number[] = [0];

  constructor(readonly text: string) {
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 10) {
        this.lineStarts.push(i + 1);
      } else if (c === 13) {
        if (text.charCodeAt(i + 1) === 10) i++;
        this.lineStarts.push(i + 1);
      }
    }
  }

  positionAt(offset: number): { line: number; character: number } {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo, character: offset - this.lineStarts[lo] };
  }

  offsetAt(line: number, character: number): number {
    return (this.lineStarts[line] ?? this.text.length) + character;
  }

  rangeOf(start: number, end: number): KeyRange {
    const s = this.positionAt(start);
    const e = this.positionAt(end);
    return { line: s.line, character: s.character, endLine: e.line, endCharacter: e.character };
  }
}

function normalizeLocale(s: string): string {
  return s.toLowerCase().replace(/_/g, "-");
}

function join(prefix: string, name: string): string {
  return prefix ? `${prefix}.${name}` : name;
}

/**
 * Parse a translation file into its leaf entries, with the exact location of
 * each key. Returns `null` when the content is not valid (e.g. while the user
 * is mid-edit), so callers can keep the last good state.
 */
export function parseTranslations(
  content: string,
  ext: string,
  locale: string
): ParseResult | null {
  const lower = ext.toLowerCase();
  if (lower === ".json" || lower === ".arb" || lower === ".jsonc") {
    return parseJson(content, locale);
  }
  if (lower === ".yml" || lower === ".yaml") {
    return parseYaml(content, locale);
  }
  return null;
}

// --- JSON ---

function parseJson(content: string, locale: string): ParseResult | null {
  if (content.trim() === "") return { entries: [], wrapper: null };

  const errors: ParseError[] = [];
  const root = parseTree(content, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !root) return null;
  if (root.type !== "object") return { entries: [], wrapper: null };

  const map = new LineMap(content);
  const entries: ParsedEntry[] = [];

  let start = root;
  let wrapper: string | null = null;
  const props = root.children ?? [];
  if (props.length === 1) {
    const [keyNode, valueNode] = props[0].children ?? [];
    if (
      keyNode &&
      valueNode?.type === "object" &&
      normalizeLocale(String(keyNode.value)) === normalizeLocale(locale)
    ) {
      wrapper = String(keyNode.value);
      start = valueNode;
    }
  }

  walkJson(start, "", [], map, entries);
  return { entries, wrapper };
}

function walkJson(
  node: JsonNode,
  prefix: string,
  segs: string[],
  map: LineMap,
  out: ParsedEntry[]
): void {
  for (const prop of node.children ?? []) {
    const [keyNode, valueNode] = prop.children ?? [];
    if (!keyNode || !valueNode) continue;

    const name = String(keyNode.value);
    if (prefix === "" && name.startsWith("@")) continue; // ARB metadata

    const fullPath = join(prefix, name);

    if (valueNode.type === "object") {
      walkJson(valueNode, fullPath, [...segs, name], map, out);
      continue;
    }
    if (valueNode.type === "null") continue;

    const value =
      valueNode.type === "array"
        ? String(getNodeValue(valueNode))
        : String(valueNode.value);

    out.push({
      path: fullPath,
      value,
      prefix,
      name,
      segments: [...segs, name],
      range: map.rangeOf(keyNode.offset, keyNode.offset + keyNode.length),
    });
  }
}

// --- YAML ---

function parseYaml(content: string, locale: string): ParseResult | null {
  if (content.trim() === "") return { entries: [], wrapper: null };

  let doc: yaml.Document.Parsed;
  try {
    doc = yaml.parseDocument(content, { prettyErrors: false });
  } catch {
    return null;
  }
  if (doc.errors.length > 0) return null;
  if (!yaml.isMap(doc.contents)) return { entries: [], wrapper: null };

  const map = new LineMap(content);
  const entries: ParsedEntry[] = [];

  let start: yaml.YAMLMap = doc.contents;
  let wrapper: string | null = null;
  if (start.items.length === 1) {
    const only = start.items[0];
    if (
      yaml.isScalar(only.key) &&
      yaml.isMap(only.value) &&
      normalizeLocale(String(only.key.value)) === normalizeLocale(locale)
    ) {
      wrapper = String(only.key.value);
      start = only.value;
    }
  }

  walkYaml(start, "", [], map, entries);
  return { entries, wrapper };
}

function walkYaml(
  node: yaml.YAMLMap,
  prefix: string,
  segs: string[],
  map: LineMap,
  out: ParsedEntry[]
): void {
  for (const pair of node.items) {
    if (!yaml.isScalar(pair.key)) continue;
    const name = String(pair.key.value);
    if (name === "<<") continue; // merge key
    if (prefix === "" && name.startsWith("@")) continue;

    const fullPath = join(prefix, name);
    const value = pair.value;

    if (yaml.isMap(value)) {
      walkYaml(value, fullPath, [...segs, name], map, out);
      continue;
    }
    if (yaml.isAlias(value) || value === null || value === undefined) continue;

    let text: string;
    if (yaml.isSeq(value)) {
      text = String(value.toJSON());
    } else if (yaml.isScalar(value)) {
      if (value.value === null || value.value === undefined) continue;
      text = String(value.value);
    } else {
      continue;
    }

    const range = pair.key.range;
    if (!range) continue;

    out.push({
      path: fullPath,
      value: text,
      prefix,
      name,
      segments: [...segs, name],
      range: map.rangeOf(range[0], range[1]),
    });
  }
}
