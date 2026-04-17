import { describe, it, expect } from "vitest";
import { extractLocale, isTranslationFile } from "../config";

const defaultConfig = {
  translationFiles: "src/locales/{locale}.json",
  defaultLocale: "en",
  functionPatterns: ["t("],
  keyStyle: "nested" as const,
  hoverLocales: [],
  maxInlayLength: 50,
};

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
