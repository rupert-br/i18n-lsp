import { describe, it, expect, afterEach } from "vitest";
import { Position } from "vscode-languageserver";
import { createProject, TestProject, editedFile, applyWorkspaceEdit } from "./helpers";
import { provideDiagnostics, provideTranslationFileDiagnostics } from "../diagnostics";
import { provideInlayHints } from "../inlayHints";
import { provideHover } from "../hover";
import { provideDefinition } from "../definition";
import { provideCompletions } from "../completion";
import { provideCodeActions } from "../codeActions";
import { prepareRename, provideRename } from "../rename";
import { buildReport } from "../reports";
import { analyzeDocument } from "../analysis";

let t: TestProject;
afterEach(() => t?.dispose());

const EN = '{\n  "greet": { "hi": "Hello", "bye": "Goodbye" },\n  "unused": "nobody"\n}\n';
const DE = '{\n  "greet": { "hi": "Hallo" }\n}\n';

async function basic() {
  t = await createProject({
    "src/locales/en.json": EN,
    "src/locales/de.json": DE,
    "src/app.ts": "t('greet.hi'); t('greet.bye');\n",
  });
  return t;
}

describe("source diagnostics", () => {
  it("reports missing keys, partial translations and unmatched templates", async () => {
    await basic();
    const doc = t.doc("src/app.ts", "t('nope.x')\nt('greet.bye')\nt('fine.${x}')\nt('greet.hi')\n");
    const diags = provideDiagnostics(doc, t.project);
    expect(diags.map((d) => [d.code, d.range.start.line])).toEqual([
      ["missing-key", 0],
      ["partial-translation", 1],
      ["no-dynamic-matches", 2],
    ]);
    expect((diags[1].data as { missingLocales: string[] }).missingLocales).toEqual(["de"]);
  });

  it("ignores commented-out calls", async () => {
    await basic();
    const doc = t.doc("src/app.ts", "// t('nope.x')\n");
    expect(provideDiagnostics(doc, t.project)).toEqual([]);
  });

  it("treats plural families as existing keys", async () => {
    t = await createProject({ "src/locales/en.json": '{ "n_one": "1", "n_other": "many" }' });
    const doc = t.doc("src/a.ts", "t('n', { count })");
    expect(provideDiagnostics(doc, t.project)).toEqual([]);
  });

  it("resolves keys through declared and prefixed namespaces", async () => {
    t = await createProject(
      { "l/en/common.json": '{ "ok": "OK" }', "l/en/auth.json": '{ "login": "Log in" }' },
      { translationFiles: "l/{locale}/{namespace}.json", defaultNamespace: "common" }
    );
    const doc = t.doc(
      "src/a.tsx",
      "const { t } = useTranslation('auth');\nt('login'); t('ok'); t('common:ok'); t('auth:missing');\n"
    );
    const diags = provideDiagnostics(doc, t.project);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("auth:missing");
    expect((diags[0].data as { canonicalKey: string }).canonicalKey).toBe("auth:missing");
  });
});

describe("translation file diagnostics", () => {
  it("fades unused keys once usages are indexed", async () => {
    await basic();
    const diags = provideTranslationFileDiagnostics(t.file("src/locales/en.json"), t.project);
    const unused = diags.filter((d) => d.code === "unused-key");
    expect(unused).toHaveLength(1);
    expect(unused[0].message).toContain('"unused"');
    expect(unused[0].range.start.line).toBe(2);
  });

  it("warns on default-locale keys other locales lack", async () => {
    await basic();
    const diags = provideTranslationFileDiagnostics(t.file("src/locales/en.json"), t.project);
    const missing = diags.filter((d) => d.code === "missing-locales");
    expect(missing.map((d) => (d.data as { key: string }).key).sort()).toEqual(["greet.bye", "unused"]);
    // Only the default locale's file carries these, to avoid duplicates.
    expect(provideTranslationFileDiagnostics(t.file("src/locales/de.json"), t.project).filter((d) => d.code === "missing-locales")).toEqual([]);
  });

  it("does not claim everything is unused when no call is recognized", async () => {
    t = await createProject({
      "src/locales/en.json": '{ "a": "A" }',
      "src/app.ts": "AppLocalizations.of(context).a;\n",
    });
    const diags = provideTranslationFileDiagnostics(t.file("src/locales/en.json"), t.project);
    expect(diags.filter((d) => d.code === "unused-key")).toEqual([]);
  });

  it("respects reportUnusedKeys: false", async () => {
    t = await createProject(
      { "src/locales/en.json": '{ "a": "A" }', "src/app.ts": "t('other')\n" },
      { reportUnusedKeys: false }
    );
    expect(provideTranslationFileDiagnostics(t.file("src/locales/en.json"), t.project)).toEqual([]);
  });

  it("counts an open buffer's calls as usages", async () => {
    await basic();
    const doc = t.doc("src/other.ts", "t('unused')\n");
    t.project.usage.setBuffer(t.file("src/other.ts"), analyzeDocument(doc, t.project.config));
    const diags = provideTranslationFileDiagnostics(t.file("src/locales/en.json"), t.project);
    expect(diags.filter((d) => d.code === "unused-key")).toEqual([]);
  });

  it("marks every plural form used when the base key is used", async () => {
    t = await createProject({
      "src/locales/en.json": '{ "n_one": "1", "n_other": "many" }',
      "src/a.ts": "t('n', { count })\n",
    });
    const diags = provideTranslationFileDiagnostics(t.file("src/locales/en.json"), t.project);
    expect(diags.filter((d) => d.code === "unused-key")).toEqual([]);
  });

  it("counts dynamic template usages", async () => {
    t = await createProject({
      "src/locales/en.json": '{ "status": { "on": "On", "off": "Off" }, "other": "x" }',
      "src/a.ts": "t(`status.${s}`)\n",
    });
    const unused = provideTranslationFileDiagnostics(t.file("src/locales/en.json"), t.project).filter((d) => d.code === "unused-key");
    expect(unused.map((d) => (d.data as { key: string }).key)).toEqual(["other"]);
  });
});

describe("code actions", () => {
  const params = (doc: ReturnType<TestProject["doc"]>, diagnostics: any[], range = { start: Position.create(0, 0), end: Position.create(0, 0) }) => ({
    textDocument: { uri: doc.uri },
    range,
    context: { diagnostics },
  });

  it("adds a missing key to every locale", async () => {
    await basic();
    const doc = t.doc("src/app.ts", "t('new.key')\n");
    const diags = provideDiagnostics(doc, t.project);
    const actions = provideCodeActions(params(doc, diags), doc, t.file("src/app.ts"), t.project);
    expect(actions[0].title).toContain("new.key");
    expect(JSON.parse(editedFile(t, actions[0].edit!, "src/locales/en.json")!).new.key).toBe("TODO");
    expect(JSON.parse(editedFile(t, actions[0].edit!, "src/locales/de.json")!).new.key).toBe("TODO");
  });

  it("fills in only the missing locales", async () => {
    await basic();
    const doc = t.doc("src/app.ts", "t('greet.bye')\n");
    const actions = provideCodeActions(params(doc, provideDiagnostics(doc, t.project)), doc, t.file("src/app.ts"), t.project);
    expect(Object.keys(actions[0].edit!.changes!)).toEqual([`file://${t.file("src/locales/de.json")}`]);
  });

  it("removes an unused key from all locales", async () => {
    await basic();
    const diags = provideTranslationFileDiagnostics(t.file("src/locales/en.json"), t.project);
    const doc = t.doc("src/locales/en.json", EN, "json");
    const actions = provideCodeActions(params(doc, diags), doc, t.file("src/locales/en.json"), t.project);
    const remove = actions.find((a) => a.title.startsWith("Remove unused"))!;
    expect(JSON.parse(editedFile(t, remove.edit!, "src/locales/en.json")!)).toEqual({ greet: { hi: "Hello", bye: "Goodbye" } });
  });
});

describe("extract to key", () => {
  const extract = (doc: ReturnType<TestProject["doc"]>, line: number, character: number, rel: string) => {
    const range = { start: Position.create(line, character), end: Position.create(line, character) };
    return provideCodeActions(
      { textDocument: { uri: doc.uri }, range, context: { diagnostics: [], only: ["refactor"] } } as any,
      doc,
      t.file(rel),
      t.project
    ).find((a) => a.title.includes("translation key"));
  };

  it("replaces the literal and adds the text to the default locale", async () => {
    t = await createProject({ "src/locales/en.json": "{}", "src/locales/de.json": "{}" });
    const text = "const label = 'Save changes';\n";
    const doc = t.doc("src/LoginForm.ts", text);
    const action = extract(doc, 0, 20, "src/LoginForm.ts")!;
    expect(action.title).toContain("loginForm.saveChanges");

    const out = applyWorkspaceEdit(action.edit!, (u) => (u.endsWith(".ts") ? text : "{}"));
    expect(out[doc.uri]).toBe("const label = t('loginForm.saveChanges');\n");
    expect(JSON.parse(out[`file://${t.file("src/locales/en.json")}`])).toEqual({ loginForm: { saveChanges: "Save changes" } });
    // Other locales stay untouched; the existing partial-translation flow handles them.
    expect(out[`file://${t.file("src/locales/de.json")}`]).toBeUndefined();
  });

  it("wraps JSX attributes in braces", async () => {
    t = await createProject({ "src/locales/en.json": "{}" });
    const doc = t.doc("src/Btn.tsx", '<Button title="Click me" />\n', "typescriptreact");
    const action = extract(doc, 0, 16, "src/Btn.tsx")!;
    expect(applyWorkspaceEdit(action.edit!, () => '<Button title="Click me" />\n')[doc.uri]).toBe(
      `<Button title={t("btn.clickMe")} />\n`
    );
  });

  it("is not offered for imports, existing keys, non-text or markup attributes", async () => {
    t = await createProject({ "src/locales/en.json": '{ "a": "A" }' });
    expect(extract(t.doc("src/a.ts", "import x from './module';\n"), 0, 18, "src/a.ts")).toBeUndefined();
    expect(extract(t.doc("src/a.ts", "t('a')\n"), 0, 3, "src/a.ts")).toBeUndefined();
    expect(extract(t.doc("src/a.ts", "const c = '#fff';\n"), 0, 13, "src/a.ts")).toBeUndefined();
    expect(extract(t.doc("src/a.vue", '<img alt="A cat">\n', "vue"), 0, 12, "src/a.vue")).toBeUndefined();
  });

  it("reuses an identical existing entry and avoids clashes with different text", async () => {
    t = await createProject({ "src/locales/en.json": '{ "a": { "hello": "Hello", "hello2": "Hello?" } }' });
    const same = extract(t.doc("src/a.ts", "x = 'Hello'\n"), 0, 6, "src/a.ts")!;
    expect(same.title).toContain('Use existing translation key "a.hello"');

    t.dispose();
    t = await createProject({ "src/locales/en.json": '{ "a": { "hello": "Different" } }' });
    const clash = extract(t.doc("src/a.ts", "x = 'Hello'\n"), 0, 6, "src/a.ts")!;
    expect(clash.title).toContain('"a.hello2"');
  });
});

describe("rename", () => {
  it("renames the key in every locale file and every usage", async () => {
    await basic();
    const doc = t.doc("src/app.ts", "t('greet.hi'); t('greet.bye');\n");
    const edit = provideRename(doc, t.file("src/app.ts"), Position.create(0, 6), "greet.hello", t.project);

    expect(JSON.parse(editedFile(t, edit, "src/locales/en.json")!).greet).toEqual({ hello: "Hello", bye: "Goodbye" });
    expect(JSON.parse(editedFile(t, edit, "src/locales/de.json")!).greet).toEqual({ hello: "Hallo" });
    expect(editedFile(t, edit, "src/app.ts")).toBe("t('greet.hello'); t('greet.bye');\n");
  });

  it("works from the translation file and updates usages in other files and open buffers", async () => {
    await basic();
    const other = t.doc("src/other.ts", "const a = t(\"greet.hi\");\n");
    t.project.usage.setBuffer(t.file("src/other.ts"), analyzeDocument(other, t.project.config));

    const enDoc = t.doc("src/locales/en.json", EN, "json");
    // cursor on "hi" (line 1)
    const edit = provideRename(enDoc, t.file("src/locales/en.json"), Position.create(1, 17), "greet.hello", t.project);

    const out = applyWorkspaceEdit(edit, (u) => (u.endsWith("other.ts") ? "const a = t(\"greet.hi\");\n" : require("fs").readFileSync(u.replace("file://", ""), "utf-8")));
    expect(out[other.uri]).toBe('const a = t("greet.hello");\n');
    expect(out[`file://${t.file("src/app.ts")}`]).toBe("t('greet.hello'); t('greet.bye');\n");
  });

  it("keeps the unprefixed form for namespaced keys", async () => {
    t = await createProject(
      { "l/en/common.json": '{ "save": "Save" }', "src/a.ts": "t('save'); t('common:save');\n" },
      { translationFiles: "l/{locale}/{namespace}.json", defaultNamespace: "common" }
    );
    const doc = t.doc("src/a.ts", "t('save'); t('common:save');\n");
    const edit = provideRename(doc, t.file("src/a.ts"), Position.create(0, 4), "store", t.project);
    expect(editedFile(t, edit, "src/a.ts")).toBe("t('store'); t('common:store');\n");
    expect(JSON.parse(editedFile(t, edit, "l/en/common.json")!)).toEqual({ store: "Save" });
  });

  it("rejects invalid, clashing and unsupported renames with a message", async () => {
    await basic();
    const doc = t.doc("src/app.ts", "t('greet.hi'); t(`greet.${x}`);\n");
    const at = (name: string, ch = 6) => () => provideRename(doc, t.file("src/app.ts"), Position.create(0, ch), name, t.project);
    expect(at("greet.bye")).toThrow(/already exists/);
    expect(at("has space")).toThrow(/whitespace/);
    expect(at("greet.hi")).toThrow(/same/);
    expect(at("other.hi")).toThrow(/only the last part/);
    expect(at("greet.a.b")).toThrow(/dot in the new name/);
    expect(at("x", 26)).toThrow(/template/);
  });

  it("prepareRename returns the key range, or null away from a key", async () => {
    await basic();
    const doc = t.doc("src/app.ts", "t('greet.hi'); foo\n");
    expect(prepareRename(doc, t.file("src/app.ts"), Position.create(0, 6), t.project)).toMatchObject({
      placeholder: "greet.hi",
      range: { start: { line: 0, character: 3 }, end: { line: 0, character: 11 } },
    });
    expect(prepareRename(doc, t.file("src/app.ts"), Position.create(0, 16), t.project)).toBeNull();
  });

  it("refuses plural families from code", async () => {
    t = await createProject({
      "src/locales/en.json": '{ "n_one": "1", "n_other": "many" }',
      "src/a.ts": "t('n')\n",
    });
    const doc = t.doc("src/a.ts", "t('n')\n");
    expect(() => prepareRename(doc, t.file("src/a.ts"), Position.create(0, 3), t.project)).toThrow(/Plural/);
  });
});

describe("hover, definition, inlay hints", () => {
  it("shows all locales on hover", async () => {
    await basic();
    const doc = t.doc("src/app.ts", "t('greet.hi')\n");
    const hover = provideHover({ textDocument: { uri: doc.uri }, position: Position.create(0, 6) }, doc, t.project)!;
    const value = (hover.contents as { value: string }).value;
    expect(value).toContain("Hello");
    expect(value).toContain("Hallo");
  });

  it("jumps to the exact key in every locale file, default first", async () => {
    await basic();
    const doc = t.doc("src/app.ts", "t('greet.bye'); t('greet.hi')\n");
    const locs = provideDefinition({ textDocument: { uri: doc.uri }, position: Position.create(0, 20) }, doc, t.project)!;
    expect(locs.map((l) => l.uri)).toEqual([`file://${t.file("src/locales/en.json")}`, `file://${t.file("src/locales/de.json")}`]);
    expect(locs[0].range.start).toEqual({ line: 1, character: 13 });
    expect(locs[0].range.end).toEqual({ line: 1, character: 17 });
  });

  it("produces hints after the closing paren, including for multi-line calls", async () => {
    await basic();
    const doc = t.doc("src/app.ts", "const a = t('greet.hi');\nconst b = t(\n  'greet.bye'\n);\n");
    const hints = provideInlayHints(
      { textDocument: { uri: doc.uri }, range: { start: Position.create(0, 0), end: Position.create(10, 0) } },
      doc,
      t.project
    );
    expect(hints).toHaveLength(2);
    expect(hints[0].position).toEqual({ line: 0, character: 23 });
    expect(String(hints[0].label)).toContain('en: "Hello"');
    expect(hints[1].position.line).toBe(2);
  });

  it("limits hints to the requested range", async () => {
    await basic();
    const doc = t.doc("src/app.ts", "t('greet.hi')\nt('greet.bye')\n");
    const hints = provideInlayHints(
      { textDocument: { uri: doc.uri }, range: { start: Position.create(1, 0), end: Position.create(1, 20) } },
      doc,
      t.project
    );
    expect(hints).toHaveLength(1);
    expect(hints[0].position.line).toBe(1);
  });
});

describe("completion", () => {
  it("replaces the already-typed prefix, dots included", async () => {
    await basic();
    const doc = t.doc("src/app.ts", "t('greet.h')\n");
    const items = provideCompletions(
      { textDocument: { uri: doc.uri }, position: Position.create(0, 9) },
      doc,
      t.project
    );
    const hi = items.find((i) => i.label === "greet.hi")!;
    expect(hi.textEdit).toMatchObject({
      newText: "greet.hi",
      range: { start: { line: 0, character: 3 }, end: { line: 0, character: 9 } },
    });
  });

  it("offers nothing outside a translation call", async () => {
    await basic();
    const doc = t.doc("src/app.ts", "const s = 'greet.h'\n");
    expect(provideCompletions({ textDocument: { uri: doc.uri }, position: Position.create(0, 17) }, doc, t.project)).toEqual([]);
  });

  it("drops the namespace prefix when the file declares it", async () => {
    t = await createProject(
      { "l/en/auth.json": '{ "login": "Log in" }' },
      { translationFiles: "l/{locale}/{namespace}.json" }
    );
    const doc = t.doc("src/a.tsx", "useTranslation('auth');\nt('')\n");
    const items = provideCompletions({ textDocument: { uri: doc.uri }, position: Position.create(1, 3) }, doc, t.project);
    expect(items[0].label).toBe("auth:login");
    expect((items[0].textEdit as { newText: string }).newText).toBe("login");
  });
});

describe("report", () => {
  it("lists unused keys and missing translations", async () => {
    await basic();
    const report = buildReport(t.project);
    expect(report.usageAvailable).toBe(true);
    expect(report.unusedKeys.map((u) => u.key)).toEqual(["unused"]);
    expect(report.missingTranslations.map((m) => [m.key, m.missingLocales])).toEqual([
      ["greet.bye", ["de"]],
      ["unused", ["de"]],
    ]);
    expect(report.locales).toEqual(["de", "en"]);
  });
});
