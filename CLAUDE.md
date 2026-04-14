# Gather Context Files

VS Code extension + companion API endpoint for curating file context to paste into LLM conversations.

@justfile

Uses bun as the JavaScript runtime and package manager. Use `just` recipes, not raw `bun` commands.

After compiling and installing (`just install-extension`), you must run "Developer: Reload Window" in VS Code for changes to take effect.

## VS Code extension API gotchas

The extension runs on WSL2 via VS Code's Remote - WSL. All file paths are Linux paths.

**Explorer selection is not accessible to extensions.** There is no VS Code API to read the file explorer's current selection from an extension command triggered by a keybinding (microsoft/vscode#3553, open since 2016). Built-in commands like `deleteFile` work because they have internal access; extensions do not. The workaround used here: programmatically execute the built-in `copyFilePath` command, read the clipboard, then restore the previous clipboard contents. This is the standard community workaround.

**Context menu commands vs keybinding commands receive different arguments.** When a command is invoked from `explorer/context` (right-click menu), VS Code passes `(uri, uris)` — the clicked item and the full multi-selection. When the same command is invoked via a keybinding, no arguments are passed. The `addExplorerItems` command handles both cases: it checks for args first, then falls back to the `copyFilePath` clipboard trick.

**Keybinding `when` clauses and negative entries.** If a user removes a keybinding through VS Code's UI, it writes a negative entry like `{ "key": "ctrl+l", "command": "-contextGather.addExplorerItems", "when": "..." }` to keybindings.json. These match by exact `when` clause string — if the extension's package.json changes the `when` clause, the old negative entry won't cancel the new one, but the old positive default also won't be removed. Users may need to manually clean up stale negative entries.

**Ctrl+L conflicts.** The extension binds Ctrl+L in two contexts: `editorTextFocus` (add selection/file) and `filesExplorerFocus && !inputFocus` (add explorer items). The default VS Code binding for Ctrl+L is `expandLineSelection` — the extension overrides it. The neovim extension (`vim_navigateCtrlL`) also binds Ctrl+L but only for `editorTextFocus`; users must add a negative entry to disable it. The `!inputFocus` guard prevents the keybinding from firing while renaming files in the explorer.

## Two gather-context endpoints

There are two separate gather-context API routes:

- `POST /api/tools/gather-context` — resolves CLAUDE.md files, @-references, `.claude/rules/`, and uses `files-to-prompt`. For gathering full project context including instructions.
- `POST /api/tools/gather-context-files` — raw file content to `<documents>` XML. No CLAUDE.md resolution. For gathering context from codebases you don't control. This is the endpoint paired with this VS Code extension.

## Persistence

State is stored in `~/.config/gather-context-files/{hash}.json` per workspace folder, where hash is the first 16 chars of SHA256 of the workspace folder URI. Outside the repo because entries contain absolute machine-specific paths.
