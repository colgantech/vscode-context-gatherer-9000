import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

interface FileEntry {
  type: "file";
  path: string;
}

interface RangeEntry {
  type: "range";
  path: string;
  startLine: number;
  endLine: number;
}

type ContextEntry = FileEntry | RangeEntry;

function entriesMatch(a: ContextEntry, b: ContextEntry): boolean {
  if (a.type !== b.type || a.path !== b.path) return false;
  if (a.type === "range" && b.type === "range") {
    return a.startLine === b.startLine && a.endLine === b.endLine;
  }
  return true;
}

function findEntryIndex(entries: ContextEntry[], target: ContextEntry): number {
  return entries.findIndex((e) => entriesMatch(e, target));
}

// ---------------------------------------------------------------------------
// Persistence — ~/.config/gather-context-files/<hash>.json per workspace folder
// Keeps state out of the repository.
// ---------------------------------------------------------------------------

import * as crypto from "crypto";
import * as os from "os";

function storageDir(): string {
  return path.join(os.homedir(), ".config", "gather-context-files");
}

function storagePathFor(workspaceFolder: vscode.WorkspaceFolder): string {
  const hash = crypto
    .createHash("sha256")
    .update(workspaceFolder.uri.toString())
    .digest("hex")
    .slice(0, 16);
  return path.join(storageDir(), `${hash}.json`);
}

function loadEntries(folder: vscode.WorkspaceFolder): ContextEntry[] {
  const fp = storagePathFor(folder);
  try {
    const raw = fs.readFileSync(fp, "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // File doesn't exist or is malformed — start empty
  }
  return [];
}

function saveEntries(folder: vscode.WorkspaceFolder, entries: ContextEntry[]): void {
  const fp = storagePathFor(folder);
  const dir = path.dirname(fp);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(fp, JSON.stringify(entries, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Resolve which workspace folder a path belongs to
// ---------------------------------------------------------------------------

function folderForPath(fsPath: string): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.getWorkspaceFolder(vscode.Uri.file(fsPath));
}

// ---------------------------------------------------------------------------
// Folder expansion — list all non-hidden, non-ignored files recursively
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  ".git", "node_modules", "__pycache__", ".venv", "venv",
  ".tox", ".mypy_cache", ".next", "dist", "build", ".cache",
]);

function expandDirectory(dirPath: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full);
      } else if (e.isFile()) {
        files.push(full);
      }
    }
  };
  walk(dirPath);
  return files;
}

// ---------------------------------------------------------------------------
// Buffer — manages entries for all workspace folders
// ---------------------------------------------------------------------------

class ContextBuffer {
  // Keyed by workspace folder URI string
  private perFolder = new Map<string, ContextEntry[]>();
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor() {
    // Load persisted state for all open workspace folders
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      this.perFolder.set(folder.uri.toString(), loadEntries(folder));
    }
  }

  /** Load persisted entries for a newly added workspace folder. */
  loadFolder(folder: vscode.WorkspaceFolder): void {
    const key = folder.uri.toString();
    if (!this.perFolder.has(key)) {
      this.perFolder.set(key, loadEntries(folder));
      this._onDidChange.fire();
    }
  }

  private entriesFor(folder: vscode.WorkspaceFolder): ContextEntry[] {
    const key = folder.uri.toString();
    if (!this.perFolder.has(key)) {
      this.perFolder.set(key, []);
    }
    return this.perFolder.get(key)!;
  }

  private persist(folder: vscode.WorkspaceFolder): void {
    saveEntries(folder, this.entriesFor(folder));
  }

  /** All entries across all folders, for the tree view. */
  allEntries(): { folder: vscode.WorkspaceFolder; entry: ContextEntry }[] {
    const result: { folder: vscode.WorkspaceFolder; entry: ContextEntry }[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      for (const entry of this.entriesFor(folder)) {
        result.push({ folder, entry });
      }
    }
    return result;
  }

  add(folder: vscode.WorkspaceFolder, entry: ContextEntry): void {
    this.addSilent(folder, entry);
    this.persist(folder);
    this._onDidChange.fire();
  }

  addFolder(folder: vscode.WorkspaceFolder, dirPath: string): void {
    // Expand to individual files and route each through add()
    // so that existing range entries are properly replaced
    const files = expandDirectory(dirPath);
    for (const f of files) {
      this.addSilent(folder, { type: "file", path: f });
    }
    this.persist(folder);
    this._onDidChange.fire();
  }

  /** Add without persisting or firing — used by addFolder for batching. */
  private addSilent(folder: vscode.WorkspaceFolder, entry: ContextEntry): void {
    const key = folder.uri.toString();
    let entries = this.entriesFor(folder);

    if (entry.type === "file") {
      const filtered = entries.filter((e) => e.path !== entry.path);
      filtered.push(entry);
      this.perFolder.set(key, filtered);
    } else {
      const filtered = entries.filter(
        (e) => !(e.path === entry.path && e.type === "file")
      );
      const dup = filtered.some(
        (e) =>
          e.type === "range" &&
          e.path === entry.path &&
          e.startLine === entry.startLine &&
          e.endLine === entry.endLine
      );
      if (!dup) {
        filtered.push(entry);
      }
      this.perFolder.set(key, filtered);
    }
  }

  remove(folder: vscode.WorkspaceFolder, entry: ContextEntry): void {
    const entries = this.entriesFor(folder);
    const idx = findEntryIndex(entries, entry);
    if (idx >= 0) {
      entries.splice(idx, 1);
      this.persist(folder);
      this._onDidChange.fire();
    }
  }

  replaceEntry(
    folder: vscode.WorkspaceFolder,
    oldEntry: ContextEntry,
    newEntry: ContextEntry
  ): void {
    const entries = this.entriesFor(folder);
    const idx = findEntryIndex(entries, oldEntry);
    if (idx >= 0) {
      entries[idx] = newEntry;
      this.persist(folder);
      this._onDidChange.fire();
    }
  }

  clearFolder(folder: vscode.WorkspaceFolder): void {
    this.perFolder.set(folder.uri.toString(), []);
    this.persist(folder);
    this._onDidChange.fire();
  }

  clearAll(): void {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      this.perFolder.set(folder.uri.toString(), []);
      this.persist(folder);
    }
    this._onDidChange.fire();
  }

  /** Serialize all entries to path spec lines for the clipboard. */
  toClipboardText(prefix: string = ""): string {
    const lines: string[] = [];
    for (const { entry } of this.allEntries()) {
      if (entry.type === "range") {
        lines.push(`${prefix}${entry.path}:${entry.startLine}-${entry.endLine}`);
      } else {
        lines.push(`${prefix}${entry.path}`);
      }
    }
    return lines.join("\n");
  }

  entryCount(): number {
    return this.allEntries().length;
  }
}

// ---------------------------------------------------------------------------
// Tree view
// ---------------------------------------------------------------------------

class EntryItem extends vscode.TreeItem {
  constructor(
    public readonly folder: vscode.WorkspaceFolder,
    public readonly entry: ContextEntry
  ) {
    const rel = path.relative(folder.uri.fsPath, entry.path);
    const label =
      entry.type === "range" ? `${rel}:${entry.startLine}-${entry.endLine}` : rel;

    super(label, vscode.TreeItemCollapsibleState.None);

    this.contextValue = entry.type; // "file" or "range"
    this.tooltip = entry.type === "range"
      ? `${entry.path} lines ${entry.startLine}-${entry.endLine}`
      : entry.path;
    this.iconPath =
      entry.type === "range"
        ? new vscode.ThemeIcon("selection")
        : new vscode.ThemeIcon("file");

    // Click opens the file
    const line = entry.type === "range" ? entry.startLine - 1 : 0;
    this.command = {
      command: "vscode.open",
      title: "Open",
      arguments: [
        vscode.Uri.file(entry.path),
        { selection: new vscode.Range(line, 0, line, 0), preview: true },
      ],
    };
  }
}

class FolderItem extends vscode.TreeItem {
  constructor(public readonly folder: vscode.WorkspaceFolder) {
    super(folder.name, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = "folder-root";
    this.iconPath = new vscode.ThemeIcon("root-folder");
  }
}

class ContextTreeProvider
  implements vscode.TreeDataProvider<FolderItem | EntryItem>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private buffer: ContextBuffer) {
    buffer.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  getTreeItem(element: FolderItem | EntryItem): vscode.TreeItem {
    return element;
  }

  getChildren(
    element?: FolderItem | EntryItem
  ): (FolderItem | EntryItem)[] {
    const folders = vscode.workspace.workspaceFolders ?? [];

    if (!element) {
      // Root level
      if (folders.length === 1) {
        // Single workspace — skip the folder grouping, show entries directly
        return this.buffer
          .allEntries()
          .map(({ folder, entry }) => new EntryItem(folder, entry));
      }
      // Multi-root — show folder groupings
      return folders.map((f) => new FolderItem(f));
    }

    if (element instanceof FolderItem) {
      return this.buffer
        .allEntries()
        .filter(({ folder }) => folder.uri.toString() === element.folder.uri.toString())
        .map(({ folder, entry }) => new EntryItem(folder, entry));
    }

    return [];
  }
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext) {
  const buffer = new ContextBuffer();
  const treeProvider = new ContextTreeProvider(buffer);

  vscode.window.createTreeView("contextGatherView", {
    treeDataProvider: treeProvider,
  });

  // Load persisted entries when workspace folders are added
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      for (const added of e.added) {
        buffer.loadFolder(added);
      }
    })
  );

  // Status bar
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBar.command = "contextGather.copyToClipboard";
  const updateStatus = () => {
    const n = buffer.entryCount();
    if (n > 0) {
      statusBar.text = `$(book) ${n} ctx`;
      statusBar.show();
    } else {
      statusBar.hide();
    }
  };
  buffer.onDidChange(updateStatus);
  updateStatus();
  context.subscriptions.push(statusBar);

  // --- Commands ---

  context.subscriptions.push(
    vscode.commands.registerCommand("contextGather.addSelection", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("No active editor.");
        return;
      }
      const folder = folderForPath(editor.document.uri.fsPath);
      if (!folder) {
        vscode.window.showWarningMessage("File not in a workspace folder.");
        return;
      }
      if (editor.selection.isEmpty) {
        // No selection — add the whole file
        buffer.add(folder, { type: "file", path: editor.document.uri.fsPath });
      } else {
        const sel = editor.selection;
        buffer.add(folder, {
          type: "range",
          path: editor.document.uri.fsPath,
          startLine: sel.start.line + 1,
          endLine: sel.end.line + 1,
        });
      }
    }),

    vscode.commands.registerCommand(
      "contextGather.addFile",
      (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
        const targets = uris ?? (uri ? [uri] : []);
        if (targets.length === 0) {
          const fsPath = vscode.window.activeTextEditor?.document.uri.fsPath;
          if (!fsPath) return;
          const folder = folderForPath(fsPath);
          if (!folder) {
            vscode.window.showWarningMessage("File not in a workspace folder.");
            return;
          }
          buffer.add(folder, { type: "file", path: fsPath });
          return;
        }
        for (const target of targets) {
          const folder = folderForPath(target.fsPath);
          if (!folder) continue;
          buffer.add(folder, { type: "file", path: target.fsPath });
        }
      }
    ),

    vscode.commands.registerCommand(
      "contextGather.addFolder",
      (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
        const targets = uris ?? (uri ? [uri] : []);
        for (const target of targets) {
          const folder = folderForPath(target.fsPath);
          if (!folder) continue;
          buffer.addFolder(folder, target.fsPath);
        }
      }
    ),

    vscode.commands.registerCommand(
      "contextGather.addExplorerItems",
      async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
        let targets = uris ?? (uri ? [uri] : []);

        // Keybindings don't pass args — read the explorer selection
        // by running the built-in copyFilePath command.
        if (targets.length === 0) {
          const prev = await vscode.env.clipboard.readText();
          await vscode.commands.executeCommand("copyFilePath");
          const copied = await vscode.env.clipboard.readText();
          await vscode.env.clipboard.writeText(prev);
          targets = copied
            .split("\n")
            .map((l) => l.trim())
            .filter((p) => p.startsWith("/"))
            .map((p) => vscode.Uri.file(p));
        }

        if (targets.length === 0) return;
        for (const target of targets) {
          const folder = folderForPath(target.fsPath);
          if (!folder) continue;
          try {
            const stat = fs.statSync(target.fsPath);
            if (stat.isDirectory()) {
              buffer.addFolder(folder, target.fsPath);
            } else {
              buffer.add(folder, { type: "file", path: target.fsPath });
            }
          } catch {
            // skip inaccessible paths
          }
        }
      }
    ),

    vscode.commands.registerCommand("contextGather.copyToClipboard", () => {
      const text = buffer.toClipboardText();
      if (!text) {
        vscode.window.showWarningMessage("Context buffer is empty.");
        return;
      }
      vscode.env.clipboard.writeText(text);
      vscode.window.showInformationMessage(
        `Copied ${buffer.entryCount()} paths to clipboard.`
      );
    }),

    vscode.commands.registerCommand("contextGather.copyToClipboardAt", () => {
      const text = buffer.toClipboardText("@");
      if (!text) {
        vscode.window.showWarningMessage("Context buffer is empty.");
        return;
      }
      vscode.env.clipboard.writeText(text);
      vscode.window.showInformationMessage(
        `Copied ${buffer.entryCount()} @-paths to clipboard.`
      );
    }),

    vscode.commands.registerCommand("contextGather.clear", () => {
      buffer.clearAll();
    }),

    vscode.commands.registerCommand("contextGather.clearAndAddSelection", async () => {
      buffer.clearAll();
      await vscode.commands.executeCommand("contextGather.addSelection");
    }),

    vscode.commands.registerCommand("contextGather.clearAndAddExplorerItems", async () => {
      buffer.clearAll();
      await vscode.commands.executeCommand("contextGather.addExplorerItems");
    }),

    vscode.commands.registerCommand(
      "contextGather.removeEntry",
      (item: EntryItem) => {
        buffer.remove(item.folder, item.entry);
      }
    ),

    vscode.commands.registerCommand(
      "contextGather.refineEntry",
      async (item: EntryItem) => {
        const entry = item.entry;
        const current =
          entry.type === "range" ? `${entry.startLine}-${entry.endLine}` : "";

        const input = await vscode.window.showInputBox({
          prompt: `Line range for ${path.basename(entry.path)} (e.g. 42-87, or empty for whole file)`,
          value: current,
          validateInput: (val) => {
            const v = val.trim();
            if (v === "") return null;
            if (/^\d+$/.test(v)) return null;
            if (/^\d+-\d+$/.test(v)) return null;
            return 'Format: "42-87" or "42" or empty for whole file';
          },
        });

        if (input === undefined) return; // cancelled

        if (input.trim() === "") {
          buffer.replaceEntry(item.folder, entry, {
            type: "file",
            path: entry.path,
          });
        } else {
          const parts = input.trim().split("-");
          buffer.replaceEntry(item.folder, entry, {
            type: "range",
            path: entry.path,
            startLine: parseInt(parts[0], 10),
            endLine: parts[1] ? parseInt(parts[1], 10) : parseInt(parts[0], 10),
          });
        }
      }
    )
  );
}

export function deactivate() {}
