import { describe, it, expect } from "vitest";
import {
  buildPatternRegex,
  findTranslationCallsInLine,
  expandDynamicKey,
} from "../patterns";

const defaultConfig = {
  translationFiles: "src/locales/{locale}.json",
  defaultLocale: "en",
  functionPatterns: ["t(", "i18n.t(", "$t(", "intl.formatMessage("],
  keyStyle: "nested" as const,
  hoverLocales: [],
  maxInlayLength: 50,
};

describe("buildPatternRegex", () => {
  it("matches t() calls", () => {
    const regex = buildPatternRegex(defaultConfig);
    const calls = findTranslationCallsInLine("const msg = t('welcome.back')", 0, regex);
    expect(calls).toHaveLength(1);
    expect(calls[0].key).toBe("welcome.back");
    expect(calls[0].dynamic).toBe(false);
  });

  it("matches $t() in Vue templates", () => {
    const regex = buildPatternRegex(defaultConfig);
    const calls = findTranslationCallsInLine('<p>{{ $t("welcome.back") }}</p>', 0, regex);
    expect(calls).toHaveLength(1);
    expect(calls[0].key).toBe("welcome.back");
  });

  it("matches i18n.t()", () => {
    const regex = buildPatternRegex(defaultConfig);
    const calls = findTranslationCallsInLine("i18n.t('app.title')", 0, regex);
    expect(calls).toHaveLength(1);
    expect(calls[0].key).toBe("app.title");
  });

  it("matches intl.formatMessage", () => {
    const regex = buildPatternRegex(defaultConfig);
    const calls = findTranslationCallsInLine("intl.formatMessage({id: 'hello'})", 0, regex);
    expect(calls).toHaveLength(1);
    expect(calls[0].key).toBe("hello");
  });

  it("rejects t() preceded by identifier chars", () => {
    const regex = buildPatternRegex(defaultConfig);
    const calls = findTranslationCallsInLine("document.createElement('canvas')", 0, regex);
    expect(calls).toHaveLength(0);
  });

  it("detects dynamic keys with template literals", () => {
    const regex = buildPatternRegex(defaultConfig);
    const calls = findTranslationCallsInLine("t(`messages.${type}`)", 0, regex);
    expect(calls).toHaveLength(1);
    expect(calls[0].key).toBe("messages.${type}");
    expect(calls[0].dynamic).toBe(true);
  });

  it("matches multiple calls on one line", () => {
    const regex = buildPatternRegex(defaultConfig);
    const calls = findTranslationCallsInLine("t('a.b') + t('c.d')", 0, regex);
    expect(calls).toHaveLength(2);
    expect(calls[0].key).toBe("a.b");
    expect(calls[1].key).toBe("c.d");
  });

  it("matches $t(key: 'x') named parameter syntax", () => {
    const regex = buildPatternRegex(defaultConfig);
    const calls = findTranslationCallsInLine("$t(key: 'license.key_label')", 0, regex);
    expect(calls).toHaveLength(1);
    expect(calls[0].key).toBe("license.key_label");
  });
});

describe("expandDynamicKey", () => {
  const allKeys = ["msg.info", "msg.error", "msg.warning", "nav.home", "nav.about"];

  it("returns matching keys for template", () => {
    const result = expandDynamicKey("msg.${type}", allKeys);
    expect(result).toEqual(["msg.info", "msg.error", "msg.warning"]);
  });

  it("returns input for non-dynamic keys", () => {
    const result = expandDynamicKey("nav.home", allKeys);
    expect(result).toEqual(["nav.home"]);
  });

  it("does not cross dot boundaries", () => {
    const result = expandDynamicKey("${x}", allKeys);
    expect(result).toEqual([]);
  });

  it("returns empty for no matches", () => {
    const result = expandDynamicKey("missing.${x}", allKeys);
    expect(result).toEqual([]);
  });
});
