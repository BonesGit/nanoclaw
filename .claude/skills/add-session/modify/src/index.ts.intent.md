# Intent: src/index.ts modifications

## What changed
Added Session channel support using the same multi-channel architecture as the Telegram skill.

## Key sections

### Imports (top of file)
- Added: `SessionChannel` from `./channels/session.js`
- Added: `SESSION_MNEMONIC`, `SESSION_DISPLAY_NAME`, `SESSION_DATA_PATH`, `SESSION_ONLY` from `./config.js`
- Added: `findChannel` from `./router.js` (if not already present from Telegram skill)
- Added: `Channel` type from `./types.js` (if not already present)

### Module-level state
- Added: `const channels: Channel[] = []` (if not already present from Telegram skill)

### processGroupMessages()
- Added: `findChannel(channels, chatJid)` lookup at the start (if not already present)
- Changed: `whatsapp.setTyping()` → `channel.setTyping?.()` (if not already present)
- Changed: `whatsapp.sendMessage()` → `channel.sendMessage()` in output callback (if not already present)

### main()
- Added: conditional Session channel creation:
  ```typescript
  if (SESSION_MNEMONIC) {
    const sessionChannel = new SessionChannel(SESSION_MNEMONIC, SESSION_DISPLAY_NAME, {
      ...channelOpts,
      dataPath: SESSION_DATA_PATH,
    });
    channels.push(sessionChannel);
    await sessionChannel.connect();
  }
  ```
- Changed: conditional WhatsApp creation (`if (!SESSION_ONLY && !TELEGRAM_ONLY)`) — note: SESSION_ONLY disables WhatsApp just like TELEGRAM_ONLY
- Changed: shutdown disconnects all channels via `for (const ch of channels)`

## Invariants
- All existing message processing logic (triggers, cursors, idle timers) is preserved
- The `runAgent` function is completely unchanged
- State management (loadState/saveState) is unchanged
- Recovery logic is unchanged
- Container runtime check is unchanged (ensureContainerSystemRunning)

## Must-keep
- The `escapeXml` and `formatMessages` re-exports
- The `_setRegisteredGroups` test helper
- The `isDirectRun` guard at bottom
- All error handling and cursor rollback logic in processGroupMessages
- The `channels` array pattern (if Telegram is already applied, extend it; otherwise create it)

## Merge note
If the Telegram skill has already been applied, this skill adds Session alongside Telegram in the existing multi-channel architecture. The `channels` array, `channelOpts`, and `findChannel` patterns are already present — only the SessionChannel instantiation block needs to be added to `main()`.
