import { describe, it, expect, afterEach } from "vitest";
import { createProject, TestProject, editedFile } from "./helpers";
import { buildInsertKeyEdit, buildRemoveKeyEdit } from "../translationEdits";

let t: TestProject;
afterEach(() => t?.dispose());

describe("buildInsertKeyEdit", () => {
  it("inserts into JSON without reformatting the rest of the file", async () => {
    const original = '{\n    "b": "B",\n    "z": "Z"\n}\n';
    t = await createProject({ "src/locales/en.json": original });
    const edit = buildInsertKeyEdit(t.project, "c", ["en"], () => "TODO");
    // 4-space indentation and sorted order are both preserved.
    expect(editedFile(t, edit, "src/locales/en.json")).toBe(
      '{\n    "b": "B",\n    "c": "TODO",\n    "z": "Z"\n}\n'
    );
  });

  it("appends when the file is not sorted", async () => {
    t = await createProject({ "src/locales/en.json": '{\n  "z": "Z",\n  "a": "A"\n}\n' });
    const edit = buildInsertKeyEdit(t.project, "m", ["en"], () => "TODO");
    expect(editedFile(t, edit, "src/locales/en.json")).toBe('{\n  "z": "Z",\n  "a": "A",\n  "m": "TODO"\n}\n');
  });

  it("creates nested objects and keeps comments", async () => {
    t = await createProject({ "src/locales/en.json": '{\n  // keep me\n  "a": "A"\n}\n' });
    const edit = buildInsertKeyEdit(t.project, "x.y.z", ["en"], () => "TODO");
    const out = editedFile(t, edit, "src/locales/en.json")!;
    expect(out).toContain("// keep me");
    expect(JSON.parse(out.replace("// keep me", ""))).toEqual({ a: "A", x: { y: { z: "TODO" } } });
  });

  it("writes one value per locale and skips locales that already have the key", async () => {
    t = await createProject({
      "src/locales/en.json": '{ "k": "K" }',
      "src/locales/de.json": "{}",
    });
    const edit = buildInsertKeyEdit(t.project, "k", ["en", "de"], (l) => `v-${l}`);
    expect(Object.keys(edit!.changes!)).toHaveLength(1);
    expect(JSON.parse(editedFile(t, edit, "src/locales/de.json")!)).toEqual({ k: "v-de" });
  });

  it("works on an empty file", async () => {
    t = await createProject({ "src/locales/en.json": "" });
    const edit = buildInsertKeyEdit(t.project, "a.b", ["en"], () => "X");
    expect(JSON.parse(editedFile(t, edit, "src/locales/en.json")!)).toEqual({ a: { b: "X" } });
  });

  it("won't put an object where a string already is", async () => {
    t = await createProject({ "src/locales/en.json": '{ "a": "text" }' });
    expect(buildInsertKeyEdit(t.project, "a.b", ["en"], () => "X")).toBeNull();
  });

  it("uses a literal dotted key in flat mode", async () => {
    t = await createProject({ "src/locales/en.json": '{ "a.b": "x" }' }, { keyStyle: "flat" });
    const edit = buildInsertKeyEdit(t.project, "c.d", ["en"], () => "X");
    expect(JSON.parse(editedFile(t, edit, "src/locales/en.json")!)).toEqual({ "a.b": "x", "c.d": "X" });
  });

  it("edits YAML and respects Rails-style locale roots", async () => {
    t = await createProject({ "src/locales/en.yml": "# header\nen:\n  hello: Hello\n" }, {
      translationFiles: "src/locales/{locale}.yml",
    });
    const edit = buildInsertKeyEdit(t.project, "bye.now", ["en"], () => "Bye");
    const out = editedFile(t, edit, "src/locales/en.yml")!;
    expect(out).toContain("# header");
    expect(out).toContain("hello: Hello");
    expect(out).toMatch(/en:\n[\s\S]*bye:\n\s+now: Bye/);
  });

  it("targets the namespace file for namespaced keys", async () => {
    t = await createProject(
      { "l/en/common.json": "{}", "l/en/auth.json": "{}" },
      { translationFiles: "l/{locale}/{namespace}.json" }
    );
    const edit = buildInsertKeyEdit(t.project, "auth:login", ["en"], () => "Log in");
    expect(Object.keys(edit!.changes!)).toEqual([`file://${t.file("l/en/auth.json")}`]);
  });

  it("picks the file holding the closest sibling keys when a locale has several", async () => {
    t = await createProject(
      {
        "i18n/app/en.json": '{ "nav": { "home": "Home" } }',
        "i18n/forms/en.json": '{ "form": { "name": "Name" } }',
      },
      { translationFiles: "i18n/*/{locale}.json" }
    );
    const edit = buildInsertKeyEdit(t.project, "form.email", ["en"], () => "Email");
    expect(Object.keys(edit!.changes!)).toEqual([`file://${t.file("i18n/forms/en.json")}`]);
  });
});

describe("buildRemoveKeyEdit", () => {
  it("removes the key from every locale and prunes emptied parents (JSON)", async () => {
    t = await createProject({
      "src/locales/en.json": '{\n  "a": { "b": { "c": "1" } },\n  "keep": "k"\n}\n',
      "src/locales/de.json": '{\n  "a": { "b": { "c": "2" }, "other": "o" }\n}\n',
    });
    const edit = buildRemoveKeyEdit(t.project, "a.b.c");
    expect(JSON.parse(editedFile(t, edit, "src/locales/en.json")!)).toEqual({ keep: "k" });
    expect(JSON.parse(editedFile(t, edit, "src/locales/de.json")!)).toEqual({ a: { other: "o" } });
  });

  it("removes keys from YAML and prunes emptied parents", async () => {
    t = await createProject(
      { "src/locales/en.yml": "a:\n  b: 1\nkeep: k\n" },
      { translationFiles: "src/locales/{locale}.yml" }
    );
    const out = editedFile(t, buildRemoveKeyEdit(t.project, "a.b"), "src/locales/en.yml")!;
    expect(out).toBe("keep: k\n");
  });

  it("returns null for unknown keys", async () => {
    t = await createProject({ "src/locales/en.json": "{}" });
    expect(buildRemoveKeyEdit(t.project, "nope")).toBeNull();
  });
});
