# i18n-lsp — Inline Translation LSP for Zed

A Language Server that provides **inline translation previews** via LSP Inlay Hints,
plus completions, hover, and go-to-definition for i18n keys.

## Architecture

```
┌─────────────────────────────────┐
│           Zed Editor            │
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
│  │  on json/│  │ key→{locale: │  │
│  │  yaml)   │  │   value}     │  │
│  └────┬─────┘  └──────┬───────┘  │
│       │ rebuild       │ lookup   │
│       └───────────────┘          │
│                                  │
│  Capabilities:                   │
│  • textDocument/inlayHint        │
│  • textDocument/completion       │
│  • textDocument/hover            │
│  • textDocument/definition       │
│  • textDocument/diagnostic       │
└──────────────────────────────────┘
```

## Project Structure

```
i18n-lsp-concept/
├── lsp-server/          # TypeScript LSP server
│   ├── src/
│   │   ├── server.ts          # Main LSP server entry
│   │   ├── translationIndex.ts # File watcher + key index
│   │   ├── inlayHints.ts      # Inlay hint provider
│   │   ├── completion.ts      # Autocomplete provider
│   │   ├── hover.ts           # Hover provider
│   │   ├── definition.ts      # Go-to-definition provider
│   │   ├── diagnostics.ts     # Missing key diagnostics
│   │   ├── config.ts          # Configuration schema
│   │   └── patterns.ts        # Translation call detection
│   ├── package.json
│   └── tsconfig.json
│
├── zed-extension/       # Zed extension (Rust → WASM)
│   ├── src/
│   │   └── lib.rs
│   ├── extension.toml
│   └── Cargo.toml
│
└── README.md
```

## Configuration

Place `.i18n-lsp.json` in your project root:

```json
{
  "translationFiles": "src/locales/{locale}.json",
  "defaultLocale": "en",
  "functionPatterns": ["t('", "i18n.t('", "$t('", "intl.formatMessage({id: '"],
  "keyStyle": "nested"
}
```

## Supported Translation File Formats

- **JSON** (flat or nested): `{ "welcome": { "back": "Welcome back" } }`
- **YAML**: Standard Rails-style i18n YAML
- **ARB** (Flutter): `{ "@@locale": "en", "welcomeBack": "Welcome back" }`
