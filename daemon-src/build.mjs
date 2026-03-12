import { build } from 'esbuild'

const commonOptions = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  // Don't bundle node_modules — keep as external imports
  packages: 'external',
  banner: { js: '#!/usr/bin/env node' },
}

// Build daemon
await build({ ...commonOptions, entryPoints: ['src/index.ts'], outfile: 'dist/index.js' })

// Build chat-bridge (spawned as MCP subprocess by agent CLI)
await build({ ...commonOptions, entryPoints: ['src/chat-bridge.ts'], outfile: 'dist/chat-bridge.js' })

console.log('Build complete: dist/index.js, dist/chat-bridge.js')
