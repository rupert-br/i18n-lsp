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
- **Go-to-definition** — jump to the key in the translation file
- **Diagnostics** — missing keys (error) and partial translations (warning)
- **Code actions** — quick-fix to add missing keys to all translation files
- **Live updates** — inlay hints update as you edit translation files (no save required)

## Getting Started

### 1. Install the LSP server

```bash
cd lsp-server
npm install
npm run build
npm install -g .
```

### 2. Configure your project

Place `.i18n-lsp.json` in your project root:

```json
{
  "translationFiles": "src/locales/{locale}.json",
  "defaultLocale": "en",
  "functionPatterns": ["t(", "i18n.t(", "$t(", "intl.formatMessage("],
  "keyStyle": "nested"
}
```

| Option | Description | Default |
|--------|-------------|---------|
| `translationFiles` | Glob pattern with `{locale}` placeholder | `src/locales/{locale}.json` |
| `defaultLocale` | Primary locale shown first in hints | `en` |
| `functionPatterns` | Function call patterns to detect | `["t(", "i18n.t(", "$t(", "intl.formatMessage("]` |
| `keyStyle` | `"nested"` (objects) or `"flat"` (dot keys) | `nested` |
| `maxInlayLength` | Max characters before truncation | `50` |

### 3. Install the editor extension

#### Zed

Copy or symlink `zed-extension/` into your Zed extensions directory, or install the `i18n-lsp` binary globally and add the extension via Zed's extension registry.

#### VS Code

```bash
cd vscode-extension
npm install
npm run build
code --extensionDevelopmentPath=$(pwd)
```

Or package and install:

```bash
npx @vscode/vsce package
code --install-extension i18n-lsp-0.1.0.vsix
```

You can also set a custom server path in VS Code settings:

```json
{
  "i18n-lsp.serverPath": "/path/to/i18n-lsp"
}
```

## Architecture

```
┌─────────────────────────────────┐
│       Editor (Zed / VS Code)    │
│  ┌───────────────────────────┐  │
│  │  Inlay Hint Rendering     │  │
│  │  t('welcome') → Willkommen│  │
│  └───────────┬───────────────┘  │
│              │ LSP protocol     │
│              │ (stdio)          │
└──────────────┼──────────────────┘
               │
┌──────────────▼──────────────────┐
│        i18n-lsp server          │
│                                 │
│  ┌─────────┐  ┌──────────────┐  │
│  │ Watcher  │  │ Translation  │  │
│  │ (chokidar│  │ Index        │  │
│  │  + LSP   │  │ key→{locale: │  │
│  │  didChange│ │   value}     │  │
│  └────┬─────┘  └──────┬───────┘  │
│       │ rebuild       │ lookup   │
│       └───────────────┘          │
│                                  │
│  Capabilities:                   │
│  • textDocument/inlayHint        │
│  • textDocument/completion       │
│  • textDocument/hover            │
│  • textDocument/definition       │
│  • textDocument/publishDiagnostics│
│  • textDocument/codeAction       │
└──────────────────────────────────┘
```

## Project Structure

```
i18n-lsp-concept/
├── lsp-server/              # TypeScript LSP server
│   ├── src/
│   │   ├── server.ts              # LSP lifecycle & routing
│   │   ├── translationIndex.ts    # File watcher + translation index
│   │   ├── inlayHints.ts          # Inlay hint provider
│   │   ├── completion.ts          # Autocomplete provider
│   │   ├── hover.ts               # Hover provider
│   │   ├── definition.ts          # Go-to-definition provider
│   │   ├── diagnostics.ts         # Missing key / partial translation diagnostics
│   │   ├── codeActions.ts         # Quick-fix code actions
│   │   ├── config.ts              # Configuration loading
│   │   ├── patterns.ts            # Translation call regex detection
│   │   ├── utils.ts               # Shared utilities (locale sorting, caching)
│   │   └── __tests__/             # Test suite (vitest)
│   ├── package.json
│   └── tsconfig.json
│
├── zed-extension/           # Zed editor extension (Rust → WASM)
│   ├── src/lib.rs
│   ├── extension.toml
│   └── Cargo.toml
│
├── vscode-extension/        # VS Code extension
│   ├── src/extension.ts
│   ├── package.json
│   └── tsconfig.json
│
└── README.md
```

## Supported Translation Formats

- **JSON** (flat or nested): `{ "welcome": { "back": "Welcome back" } }`
- **YAML**: Standard Rails-style i18n YAML
- **ARB** (Flutter): `{ "@@locale": "en", "welcomeBack": "Welcome back" }`

## Supported Frameworks

Works with any framework that uses detectable translation function calls:

| Framework | Pattern |
|-----------|---------|
| vue-i18n | `$t('key')`, `t('key')` |
| react-intl | `intl.formatMessage({id: 'key'})` |
| i18next | `t('key')`, `i18n.t('key')` |
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

# Zed extension
cd zed-extension
cargo build --target wasm32-wasip2

# VS Code extension
cd vscode-extension
npm install
npm run build
```
