#!/usr/bin/env bun
// Zero-config local stack: a dedicated
// Docker Postgres on a non-standard port + named volume, then the WikiKit
// server. Nothing to configure — the container matches the committed
// .env.defaults DATABASE_URL exactly, and the binary migrates itself at boot.
//
// Also the provisioning entrypoint for integration tests: the exported
// helpers (ensureLocalPostgres / waitForDatabase / provisionIntegrationDatabase)
// let test suites create isolated throwaway databases in the same container,
// and `bun scripts/start-local.ts --db-only` provisions without starting the
// server (CI usage).
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

// Must stay identical to the committed .env.defaults DATABASE_URL — the
// zero-config contract. Port 55442 avoids colliding with a host Postgres
// (5432) and with a default local Postgres container (55432).
export const LOCAL_DATABASE_URL = 'postgresql://postgres:wikikit-local@127.0.0.1:55442/wikikit'
export const LOCAL_CONTAINER = 'wikikit-local-postgres'
export const LOCAL_VOLUME = 'wikikit-local-postgres'

function docker(...args: string[]) {
  return spawnSync('docker', args, { encoding: 'utf8' })
}

/** Idempotent: creates the container on first run, restarts it when stopped, no-ops when running. */
export function ensureLocalPostgres(): void {
  const info = docker('info')
  if (info.status !== 0) throw new Error('Docker is required for zero-config local PostgreSQL; start Docker Desktop')
  const inspect = docker('inspect', LOCAL_CONTAINER)
  if (inspect.status !== 0) {
    const created = docker(
      'run',
      '-d',
      '--name',
      LOCAL_CONTAINER,
      '-e',
      'POSTGRES_PASSWORD=wikikit-local',
      '-e',
      'POSTGRES_DB=wikikit',
      '-p',
      '127.0.0.1:55442:5432',
      '-v',
      `${LOCAL_VOLUME}:/var/lib/postgresql/data`,
      'postgres:16-alpine',
    )
    if (created.status !== 0) throw new Error(created.stderr.trim() || 'failed to start local PostgreSQL')
    return
  }
  const state = (JSON.parse(inspect.stdout) as { State?: { Running?: boolean } }[])[0]?.State
  if (!state?.Running) {
    const started = docker('start', LOCAL_CONTAINER)
    if (started.status !== 0) throw new Error(started.stderr.trim() || 'failed to restart local PostgreSQL')
  }
}

/** Polls until the database accepts queries (container boot + initdb can take a while on first run). */
export async function waitForDatabase(url: string, attempts = 60): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    const client = new pg.Client({ connectionString: url })
    try {
      await client.connect()
      await client.query('SELECT 1')
      await client.end()
      return
    } catch (error) {
      lastError = error
      await client.end().catch(() => {})
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/**
 * Drops and recreates an isolated database inside the local container and
 * returns its connection URL. One database per integration test suite keeps
 * suites independent and parallel-safe without container churn.
 */
export async function provisionIntegrationDatabase(name: string): Promise<string> {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`invalid test database name: ${name}`)
  ensureLocalPostgres()
  await waitForDatabase(LOCAL_DATABASE_URL)
  const client = new pg.Client({ connectionString: LOCAL_DATABASE_URL })
  await client.connect()
  try {
    // WITH (FORCE) kicks lingering connections from a previous aborted run.
    await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
    await client.query(`CREATE DATABASE "${name}"`)
  } finally {
    await client.end()
  }
  return LOCAL_DATABASE_URL.replace(/\/wikikit$/, `/${name}`)
}

async function main(): Promise<void> {
  // Late import keeps the exported helpers usable even if config loading ever
  // grows side effects tests should not pay for.
  const { loadConfig } = await import('../src/config.ts')
  const config = loadConfig()

  // Only auto-provision when the configured database IS the local default —
  // a real DATABASE_URL means the operator brings their own Postgres.
  if (config.databaseUrl === LOCAL_DATABASE_URL) ensureLocalPostgres()
  await waitForDatabase(config.databaseUrl)

  const dbOnly = process.argv.includes('--db-only')
  const entry = join(root, 'bin', 'wikikit.ts')
  if (dbOnly || !existsSync(entry)) {
    console.log(`wikikit local: database ready at ${config.databaseUrl}`)
    if (!dbOnly && !existsSync(entry)) console.log('wikikit local: bin/wikikit.ts not found — skipping server start')
    return
  }

  console.log('')
  console.log('WikiKit local environment')
  console.log(`  API:       ${config.publicUrl}`)
  console.log(`  OpenAPI:   ${config.publicUrl}/openapi.json`)
  console.log(`  Database:  ${config.databaseUrl}`)
  console.log('  Stop:      Ctrl-C')
  console.log('')

  const child = spawn('bun', [entry], {
    env: { ...process.env, NODE_ENV: process.env.NODE_ENV ?? 'development' },
    stdio: 'inherit',
  })
  const stop = (signal: NodeJS.Signals) => {
    if (child.exitCode === null) child.kill(signal)
  }
  process.on('SIGINT', () => stop('SIGINT'))
  process.on('SIGTERM', () => stop('SIGTERM'))
  const exitCode = await new Promise<number>((resolve) => child.once('exit', (code) => resolve(code ?? 1)))
  process.exitCode = exitCode
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`wikikit local: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
