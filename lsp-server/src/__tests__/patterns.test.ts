import { describe, it, expect } from "vitest";
import {
  buildPatternRegex,
  findTranslationCallsInLine,
  findAllTranslationCalls,
  findNamespaces,
  maskComments,
  expandDynamicKey,
} from "../patterns";
import { testConfig } from "./helpers";

const defaultConfig = testConfig();

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

describe("findAllTranslationCalls", () => {
  const find = (text: string) => findAllTranslationCalls(text, defaultConfig);

  it("finds calls spread over several lines", () => {
    const calls = find("const x = t(\n  'a.b',\n  { count }\n);");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ key: "a.b", line: 1, keyStart: 3, keyEnd: 6 });
  });

  it("reports positions relative to the line on later lines", () => {
    const calls = find("first\n  second t('x.y')");
    expect(calls[0]).toMatchObject({ line: 1, keyStart: 12, keyEnd: 15 });
  });

  it("ignores calls inside comments", () => {
    const text = ["// t('line.comment')", "/* t('block.comment') */", "<!-- $t('html.comment') -->", "t('real')"].join("\n");
    expect(find(text).map((c) => c.key)).toEqual(["real"]);
  });

  it("does not treat // inside strings as a comment", () => {
    const calls = find("const u = 'http://x.y'; t('after.url')");
    expect(calls.map((c) => c.key)).toEqual(["after.url"]);
  });

  it("locates the key even when it repeats the function name", () => {
    const calls = find("t('t')");
    expect(calls[0]).toMatchObject({ key: "t", keyStart: 3, keyEnd: 4 });
  });

  it("rejects concatenated keys instead of reporting a partial one", () => {
    expect(find("t('prefix.' + name)")).toHaveLength(0);
    expect(find("t('ok', { n: 1 })")).toHaveLength(1);
  });

  it("detects react-i18next i18nKey props", () => {
    const calls = find('<Trans i18nKey="home.title" /> <Trans i18nKey={\'home.sub\'} />');
    expect(calls.map((c) => c.key)).toEqual(["home.title", "home.sub"]);
  });
});

describe("maskComments", () => {
  it("keeps length and newlines", () => {
    const text = "a // b\nc /* d\n e */ f";
    const masked = maskComments(text);
    expect(masked).toHaveLength(text.length);
    expect(masked.split("\n")).toHaveLength(3);
    expect(masked).not.toContain("b");
  });
});

describe("findNamespaces", () => {
  it("reads useTranslation arguments", () => {
    expect(findNamespaces("const { t } = useTranslation('common');")).toEqual(["common"]);
    expect(findNamespaces('useTranslation(["a", "b"])')).toEqual(["a", "b"]);
    expect(findNamespaces("useTranslation()")).toEqual([]);
    expect(findNamespaces("// useTranslation('ignored')")).toEqual([]);
  });
});
