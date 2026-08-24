# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.2.0] - 2026-08-24

### Added

- **Comment / key-point marking**: the floating dialog now has a comment input
  and a "重点 / key point" checkbox. Marking a capture as a key point writes a
  `# **重点**` heading above its note.
- **Config example** (`config.example.json`) and a committed 1×1 `test/sample.png`
  so the unit tests run on any checkout.

### Changed

- Default `vaultPath` is now empty instead of pointing at a private local path.
  When unconfigured the plugin disables capture and warns rather than creating
  unrelated directories.
- Test scripts derive the repo root from `import.meta.url` instead of a
  hardcoded path, and the OCR test skips (rather than fails) when no API key is
  configured.
- `peerDependencies` range for `@deepseek-ai/dsh-tools` now includes an explicit
  prerelease branch so it matches prerelease harness builds.

## [0.1.0] - 2026-08-22

### Added

- Initial release: clipboard watcher + system floating window (copy / save-doc /
  save-image), instant OCR via Tongyi Qianwen, Obsidian per-day note merging,
  and an evening AI organization pass (categories, backlinks, daily summary,
  archive).
- Web settings page under DSH 设置 →「截图入库」with live reload.
