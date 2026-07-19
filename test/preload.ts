// bun test preload — runs before every test file (wired via bunfig.toml).
//
// GitHub Actions runners execute jobs under a systemd service, so
// $JOURNAL_STREAM leaks into the test environment and flips createLogger's
// sd-daemon default on: every line grows a <N> priority prefix in CI only,
// while local runs stay green. Tests that want the prefix opt in via
// sdJournal: true; the default-detection test in logger.test.ts sets the
// variable itself and restores it afterwards.
delete process.env.JOURNAL_STREAM
