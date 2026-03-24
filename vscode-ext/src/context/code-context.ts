import * as vscode from 'vscode';

export interface CodeContext {
  filePath: string;
  relativePath: string;
  languageId: string;
  startLine: number;
  endLine: number;
  selectedText: string;
}

/** Active file info (always available, no selection needed) */
export interface FileContext {
  filePath: string;
  relativePath: string;
  languageId: string;
  lineCount: number;
  cursorLine: number;
}

/** Capture selected text — returns undefined if nothing selected */
export function captureCodeContext(): CodeContext | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { return undefined; }

  const selection = editor.selection;
  if (selection.isEmpty) { return undefined; }

  const selectedText = editor.document.getText(selection);
  if (!selectedText.trim()) { return undefined; }

  const relativePath = vscode.workspace.asRelativePath(editor.document.uri);

  return {
    filePath: editor.document.fileName,
    relativePath,
    languageId: editor.document.languageId,
    startLine: selection.start.line + 1,
    endLine: selection.end.line + 1,
    selectedText,
  };
}

/** Capture current active file info — always works if an editor is open */
export function captureFileContext(): FileContext | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { return undefined; }

  return {
    filePath: editor.document.fileName,
    relativePath: vscode.workspace.asRelativePath(editor.document.uri),
    languageId: editor.document.languageId,
    lineCount: editor.document.lineCount,
    cursorLine: editor.selection.active.line + 1,
  };
}

export function formatCodeContext(ctx: CodeContext): string {
  const header = `> [File: \`${ctx.relativePath}\` lines ${ctx.startLine}-${ctx.endLine}]`;
  return `${header}\n\`\`\`${ctx.languageId}\n${ctx.selectedText}\n\`\`\`\n\n`;
}

export function formatFileContext(ctx: FileContext): string {
  return `> [Active file: \`${ctx.relativePath}\` (${ctx.languageId}, ${ctx.lineCount} lines, cursor at line ${ctx.cursorLine})]\n\n`;
}
