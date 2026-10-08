import { describe, it, expect, afterEach, vi } from "vitest";
import { createProject, TestProject } from "./helpers";
import { PathDebouncer } from "../debounce";

let t: TestProject;
afterEach(() => t?.dispose());

describe("TranslationStore", () => {
  it("loads every locale and exposes values and locations", async () => {
    t = await createProject({
      "src/locales/en.json": '{ "a": { "b": "Hello" } }',
      "src/locales/de.json": '{ "a": { "b": "Hallo" } }',
    });
    const { store } = t.project;
    expect(store.allLocales()).toEqual(["de", "en"]);
    expect(store.get("a.b")).toBe("Hello");
    expect(store.get("a.b", "de")).toBe("Hallo");
    expect(store.findKeyLocation("a.b")).toMatchObject({ filePath: t.file("src/locales/en.json"), line: 0 });
    expect(store.findKeyLocations("a.b")[0].filePath).toBe(t.file("src/locales/en.json"));
  });

  it("finds the right key when last segments repeat", async () => {
    t = await createProject({
      "src/locales/en.json": '{\n "a": { "title": "A" },\n "b": { "title": "B" }\n}',
    });
    expect(t.project.store.findKeyLocation("b.title")).toMatchObject({ line: 2 });
  });

  it("keeps the previous state while a file is temporarily invalid", async () => {
    t = await createProject({ "src/locales/en.json": '{ "a": "x" }' });
    const { store } = t.project;
    expect(store.loadContent(t.file("src/locales/en.json"), '{ "a": "x", "b": ')).toBe(false);
    expect(store.get("a")).toBe("x");
  });

  it("reloading one file never drops another file's keys for the same locale", async () => {
    t = await createProject(
      {
        "i18n/app/en.json": '{ "app": "App" }',
        "i18n/ui/en.json": '{ "ui": "UI" }',
      },
      { translationFiles: "i18n/*/{locale}.json" }
    );
    const { store } = t.project;
    store.loadContent(t.file("i18n/app/en.json"), '{ "app": "App 2" }');
    expect(store.get("app")).toBe("App 2");
    expect(store.get("ui")).toBe("UI");
    store.loadContent(t.file("i18n/app/en.json"), "{}");
    expect(store.has("app")).toBe(false);
    expect(store.get("ui")).toBe("UI");
  });

  it("matches only files under the project root", async () => {
    t = await createProject({ "src/locales/en.json": "{}" });
    expect(t.project.store.isTranslationFile(t.file("src/locales/en.json"))).toBe(true);
    expect(t.project.store.isTranslationFile(t.file("node_modules/x/src/locales/en.json"))).toBe(false);
  });

  it("counts a locale file with no keys as a locale", async () => {
    t = await createProject({
      "src/locales/en.json": '{ "a": "x" }',
      "src/locales/de.json": "{}",
    });
    expect(t.project.store.allLocales()).toEqual(["de", "en"]);
  });

  it("bumps version on change", async () => {
    t = await createProject({ "src/locales/en.json": "{}" });
    const before = t.project.store.version;
    t.project.store.setBuffer(t.file("src/locales/en.json"), '{ "a": "x" }');
    expect(t.project.store.version).toBeGreaterThan(before);
  });
});

describe("TranslationStore key resolution", () => {
  it("resolves plural families", async () => {
    t = await createProject({
      "src/locales/en.json": '{ "items_one": "{{count}} item", "items_other": "{{count}} items", "plain": "x" }',
    });
    const { store } = t.project;
    expect(store.resolveAll("plain")).toEqual(["plain"]);
    expect(store.resolveAll("items")).toEqual(["items_one", "items_other"]);
    expect(store.resolve("items")).toBe("items_other");
    expect(store.resolveAll("nope")).toEqual([]);
  });

  describe("with namespaces", () => {
    const files = {
      "locales/en/common.json": '{ "save": "Save" }',
      "locales/en/auth.json": '{ "login": "Log in", "save": "Save auth" }',
      "locales/de/common.json": '{ "save": "Speichern" }',
    };
    const config = { translationFiles: "locales/{locale}/{namespace}.json", defaultNamespace: "common" };

    it("prefixes keys with their namespace", async () => {
      t = await createProject(files, config);
      expect(t.project.store.allKeys().sort()).toEqual(["auth:login", "auth:save", "common:save"]);
    });

    it("resolves explicit, declared and default namespaces", async () => {
      t = await createProject(files, config);
      const { store } = t.project;
      expect(store.resolve("auth:login")).toBe("auth:login");
      expect(store.resolve("login", ["auth"])).toBe("auth:login");
      expect(store.resolve("save")).toBe("common:save"); // default namespace
      expect(store.resolve("save", ["auth"])).toBe("auth:save"); // declared wins
      expect(store.resolve("login")).toBeUndefined();
    });

    it("limits 'missing locale' checks to locales that have that namespace", async () => {
      t = await createProject(files, config);
      expect(t.project.store.allLocales("auth")).toEqual(["en"]);
      expect(t.project.store.allLocales("common")).toEqual(["de", "en"]);
    });
  });
});

describe("PathDebouncer", () => {
  it("runs work for different paths independently", () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const d = new PathDebouncer(100);
    d.schedule("a.json", () => calls.push("a"));
    d.schedule("b.json", () => calls.push("b"));
    vi.advanceTimersByTime(150);
    expect(calls.sort()).toEqual(["a", "b"]);
    vi.useRealTimers();
  });

  it("collapses repeats for the same path", () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const d = new PathDebouncer(100);
    d.schedule("a.json", () => calls.push("1"));
    d.schedule("a.json", () => calls.push("2"));
    vi.advanceTimersByTime(150);
    expect(calls).toEqual(["2"]);
    vi.useRealTimers();
  });
});
