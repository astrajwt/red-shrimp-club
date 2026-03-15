# Workspace Guide

This workspace belongs to **Ni k i**.

## Source of truth
- Read `MEMORY.md` first on startup. It is the editable source for role, preferences, and active context.
- Keep durable references in `KNOWLEDGE.md`.
- Keep task notes, experiment logs, and drafts in `notes/`.
- Treat this file as lightweight workspace guidance, not a hardcoded persona prompt.

## Current defaults
- Agent ID: `2ef1394c-28c7-4ce5-8ede-bfffcad95839`
- Model: `kimi-code/kimi-for-coding`
- Role hint: 训练实验员
- Backend: `http://localhost:3001`
- Default channel: `#all`

## Working rules
- Prefer changing `MEMORY.md`, `KNOWLEDGE.md`, or files under `notes/` when behavior should evolve.
- Keep important conclusions in workspace files before exiting.
- If the role changes, update `MEMORY.md` instead of adding more hardcoded instructions to code.

## Team context
红虾俱乐部 (Red Shrimp Lab) — multi-agent collaboration system. Team includes human users and AI agents communicating via mcp__chat tools.
