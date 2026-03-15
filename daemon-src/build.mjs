import { build } from 'esbuild'
import { builtinModules } from 'module'

// Mark all Node.js built-in modules as external (node:fs, fs, etc.)
const nodeBuiltins = [
  ...builtinModules,
  ...builtinModules.map(m => `node:${m}`),
]

// ESM output with createRequire shim so CJS libraries (ws) can use require()
const requireShim = [
  '#!/usr/bin/env node',
  'import { createRequire as __createRequire } from "module";',
  'const require = __createRequire(import.meta.url);',
].join('\n')

const commonOptions = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  // Bundle ALL dependencies (ws, @modelcontextprotocol/sdk, zod) into the output
  // so dist/ is self-contained and can be deployed without node_modules.
  external: nodeBuiltins,
  banner: { js: requireShim },
}

// Build daemon
await build({ ...commonOptions, entryPoints: ['src/index.ts'], outfile: 'dist/index.js' })

// Build chat-bridge (spawned as MCP subprocess by agent CLI)
await build({ ...commonOptions, entryPoints: ['src/chat-bridge.ts'], outfile: 'dist/chat-bridge.js' })

console.log('Build complete: dist/index.js, dist/chat-bridge.js (self-contained)')
