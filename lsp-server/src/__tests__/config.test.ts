import { describe, it, expect } from "vitest";
import {
  extractLocale,
  isTranslationFile,
  matchTranslationPath,
  normalizeConfig,
  readConfig,
  getTranslationGlobs,
} from "../config";
import { testConfig } from "./helpers";

const defaultConfig = testConfig({ translationFiles: "src/locales/{locale}.json", functionPatterns: ["t("] });

describe("extractLocale", () => {
  it("extracts locale from matching path", () => {
    expect(extractLocale("src/locales/en.json", defaultConfig)).toBe("en");
    expect(extractLocale("src/locales/de.json", defaultConfig)).toBe("de");
    expect(extractLocale("src/locales/fr-CA.json", defaultConfig)).toBe("fr-CA");
  });

  it("returns null for non-matching path", () => {
    expect(extractLocale("src/other/en.json", defaultConfig)).toBeNull();
    expect(extractLocale("README.md", defaultConfig)).toBeNull();
  });
});

describe("isTranslationFile", () => {
  it("returns true for translation files", () => {
    expect(isTranslationFile("src/locales/en.json", defaultConfig)).toBe(true);
  });

  it("returns false for non-translation files", () => {
    expect(isTranslationFile("src/app.ts", defaultConfig)).toBe(false);
  });
});

describe("matchTranslationPath", () => {
  it("anchors to the project root when one is given", () => {
    expect(matchTranslationPath("/proj/src/locales/en.json", defaultConfig, "/proj")?.locale).toBe("en");
    // Same suffix in a nested package is a different project's file.
    expect(matchTranslationPath("/proj/node_modules/x/src/locales/en.json", defaultConfig, "/proj")).toBeNull();
    expect(matchTranslationPath("/elsewhere/src/locales/en.json", defaultConfig, "/proj")).toBeNull();
  });

  it("supports {namespace} and directory layouts", () => {
    const config = testConfig({ translationFiles: "public/locales/{locale}/{namespace}.json" });
    expect(matchTranslationPath("/p/public/locales/de/common.json", config, "/p")).toEqual({
      locale: "de",
      namespace: "common",
    });
  });

  it("supports ** and * in patterns", () => {
    const config = testConfig({ translationFiles: "packages/**/i18n/{locale}.json" });
    expect(extractLocale("/r/packages/web/app/i18n/fr.json", config, "/r")).toBe("fr");
    expect(extractLocale("/r/packages/i18n/fr.json", config, "/r")).toBe("fr");
    expect(extractLocale("/r/other/i18n/fr.json", config, "/r")).toBeNull();
  });

  it("requires repeated {locale} placeholders to agree", () => {
    const config = testConfig({ translationFiles: "l10n/{locale}/app_{locale}.arb" });
    expect(extractLocale("l10n/de/app_de.arb", config)).toBe("de");
    expect(extractLocale("l10n/de/app_en.arb", config)).toBeNull();
  });

  it("tries every configured pattern", () => {
    const config = testConfig({ translationFiles: ["a/{locale}.json", "b/{locale}.yml"] });
    expect(extractLocale("b/de.yml", config)).toBe("de");
  });

  it("turns placeholders into wildcards for discovery", () => {
    const config = testConfig({ translationFiles: ["a/{locale}/{namespace}.json"] });
    expect(getTranslationGlobs(config)).toEqual(["a/*/*.json"]);
  });
});

describe("normalizeConfig", () => {
  it("accepts a string or an array for translationFiles", () => {
    expect(normalizeConfig({ translationFiles: "x/{locale}.json" }).config.translationFiles).toEqual(["x/{locale}.json"]);
    expect(normalizeConfig({ translationFiles: ["a/{locale}.json", "b/{locale}.json"] }).config.translationFiles).toHaveLength(2);
  });

  it("falls back to defaults and warns on invalid values", () => {
    const { config, warnings } = normalizeConfig({
      keyStyle: "weird",
      maxInlayLength: -3,
      functionPatterns: "t(",
      defaultLocale: "",
      reportUnusedKeys: "yes",
    });
    expect(config.keyStyle).toBe("nested");
    expect(config.maxInlayLength).toBe(50);
    expect(config.functionPatterns).toContain("t(");
    expect(config.defaultLocale).toBe("en");
    expect(config.reportUnusedKeys).toBe(true);
    expect(warnings).toHaveLength(5);
  });

  it("warns about unknown options and patterns without {locale}", () => {
    const { config, warnings } = normalizeConfig({ translationFile: "x", translationFiles: ["nolocale.json"] });
    expect(warnings.some((w) => w.includes('Unknown option "translationFile"'))).toBe(true);
    expect(warnings.some((w) => w.includes("no {locale}"))).toBe(true);
    expect(config.translationFiles).toEqual(["src/locales/{locale}.json"]);
  });

  it("does not share mutable defaults between calls", () => {
    normalizeConfig(undefined).config.functionPatterns.push("custom(");
    expect(normalizeConfig(undefined).config.functionPatterns).not.toContain("custom(");
  });
});

describe("readConfig", () => {
  it("reads comments and trailing commas", () => {
    const result = readConfig("/does/not/matter", '{ // c\n "defaultLocale": "de", }');
    expect(result.parseError).toBe(false);
    expect(result.config.defaultLocale).toBe("de");
  });

  it("flags unparseable text", () => {
    const result = readConfig("/does/not/matter", '{ "defaultLocale": ');
    expect(result.parseError).toBe(true);
    expect(result.warnings[0]).toContain("Failed to parse");
  });

  it("uses defaults when there is no file", () => {
    const result = readConfig("/definitely/not/a/real/dir");
    expect(result.parseError).toBe(false);
    expect(result.config.defaultLocale).toBe("en");
  });
});
