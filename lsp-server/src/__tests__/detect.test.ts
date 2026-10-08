import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pickTranslationPattern, pickDefaultLocale, detectConfig } from "../detect";
import { readConfig } from "../config";

describe("pickTranslationPattern", () => {
  it("detects one file per locale", () => {
    expect(
      pickTranslationPattern(["package.json", "src/locales/en.json", "src/locales/de.json"])
    ).toEqual({ translationFiles: "src/locales/{locale}.json", locales: ["de", "en"], namespaces: [] });
  });

  it("detects prefixed file names", () => {
    expect(
      pickTranslationPattern(["lib/l10n/app_en.arb", "lib/l10n/app_pt_BR.arb"])?.translationFiles
    ).toBe("lib/l10n/app_{locale}.arb");
  });

  it("detects region locales without mistaking them for a prefix", () => {
    expect(pickTranslationPattern(["i18n/pt-BR.yml", "i18n/en-US.yml"])).toEqual({
      translationFiles: "i18n/{locale}.yml",
      locales: ["en-US", "pt-BR"],
      namespaces: [],
    });
  });

  it("detects one directory per locale with namespaces", () => {
    expect(
      pickTranslationPattern([
        "public/locales/en/home.json",
        "public/locales/en/translation.json",
        "public/locales/de/home.json",
        "public/locales/de/translation.json",
      ])
    ).toEqual({
      translationFiles: "public/locales/{locale}/{namespace}.json",
      locales: ["de", "en"],
      namespaces: ["home", "translation"],
    });
  });

  it("needs no namespaces for a single file per locale directory", () => {
    expect(
      pickTranslationPattern(["locales/en/messages.json", "locales/de/messages.json"])
        ?.translationFiles
    ).toBe("locales/{locale}/messages.json");
  });

  it("prefers conventional directories over other matches", () => {
    expect(
      pickTranslationPattern([
        "fixtures/aa.json",
        "fixtures/ab.json",
        "fixtures/af.json",
        "src/i18n/en.json",
      ])?.translationFiles
    ).toBe("src/i18n/{locale}.json");
  });

  it("ignores files that are not translations", () => {
    expect(
      pickTranslationPattern(["package.json", "tsconfig.json", "src/app.json", "data/en.json"])
    ).toBeNull();
  });
});

describe("pickDefaultLocale", () => {
  it("prefers English", () => {
    expect(pickDefaultLocale(["de", "en", "fr"])).toBe("en");
    expect(pickDefaultLocale(["de", "en-US"])).toBe("en-US");
    expect(pickDefaultLocale(["de", "fr"])).toBe("de");
  });
});

describe("detectConfig", () => {
  let root: string;
  const write = (rel: string, content: unknown) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(content));
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "i18n-lsp-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("derives pattern, default locale and key style from the workspace", () => {
    write("app/lang/de.json", { "welcome.back": "Willkommen zurück" });
    write("app/lang/fr.json", { "welcome.back": "Bon retour" });
    write("node_modules/pkg/locales/en.json", {});

    expect(detectConfig(root)).toEqual({
      translationFiles: ["app/lang/{locale}.json"],
      defaultLocale: "de",
      keyStyle: "flat",
    });
  });

  it("picks a default namespace", () => {
    write("public/locales/en/common.json", { a: { b: "c" } });
    write("public/locales/en/home.json", {});

    expect(detectConfig(root)).toEqual({
      translationFiles: ["public/locales/{locale}/{namespace}.json"],
      defaultLocale: "en",
      defaultNamespace: "common",
      keyStyle: "nested",
    });
  });

  it("returns null when nothing is found", () => {
    write("package.json", {});
    expect(detectConfig(root)).toBeNull();
  });
});

describe("readConfig without a config file", () => {
  let root: string;
  const write = (rel: string, content: unknown) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(content));
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "i18n-lsp-"));
    write("app/lang/en.json", { a: { b: "c" } });
    write("app/lang/de.json", { a: { b: "d" } });
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("detects the translation files", () => {
    const result = readConfig(root);
    expect(result.detected).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.config.translationFiles).toEqual(["app/lang/{locale}.json"]);
  });

  it("prefers editor settings over detection and ignores unset ones", () => {
    const result = readConfig(root, undefined, {
      translationFiles: "other/{locale}.json",
      defaultLocale: "",
      functionPatterns: [],
      keyStyle: null,
    });
    expect(result.detected).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(result.config.translationFiles).toEqual(["other/{locale}.json"]);
    expect(result.config.defaultLocale).toBe("en");
  });

  it("still detects when editor settings leave translationFiles unset", () => {
    const result = readConfig(root, undefined, { maxInlayLength: 20 });
    expect(result.detected).toBe(true);
    expect(result.config.maxInlayLength).toBe(20);
  });

  it("prefers .i18n-lsp.json over editor settings", () => {
    const result = readConfig(root, '{ "translationFiles": "a/{locale}.json" }', {
      translationFiles: "b/{locale}.json",
      defaultLocale: "de",
    });
    expect(result.config.translationFiles).toEqual(["a/{locale}.json"]);
    expect(result.config.defaultLocale).toBe("de");
  });
});
