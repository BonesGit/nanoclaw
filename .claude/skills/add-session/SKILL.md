---
name: add-session
description: Add Session as a channel. Session is a decentralized, end-to-end encrypted messaging protocol. The bot gets its own Session ID that contacts can message directly. Can replace WhatsApp or run alongside it.
---

# Add Session Channel

This skill adds [Session](https://getsession.org) messaging support to NanoClaw using the `session-desktop` headless library. The bot runs a real Session node — it has its own Session ID, receives messages via swarm polling, and sends over the Session network.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `session` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

AskUserQuestion: Should Session replace WhatsApp or run alongside it?
- **Replace WhatsApp** — Session will be the only channel (sets `SESSION_ONLY=true`)
- **Alongside** — Both Session and WhatsApp (and any other channels) remain active

## Phase 2: Install Library + Apply Code Changes

### Build the library

The `session-desktop` library must be compiled before installation. Run this in the library directory:

```bash
cd ../session-desktop-library && npm run build:lib && cd -
```

This compiles TypeScript to `dist-lib/`. It takes ~30 seconds. If it fails, check that the library's dependencies are installed:

```bash
cd ../session-desktop-library && pnpm install && npm run build:lib && cd -
```

### Install the library as a local dependency

```bash
npm install file:../session-desktop-library --legacy-peer-deps
```

This links the compiled library into nanoclaw's `node_modules` as `session-desktop`.

Verify the install succeeded:

```bash
node -e "require('session-desktop'); console.log('OK')"
```

If it fails with a native module error, the library's native dependencies (`libsession_util_nodejs`, `@signalapp/sqlcipher`) may need rebuilding:

```bash
cd ../session-desktop-library && npm rebuild && cd -
npm install file:../session-desktop-library --legacy-peer-deps
```

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-session
```

This deterministically:
- Adds `src/channels/session.ts` (SessionChannel class implementing Channel interface)
- Adds `src/channels/session.test.ts` (unit tests)
- Three-way merges Session support into `src/index.ts` (SessionChannel init in main())
- Three-way merges Session config into `src/config.ts` (SESSION_MNEMONIC and friends)
- Three-way merges routing tests into `src/routing.test.ts`
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent files:
- `modify/src/index.ts.intent.md` — what changed and invariants for index.ts
- `modify/src/config.ts.intent.md` — what changed for config.ts

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass (including the new session tests) and build must be clean before proceeding.

## Phase 3: Setup

### Generate a Session account mnemonic

The bot needs its own Session account. The mnemonic is a 13-word phrase that acts as the private key. It only needs to be generated once — on subsequent starts the account loads from the local database.

Generate one now:

```bash
node -e "
const { SessionClient } = require('session-desktop');
SessionClient.generateMnemonic().then(m => {
  console.log('MNEMONIC:', m);
  process.exit(0);
});
"
```

Copy the output. This is the `SESSION_MNEMONIC` value. **Store it safely** — losing it means losing the bot's Session identity permanently.

If the user already has a mnemonic (restoring an existing bot identity), skip generation and use theirs.

### Configure environment

Add to `.env`:

```bash
SESSION_MNEMONIC=word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12 word13
SESSION_DISPLAY_NAME=Andy
```

`SESSION_DISPLAY_NAME` is optional — defaults to `ASSISTANT_NAME` from `.env` (or 'Andy' if unset).

`SESSION_DATA_PATH` is optional — defaults to `data/session` inside the project. Override if you want the Session database stored elsewhere:

```bash
SESSION_DATA_PATH=/path/to/session/data
```

If the user chose to replace WhatsApp:

```bash
SESSION_ONLY=true
```

### Create the Session data directory

```bash
mkdir -p data/session
```

### Sync environment to container

```bash
mkdir -p data/env && cp .env data/env/env
```

The container reads environment from `data/env/env`, not `.env` directly.

### Build and start the service

```bash
npm run build
systemctl --user restart nanoclaw  # Linux
# macOS: launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### Get the bot's Session ID

After starting the service, the bot's Session ID is logged to the console and to `logs/nanoclaw.log`:

```bash
grep "Session ID" logs/nanoclaw.log | tail -1
```

Or restart with `npm run dev` to see it printed in the terminal:

```
  Session ID: 05abc123...66hexchars
  Share this ID so others can start a conversation with the bot
```

Tell the user: **Share this Session ID with anyone who wants to message the bot.** They add it as a contact in their Session app and send the first message.

## Phase 4: Registration

### Identify the conversation JID

When someone sends a message to the bot's Session ID, the bot receives it and logs the conversation ID. Before registration, the agent won't respond — the conversation must first be registered with NanoClaw.

**Get the unregistered conversation JID from logs:**

```bash
grep "unregistered Session conversation" logs/nanoclaw.log | tail -5
```

The log line contains the JID in `session:05<sessionId>` format.

**Alternatively**, the user can provide their Session ID directly. Their Session ID is visible in their Session app (Settings > Recovery Phrase > Session ID, or in the QR share screen). The JID is then `session:<their-session-id>`.

For a **group** conversation, the group's public key starts with `03`. The user can copy it from the Session app. The JID is `session:<03groupPubkey>`.

### Register the conversation

For the main chat (responds to all messages, uses the `main` folder):

```bash
npx tsx setup/index.ts --step register \
  --jid "session:<their-session-id>" \
  --name "main" \
  --trigger "@Andy" \
  --folder "main" \
  --no-trigger-required
```

For additional chats (trigger-only):

```bash
npx tsx setup/index.ts --step register \
  --jid "session:<their-session-id>" \
  --name "<chat-name>" \
  --trigger "@Andy" \
  --folder "<folder-name>"
```

## Phase 5: Verify

### Test the connection

Tell the user:

> Send a message to the bot's Session ID from your Session app.
>
> - **Main chat** (no-trigger-required): any message will get a response
> - **Non-main chat**: start your message with `@Andy`
>
> The bot should respond within 5–15 seconds (Session network polling interval).

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### Bot not responding

Check:
1. `SESSION_MNEMONIC` is set in `.env` AND synced to `data/env/env`
2. Conversation is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'session:%'"`
3. For non-main chats: message starts with trigger pattern
4. Service is running: `systemctl --user status nanoclaw`
5. Session data directory exists: `ls data/session/`

### Bot starts but shows no Session ID

The account hasn't been created yet. Check `logs/nanoclaw.log` for errors during initialization. Common causes:
- `SESSION_MNEMONIC` not set or empty in `.env`
- `data/session/` directory doesn't exist (create with `mkdir -p data/session`)
- Native module load failure (see "Native module errors" below)

### Native module errors

`session-desktop` uses native Node.js addons (`libsession_util_nodejs`, `@signalapp/sqlcipher`). If you see errors like `Cannot find module` or `invalid ELF header`:

```bash
# Rebuild native modules against the current Node.js version
cd ../session-desktop-library && npm rebuild && cd -
npm install file:../session-desktop-library --legacy-peer-deps
npm run build
systemctl --user restart nanoclaw
```

### "Session not found" or conversation not receiving messages

The sender may need to send the first message before the bot can respond. Session is contact-request based — the bot auto-accepts all requests, but the first message establishes the conversation. Verify auto-accept is working by checking logs for `Auto-accepted contact request`.

### Finding the unregistered JID

If you missed the JID from the log, query the database directly:

```bash
# List all Session conversations seen by the bot (registered and unregistered)
sqlite3 store/messages.db \
  "SELECT DISTINCT chat_jid FROM messages WHERE chat_jid LIKE 'session:%' ORDER BY timestamp DESC LIMIT 10"
```

### Slow first response

Session swarm polling runs every ~5 seconds. First-time account initialization can take 15–30 seconds while the client fetches keys from the network. Subsequent startups are faster (account loads from DB).

## After Setup

If running `npm run dev` while the service is active:

```bash
# Linux:
systemctl --user stop nanoclaw
npm run dev
# When done:
systemctl --user start nanoclaw

# macOS:
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
npm run dev
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

## Known Limitations

- **No typing indicator**: Session doesn't expose a typing indicator in the headless API — `setTyping` is a no-op.
- **No read receipts**: The library doesn't emit read receipt events.
- **Message splitting at 2000 chars**: Long responses are split into 2000-character chunks. This is conservative; Session has no hard limit but very long messages may have delivery issues.
- **GroupV2 only**: The library only supports GroupV2 (`03`-prefix groups). Legacy GroupV1 groups can receive `leaveGroup` but not new messages from the bot.
- **Slow swarm polling**: Message delivery latency is 5–15 seconds depending on network conditions.
- **One identity per dataPath**: Each `SESSION_DATA_PATH` corresponds to one Session account. To run multiple bot identities, configure separate data paths.
- **Contact requests**: Senders must message the bot first to establish a conversation. The bot auto-accepts all contact requests.

## Removal

To remove Session integration:

1. Delete `src/channels/session.ts`
2. Remove `SessionChannel` import and creation from `src/index.ts`
3. Remove Session config (`SESSION_MNEMONIC`, `SESSION_DISPLAY_NAME`, `SESSION_DATA_PATH`, `SESSION_ONLY`) from `src/config.ts`
4. Remove Session registrations from SQLite: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'session:%'"`
5. Uninstall: `npm uninstall session-desktop`
6. Rebuild: `npm run build && systemctl --user restart nanoclaw`

The Session account data in `data/session/` is preserved. Delete that directory too if you want to fully wipe the bot's Session identity.
