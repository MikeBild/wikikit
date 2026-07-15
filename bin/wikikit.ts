#!/usr/bin/env bun
// WikiKit entrypoint — the `bun build --compile` root and the dev `bun run`
// target. NOT a CLI product (headless house rule): the only flags are ops
// flags. No args starts the server.
//
//   wikikit            start the server (zero-config local bootstrap in dev)
//   wikikit --migrate  run embedded migrations and exit
//   wikikit --version  print the version and exit
//
// Zero-config principle (plan §8): `./wikikit` with NOTHING configured must
// boot a working local stack. Outside production, when no DATABASE_URL is
// set (or it is the committed local default), the launcher provisions the
// dedicated Docker Postgres from scripts/start-local.ts and fills in the dev
// pepper — the same values .env.defaults would supply in the repo, so repo
// dev and bare-binary dev behave identically. In production none of this
// runs: config guards demand explicit DATABASE_URL + WIKIKIT_KEY_PEPPER.
import { loadConfig, type Config } from '../src/config.ts'
import { VERSION } from '../src/version.ts'
import { LOCAL_DATABASE_URL, ensureLocalPostgres, waitForDatabase } from '../scripts/start-local.ts'

const DEV_KEY_PEPPER = 'wikikit-local-key-pepper'

async function ensureLocalDatabase(): Promise<Config> {
  let config = loadConfig()
  if (config.production) return config

  if (!config.databaseUrl) {
    // Bare binary outside the repo: no .env.defaults on disk, so inject the
    // same dev defaults it would have provided, then reload.
    process.env.DATABASE_URL = LOCAL_DATABASE_URL
    if (!process.env.WIKIKIT_KEY_PEPPER) process.env.WIKIKIT_KEY_PEPPER = DEV_KEY_PEPPER
    config = loadConfig()
  }

  if (config.databaseUrl === LOCAL_DATABASE_URL) {
    try {
      ensureLocalPostgres()
    } catch (error) {
      // Docker missing is only fatal if the database is ALSO unreachable —
      // an operator running their own Postgres on the local port is fine.
      try {
        await waitForDatabase(config.databaseUrl, 4)
        return config
      } catch {
        throw error
      }
    }
    await waitForDatabase(config.databaseUrl)
  }
  return config
}

async function main(): Promise<void> {
  const flags = process.argv.slice(2)

  if (flags.includes('--version')) {
    // Print and exit without loading config: --version must work with no
    // database, no Docker, no env — it is the deploy pipeline's identity
    // check on the freshly built binary.
    console.log(VERSION)
    return
  }

  if (flags.includes('--migrate')) {
    const { runMigrations } = await import('../src/db/migrate.ts')
    const { createLogger } = await import('../src/logger.ts')
    const config = await ensureLocalDatabase()
    if (!config.databaseUrl) throw new Error('DATABASE_URL is required for --migrate')
    const report = await runMigrations(config, createLogger({ level: config.logLevel }))
    console.log(`migrations: ${report.applied.length} applied, ${report.skipped} skipped`)
    return
  }

  const unknown = flags.filter((flag) => flag.startsWith('-'))
  if (unknown.length) {
    console.error(`unknown flag(s): ${unknown.join(' ')} (supported: --migrate, --version)`)
    process.exitCode = 2
    return
  }

  const config = await ensureLocalDatabase()
  const { start } = await import('../src/app.ts')
  await start(config)
}

main().catch((error: unknown) => {
  console.error(`wikikit: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
