use std::{env, fs};
use zed_extension_api::{self as zed, settings::LspSettings, LanguageServerId, Result};

/// The language server, bundled into a single file by `npm run bundle:zed`
/// in `lsp-server/` and embedded here so nothing has to be installed separately.
const SERVER_JS: &str = include_str!("../server/i18n-lsp.js");
const SERVER_FILE: &str = "i18n-lsp.js";

/// Zed extension that runs the i18n-lsp language server.
///
/// The server ships inside the extension and runs on Zed's own Node runtime.
/// Set `lsp.i18n-lsp.binary.path` in the Zed settings to use another build.
struct I18nExtension {
    /// Path of the server file once it has been written out in this session.
    server_path: Option<String>,
}

impl zed::Extension for I18nExtension {
    fn new() -> Self {
        I18nExtension { server_path: None }
    }

    /// Resolve the command used to start the i18n language server.
    fn language_server_command(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        let binary = LspSettings::for_worktree(language_server_id.as_ref(), worktree)
            .ok()
            .and_then(|settings| settings.binary);

        // An explicitly configured binary wins over the bundled server.
        if let Some(path) = binary.as_ref().and_then(|binary| binary.path.clone()) {
            return Ok(zed::Command {
                command: path,
                args: binary
                    .and_then(|binary| binary.arguments)
                    .unwrap_or_else(|| vec!["--stdio".into()]),
                env: Default::default(),
            });
        }

        Ok(zed::Command {
            command: zed::node_binary_path()?,
            args: vec![self.bundled_server()?, "--stdio".into()],
            env: Default::default(),
        })
    }

    /// Forward `lsp.i18n-lsp.initialization_options` from the Zed settings to
    /// the server, so projects can be configured without a `.i18n-lsp.json`.
    fn language_server_initialization_options(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<zed::serde_json::Value>> {
        Ok(
            LspSettings::for_worktree(language_server_id.as_ref(), worktree)
                .ok()
                .and_then(|settings| settings.initialization_options),
        )
    }
}

impl I18nExtension {
    /// Write the embedded server into the extension's working directory
    /// (once per session, and only if it changed) and return its path.
    fn bundled_server(&mut self) -> Result<String> {
        if let Some(path) = &self.server_path {
            if fs::metadata(path).is_ok() {
                return Ok(path.clone());
            }
        }

        if fs::read_to_string(SERVER_FILE).map_or(true, |current| current != SERVER_JS) {
            fs::write(SERVER_FILE, SERVER_JS)
                .map_err(|e| format!("failed to write the bundled i18n-lsp server: {e}"))?;
        }

        let path = env::current_dir()
            .map_err(|e| format!("failed to locate the extension directory: {e}"))?
            .join(SERVER_FILE)
            .to_string_lossy()
            .to_string();
        self.server_path = Some(path.clone());
        Ok(path)
    }
}

zed::register_extension!(I18nExtension);
