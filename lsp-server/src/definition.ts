import { DefinitionParams, Location, Range, Position } from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import { analyzeDocument, callAtPosition, resolveCall, preferredKey } from "./analysis";
import { Project } from "./project";

/**
 * Jump from a translation key usage to its definition in the translation files.
 *
 * Returns the exact key position in every locale's file, default locale
 * first, so editors can jump straight to it or offer the others.
 */
export function provideDefinition(
  params: DefinitionParams,
  document: TextDocument,
  project: Project
): Location[] | null {
  const analysis = analyzeDocument(document, project.config);
  const call = callAtPosition(analysis, params.position.line, params.position.character);
  if (!call || call.dynamic) return null;

  const key = preferredKey(resolveCall(call, analysis.namespaces, project.store));
  if (!key) return null;

  const locations = project.store.findKeyLocations(key).map((loc) => ({
    uri: URI.file(loc.filePath).toString(),
    range: Range.create(
      Position.create(loc.line, loc.character),
      Position.create(loc.endLine, loc.endCharacter)
    ),
  }));

  return locations.length > 0 ? locations : null;
}
