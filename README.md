# i18n-lsp — Inline Translation Language Server

A Language Server that provides **inline translation previews** via inlay hints,
plus completions, hover, go-to-definition, diagnostics, and quick-fix code actions for i18n keys.

Works with **Zed** and **VS Code**.

## Features

- **Inlay hints** — all locale translations shown inline after each translation call
  ```
  t('welcome.back')  → en: "Welcome back" | de: "Willkommen zurück"
  ```
- **Hover** — full locale table on hover
- **Autocomplete** — key suggestions with translation previews
- **Go-to-definition** — jumps to the exact key in every locale file (default locale first)
- **Diagnostics**
  - in code: missing keys (error), partial translations (warning), template keys that match nothing
  - in translation files: **unused keys** (faded out) and keys the other locales don't have yet
- **Rename key** (`F2`) — from a call in code or from the key in a translation file; updates every locale file and every usage in the project
- **Extract to translation key** — code action on a string literal; replaces it with a translation call and adds the text to the default locale
- **Quick fixes** — add a missing key to all (or just the missing) locales, remove an unused key from all locales. JSON edits are minimal and keep your formatting, comments and sort order.
- **Live updates** — hints, diagnostics and unused-key detection follow unsaved edits, in code and in translation files (requires the editor to send those buffers; see [Editor notes](#editor-notes))
- **Namespaces & plurals** — i18next-style `ns:key`, `useTranslation('ns')` and `_one`/`_other` plural keys
- **Monorepos** — each package can have its own `.i18n-lsp.json`; the nearest one wins

## Getting Started

### 1. Install the LSP server

Only needed for other LSP clients; the Zed and VS Code extensions bring their own copy.

```bash
cd lsp-server
npm install
npm run build
npm install -g .
```

### 2. Configure your project (optional)

There is nothing to configure in a typical project: the server scans the
workspace and picks up the translation files, the default locale, the key
style and the default namespace on its own. It recognises the usual layouts:

```
src/locales/en.json              one file per locale
lib/l10n/app_en.arb              with a file name prefix
public/locales/en/common.json    one directory per locale (namespaces)
```

Directories named `locales`, `i18n`, `l10n`, `lang`, `translations`, `messages`
or `intl` are preferred; `node_modules`, build output and dot-directories are
skipped. The server log shows what was detected. If detection finds nothing,
the server stays quiet until translation files exist (run `i18n-lsp.reload` or
restart it afterwards).

To override what was detected, use either of these. Every option is optional,
and anything you leave out is still detected:

- **Editor settings** — VS Code: the `i18n-lsp.*` settings. Zed, in `settings.json`:
  ```json
  { "lsp": { "i18n-lsp": { "initialization_options": { "defaultLocale": "de" } } } }
  ```
- **`.i18n-lsp.json`** in the project root, to share the setup with your team.
  It wins over editor settings:

```json
{
  "translationFiles": "src/locales/{locale}.json",
  "defaultLocale": "en",
  "functionPatterns": ["t(", "i18n.t(", "$t(", "intl.formatMessage("],
  "keyStyle": "nested"
}
```

The file may contain comments and trailing commas. Invalid values are ignored
with a warning, and changes are picked up without restarting the server.

| Option | Description | Default |
|--------|-------------|---------|
| `translationFiles` | Glob pattern, or an array of them. Placeholders: `{locale}` (required) and `{namespace}`. Supports `*` and `**`. | detected, else `src/locales/{locale}.json` |
| `defaultLocale` | Primary locale shown first in hints | detected (`en` if present) |
| `defaultNamespace` | Namespace for unprefixed keys when `{namespace}` is used | detected, else `translation` |
| `functionPatterns` | Function call patterns to detect | `["t(", "i18n.t(", "$t(", "intl.formatMessage("]` |
| `keyStyle` | `"nested"` (objects) or `"flat"` (dot keys) — decides how new keys are written | detected, else `nested` |
| `maxInlayLength` | Max characters before truncation | `50` |
| `sourceFiles` | Globs of source files scanned for key usages (unused keys, rename). `[]` turns scanning off. | `["**/*.{ts,tsx,js,jsx,mjs,cjs,vue,svelte,dart}"]` |
| `sourceIgnore` | Extra ignore globs for that scan (`node_modules`, `dist`, `build`, … are always skipped) | `[]` |
| `reportUnusedKeys` | Fade out keys no source file uses | `true` |

Examples:

```json
{ "translationFiles": "public/locales/{locale}/{namespace}.json", "defaultNamespace": "common" }
{ "translationFiles": ["packages/*/i18n/{locale}.json", "shared/{locale}.yml"] }
```

In a monorepo, put a `.i18n-lsp.json` in each package (an empty `{}` is
enough to mark a package; its translation files are then detected). A file
belongs to the project of the nearest `.i18n-lsp.json` above it, and patterns
are relative to that directory. Without any config file, the whole workspace
folder is one project and detection picks a single translation directory.

### 3. Install the editor extension

#### Zed

The extension ships with the language server embedded and runs it on Zed's own
Node runtime, so step 1 is not needed for Zed either. Install it with
**zed: install dev extension** and pick the `zed-extension/` directory (Zed
compiles it, which needs Rust installed via rustup).

The embedded server is the checked-in `zed-extension/server/i18n-lsp.js`.
Regenerate it after changing the server:

```bash
cd lsp-server
npm install
npm run bundle:zed
```

To run a different server build instead, set its path in the Zed settings:

```json
{ "lsp": { "i18n-lsp": { "binary": { "path": "/path/to/i18n-lsp" } } } }
```

#### VS Code

The extension ships with the language server bundled in, so step 1 is not
needed for VS Code. The build bundles the server straight from `lsp-server/`,
so its dependencies have to be installed first:

```bash
(cd lsp-server && npm install)
cd vscode-extension
npm install
npm run build
code --extensionDevelopmentPath=$(pwd)
```

Or package and install:

```bash
npx @vscode/vsce package --no-dependencies
code --install-extension i18n-lsp-0.1.0.vsix
```

To run a different server build instead of the bundled one, point the
extension at it in the VS Code settings:

```json
{
  "i18n-lsp.serverPath": "/path/to/i18n-lsp"
}
```

### Editor notes

- **Zed** only sends buffers of the languages listed in `zed-extension/extension.toml`, so translation files are updated on save until JSON/YAML are added there. Inlay hints are off by default in Zed (`"inlay_hints": { "enabled": true }`).
- **VS Code** sends JSON/YAML buffers, so translation edits show up while you type.
- Server commands, for clients that want to show them: `i18n-lsp.report` (unused keys and missing translations per project) and `i18n-lsp.reload` (re-read all configs).

### Known limits

- Calls are found with a regex over the file with comments masked out — not a parser. It handles multi-line calls but won't see keys held in variables (`t(key)`), and it can be fooled by call-like text inside strings.
- Unused-key detection can only be as good as that detection: keys used via variables or generated accessors look unused, so it is shown as a faded hint (never a warning), is skipped entirely when no call is recognized, and can be switched off with `reportUnusedKeys`.
- Rename changes only the last segment of a key (`a.b.c` → `a.b.d`) and can't move keys between namespaces. Plural families (`key_one`, `key_other`) can't be renamed from code yet.

## Architecture

```
┌──────────────────────────────────────────────────┐
│            Editor (Zed / VS Code)                │
│  ┌────────────────────────────────────────────┐  │
│  │  Inlay Hints                               │  │
│  │  t('welcome')  → en: "Welcome" | de: "Wil…"│  │
│  │                                            │  │
│  │  Hover        ┌──────────────────────┐     │  │
│  │  $t('key') ──▶│ Locale │ Translation │     │  │
│  │               │ en ●   │ Welcome     │     │  │
│  │               │ de     │ Willkommen  │     │  │
│  │               └──────────────────────┘     │  │
│  │                                            │  │
│  │  Diagnostics  ⚠ Missing key: "foo.bar"     │  │
│  │  Code Action  💡 Add "foo.bar" to all files │  │
│  └──────────────────────┬─────────────────────┘  │
│                         │ LSP protocol (stdio)   │
└─────────────────────────┼────────────────────────┘
                          │
┌─────────────────────────▼────────────────────────┐
│              i18n-lsp server                     │
│                                                  │
│  ┌──────────────┐     ┌───────────────────────┐  │
│  │ File Watcher  │     │ Translation Index     │  │
│  │ • chokidar    │────▶│ key → {locale: value} │  │
│  │ • LSP didChange│    │                       │  │
│  └──────────────┘     └───────────┬───────────┘  │
│                                   │              │
│  ┌────────────────────────────────▼───────────┐  │
│  │ Providers                                  │  │
│  │ • inlayHint  • completion  • hover         │  │
│  │ • definition • diagnostics • codeAction    │  │
│  └────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

## Project Structure

```
i18n-lsp/
├── lsp-server/              # TypeScript LSP server
│   ├── src/
│   │   ├── server.ts              # LSP lifecycle & routing
│   │   ├── project.ts             # Project (config + store + usages) and nearest-config lookup
│   │   ├── config.ts              # Config loading, validation, translation path patterns
│   │   ├── detect.ts              # Translation file auto-detection
│   │   ├── translationParser.ts   # JSON/YAML/ARB → entries with exact key positions
│   │   ├── translationIndex.ts    # Translation store: watcher, key resolution (namespaces, plurals)
│   │   ├── usageIndex.ts          # Where keys are used across source files
│   │   ├── patterns.ts            # Translation call detection (comment masking, multi-line)
│   │   ├── analysis.ts            # Per-document call analysis + key resolution
│   │   ├── translationEdits.ts    # Add/remove keys in JSON & YAML, preserving formatting
│   │   ├── inlayHints.ts          # Inlay hint provider
│   │   ├── completion.ts          # Autocomplete provider
│   │   ├── hover.ts               # Hover provider
│   │   ├── definition.ts          # Go-to-definition provider
│   │   ├── diagnostics.ts         # Code and translation-file diagnostics
│   │   ├── codeActions.ts         # Quick fixes
│   │   ├── extract.ts             # Extract string to translation key
│   │   ├── rename.ts              # Rename key across locales and usages
│   │   ├── reports.ts             # Unused / missing translation report
│   │   ├── debounce.ts            # Per-path debouncing
│   │   ├── utils.ts               # Shared utilities (locale sorting, caching)
│   │   └── __tests__/             # Test suite (vitest), including an end-to-end run over stdio
│   ├── package.json
│   ├── tsconfig.json
│   └── tsconfig.build.json        # Build config without tests
│
├── zed-extension/           # Zed editor extension (Rust → WASM)
│   ├── src/lib.rs
│   ├── server/i18n-lsp.js         # Bundled LSP server, embedded into the extension
│   ├── extension.toml
│   └── Cargo.toml
│
├── vscode-extension/        # VS Code extension
│   ├── src/extension.ts
│   ├── esbuild.mjs                # Bundles the extension and the LSP server into dist/
│   ├── package.json
│   └── tsconfig.json
│
└── README.md
```

## Supported Translation Formats

- **JSON** (flat or nested, comments allowed): `{ "welcome": { "back": "Welcome back" } }`
- **YAML**: including Rails-style files wrapped in a locale root (`en:`); anchors and merge keys are skipped
- **ARB** (Flutter): `{ "@@locale": "en", "welcomeBack": "Welcome back" }`

Files that are mid-edit and not valid yet keep their last good state, so hints don't flicker while you type.

## Supported Frameworks

Works with any framework that uses detectable translation function calls:

| Framework | Pattern |
|-----------|---------|
| vue-i18n | `$t('key')`, `t('key')` |
| react-intl | `intl.formatMessage({id: 'key'})` |
| i18next / react-i18next | `t('key')`, `t('ns:key')`, `useTranslation('ns')`, `<Trans i18nKey="key" />`, `_one`/`_other` plurals |
| Flutter | `t('key')` (with ARB files) |
| Custom | Configure via `functionPatterns` |

## Development

```bash
# LSP server
cd lsp-server
npm install
npm run build        # compile
npm run watch        # compile on change
npm run check        # type-check without emit
npm test             # run test suite

# Zed extension (embeds zed-extension/server/i18n-lsp.js)
(cd lsp-server && npm run bundle:zed)
cd zed-extension
cargo build --target wasm32-wasip2

# VS Code extension (bundles lsp-server/src into dist/server.js)
cd vscode-extension
npm install
npm run build        # or: npm run watch
npm run check        # type-check
```

## License

[MIT](LICENSE)
