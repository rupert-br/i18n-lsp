import { Hover, HoverParams, MarkupKind } from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import { analyzeDocument, callAtPosition, resolveCall, preferredKey } from "./analysis";
import { formatLocaleTable } from "./utils";
import { Project } from "./project";

/**
 * Shows all locale translations on hover over a key.
 *
 * Renders a markdown table:
 *   | Locale | Translation          |
 *   |--------|----------------------|
 *   | en ●   | Welcome back         |
 *   | de     | Willkommen zurück    |
 *   | fr     | Bienvenue            |
 */
export function provideHover(
  params: HoverParams,
  document: TextDocument,
  project: Project
): Hover | null {
  const { store, config } = project;
  const analysis = analyzeDocument(document, config);
  const call = callAtPosition(analysis, params.position.line, params.position.character);
  if (!call) return null;

  const resolved = resolveCall(call, analysis.namespaces, store);

  if (call.dynamic) {
    if (resolved.length === 0) {
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: `⚠️ **\`${call.key}\`** — no keys match this template`,
        },
      };
    }
    const lines = [
      `### 🌐 \`${call.key}\` — ${resolved.length} matches`,
      "",
      `| Key | ${config.defaultLocale} |`,
      "|-----|------|",
    ];
    for (const key of resolved) {
      const value = store.get(key) ?? "—";
      lines.push(`| \`${key}\` | ${value} |`);
    }
    return {
      contents: { kind: MarkupKind.Markdown, value: lines.join("\n") },
    };
  }

  const key = preferredKey(resolved);
  const translations = key ? store.getAll(key) : undefined;
  if (!key || !translations) {
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: `⚠️ **${call.key}** — no translations found`,
      },
    };
  }

  return {
    contents: {
      kind: MarkupKind.Markdown,
      value: formatLocaleTable(key, translations, config.defaultLocale),
    },
  };
}
