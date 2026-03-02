# Intent: src/config.ts modifications

## What changed
Added four new configuration exports for Session channel support.

## Key sections
- **readEnvFile call**: Must include `SESSION_MNEMONIC`, `SESSION_DISPLAY_NAME`, `SESSION_DATA_PATH`, and `SESSION_ONLY` in the keys array. NanoClaw does NOT load `.env` into `process.env` — all `.env` values must be explicitly requested via `readEnvFile()`.
- **SESSION_MNEMONIC**: The bot's 13-word mnemonic. Required to create/restore the Session account. Defaults to empty string (channel disabled when empty).
- **SESSION_DISPLAY_NAME**: Display name shown to other Session users. Defaults to `ASSISTANT_NAME`.
- **SESSION_DATA_PATH**: Directory where the Session SQLite database, keys, and attachments are stored. Defaults to `{DATA_DIR}/session`.
- **SESSION_ONLY**: Boolean flag. When `true`, disables WhatsApp channel creation and Session becomes the sole channel.

## Invariants
- All existing config exports remain unchanged
- New Session keys are added to the `readEnvFile` call alongside existing keys
- New exports are appended at the end of the file
- No existing behavior is modified — Session config is additive only
- Both `process.env` and `envConfig` are checked (same pattern as `ASSISTANT_NAME`)
- `SESSION_DATA_PATH` uses `DATA_DIR` as its base — `DATA_DIR` must already be exported

## Must-keep
- All existing exports (`ASSISTANT_NAME`, `POLL_INTERVAL`, `TRIGGER_PATTERN`, etc.)
- The `readEnvFile` pattern — ALL config read from `.env` must go through this function
- The `escapeRegex` helper and `TRIGGER_PATTERN` construction
