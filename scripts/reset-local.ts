#!/usr/bin/env bun
// Nukes the zero-config local stack: container, data volume, local state dir.
// The next `bun scripts/start-local.ts` starts from a completely fresh
// database (and the binary re-migrates itself).
import { spawnSync } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOCAL_CONTAINER, LOCAL_VOLUME } from './start-local.ts'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

spawnSync('docker', ['rm', '-f', LOCAL_CONTAINER], { stdio: 'ignore' })
spawnSync('docker', ['volume', 'rm', LOCAL_VOLUME], { stdio: 'ignore' })
await rm(join(root, '.wikikit-local'), { recursive: true, force: true })
console.log('WikiKit local database and state removed.')
