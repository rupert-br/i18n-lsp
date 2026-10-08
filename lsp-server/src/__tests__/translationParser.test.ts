import { describe, it, expect } from "vitest";
import { parseTranslations } from "../translationParser";

const paths = (r: ReturnType<typeof parseTranslations>) => r?.entries.map((e) => [e.path, e.value]);

describe("parseTranslations (JSON)", () => {
  const json = `{
  "welcome": {
    "back": "Welcome back",
    "title": "Hi"
  },
  "flat.key": "flat"
}`;

  it("flattens nested objects", () => {
    expect(paths(parseTranslations(json, ".json", "en"))).toEqual([
      ["welcome.back", "Welcome back"],
      ["welcome.title", "Hi"],
      ["flat.key", "flat"],
    ]);
  });

  it("records the exact range of each key token, quotes included", () => {
    const result = parseTranslations(json, ".json", "en")!;
    const back = result.entries.find((e) => e.path === "welcome.back")!;
    expect(back.range).toEqual({ line: 2, character: 4, endLine: 2, endCharacter: 10 });
    expect(back.prefix).toBe("welcome");
    expect(back.name).toBe("back");
    expect(back.segments).toEqual(["welcome", "back"]);
  });

  it("keeps dotted tokens of flat files as a single segment", () => {
    const flat = parseTranslations(json, ".json", "en")!.entries.find((e) => e.path === "flat.key")!;
    expect(flat.name).toBe("flat.key");
    expect(flat.segments).toEqual(["flat.key"]);
    expect(flat.prefix).toBe("");
  });

  it("returns null for invalid JSON so callers can keep the last good state", () => {
    expect(parseTranslations('{ "a": ', ".json", "en")).toBeNull();
  });

  it("tolerates comments and trailing commas", () => {
    const r = parseTranslations('{ // note\n "a": "x", }', ".json", "en");
    expect(paths(r)).toEqual([["a", "x"]]);
  });

  it("skips ARB metadata and nulls, stringifies other scalars", () => {
    const arb = `{ "@@locale": "en", "hello": "Hello", "@hello": { "description": "x" }, "n": 3, "gone": null }`;
    expect(paths(parseTranslations(arb, ".arb", "en"))).toEqual([
      ["hello", "Hello"],
      ["n", "3"],
    ]);
  });

  it("strips a single top-level locale wrapper", () => {
    const r = parseTranslations('{ "en": { "a": "x" } }', ".json", "en")!;
    expect(r.wrapper).toBe("en");
    expect(r.entries[0].path).toBe("a");
    expect(r.entries[0].segments).toEqual(["a"]);
  });

  it("does not strip a wrapper that isn't the file's locale", () => {
    const r = parseTranslations('{ "en": { "a": "x" } }', ".json", "de")!;
    expect(r.wrapper).toBeNull();
    expect(r.entries[0].path).toBe("en.a");
  });

  it("handles empty files and non-object roots", () => {
    expect(parseTranslations("", ".json", "en")?.entries).toEqual([]);
    expect(parseTranslations("[1,2]", ".json", "en")?.entries).toEqual([]);
  });
});

describe("parseTranslations (YAML)", () => {
  it("flattens and locates keys", () => {
    const yml = "welcome:\n  back: Welcome back\n  title: 'Hi'\ntop: x\n";
    const r = parseTranslations(yml, ".yml", "en")!;
    expect(paths(r)).toEqual([
      ["welcome.back", "Welcome back"],
      ["welcome.title", "Hi"],
      ["top", "x"],
    ]);
    expect(r.entries[0].range).toEqual({ line: 1, character: 2, endLine: 1, endCharacter: 6 });
  });

  it("unwraps Rails-style locale roots", () => {
    const r = parseTranslations("en:\n  hello: Hello\n", ".yaml", "en")!;
    expect(r.wrapper).toBe("en");
    expect(paths(r)).toEqual([["hello", "Hello"]]);
  });

  it("skips merge keys, aliases and empty values", () => {
    const yml = "base: &b\n  a: 1\nother:\n  <<: *b\n  c: 2\nempty:\n";
    expect(paths(parseTranslations(yml, ".yml", "en"))).toEqual([
      ["base.a", "1"],
      ["other.c", "2"],
    ]);
  });

  it("returns null for invalid YAML", () => {
    expect(parseTranslations("a: [1, 2\nb: : :", ".yml", "en")).toBeNull();
  });

  it("returns null for unsupported extensions", () => {
    expect(parseTranslations("x", ".txt", "en")).toBeNull();
  });
});
