use std::fs;
use zed_extension_api::{self as zed, LanguageServerId, Result};

/// Zed extension that manages the i18n-lsp language server.
///
/// Two installation strategies:
/// 1. User has `i18n-lsp` globally installed via npm (`npm i -g i18n-lsp`)
/// 2. Extension returns a helpful error guiding the user to install it
struct I18nExtension {
    cached_binary_path: Option<String>,
}

impl zed::Extension for I18nExtension {
    /// Create a new instance of the extension with no cached binary path.
    fn new() -> Self {
        I18nExtension {
            cached_binary_path: None,
        }
    }

    /// Resolve the command used to start the i18n language server.
    ///
    /// First checks for a globally-installed `i18n-lsp` binary on `$PATH`.
    /// Falls back to a cached binary, or returns an error with install instructions.
    fn language_server_command(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        // Strategy 1: Check if installed globally via npm
        if let Some(path) = worktree.which("i18n-lsp") {
            return Ok(zed::Command {
                command: path,
                args: vec!["--stdio".into()],
                env: Default::default(),
            });
        }

        // Strategy 2: Use a cached/downloaded binary
        let binary_path = self.ensure_binary(language_server_id)?;

        Ok(zed::Command {
            command: binary_path,
            args: vec!["--stdio".into()],
            env: Default::default(),
        })
    }
}

impl I18nExtension {
    /// Ensure the LSP binary is available, returning its path if cached.
    ///
    /// If no binary is found, returns an error with installation instructions
    /// directing the user to install `i18n-lsp` globally via npm.
    fn ensure_binary(&mut self, _server_id: &LanguageServerId) -> Result<String> {
        if let Some(ref path) = self.cached_binary_path {
            if fs::metadata(path).is_ok() {
                return Ok(path.clone());
            }
        }

        Err("i18n-lsp not found. Install globally with: npm i -g i18n-lsp".into())
    }
}

zed::register_extension!(I18nExtension);
