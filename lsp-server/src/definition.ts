import {
  DefinitionParams,
  Location,
  Range,
  Position,
} from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import { TranslationStore } from "./translationIndex";
import { findTranslationCallAtPosition } from "./patterns";
import { I18nConfig } from "./config";

/**
 * Jump from a translation key usage to its definition in the translation file.
 *
 * Uses the default locale's translation file. If the key is found,
 * returns the exact line/column in the JSON/YAML file.
 */
export function provideDefinition(
  params: DefinitionParams,
  document: TextDocument,
  store: TranslationStore,
  config: I18nConfig
): Location | null {
  const text = document.getText();
  const call = findTranslationCallAtPosition(
    text,
    params.position.line,
    params.position.character,
    config
  );

  if (!call) return null;
  if (call.dynamic) return null;

  const location = store.findKeyLocation(call.key);
  if (!location) return null;

  return {
    uri: URI.file(location.filePath).toString(),
    range: Range.create(
      Position.create(location.line, location.character),
      Position.create(location.line, location.character + call.key.length)
    ),
  };
}
