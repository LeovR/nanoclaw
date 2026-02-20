---
name: setup
description: Run initial NanoClaw setup. Use when user wants to install dependencies, configure Matrix credentials, register their main channel, or start the background services. Triggers on "setup", "install", "configure nanoclaw", or first-time setup requests.
---

# NanoClaw Setup

Run setup scripts automatically. Only pause when user action is required (configuration choices, pasting credentials). Scripts live in `.claude/skills/setup/scripts/` and emit structured status blocks to stdout. Verbose logs go to `logs/setup.log`.

**Principle:** When something is broken or missing, fix it. Don't tell the user to go fix it themselves unless it genuinely requires their manual action (e.g. pasting a secret token). If a dependency is missing, install it. If a service won't start, diagnose and repair. Ask the user for permission when needed, then do the work.

**UX Note:** Use `AskUserQuestion` for all user-facing questions.

## 1. Check Environment

Run `./.claude/skills/setup/scripts/01-check-environment.sh` and parse the status block.

- If HAS_MATRIX_CONFIG=true → note that Matrix credentials exist, offer to skip step 5
- If HAS_REGISTERED_GROUPS=true → note existing config, offer to skip or reconfigure
- Record PLATFORM, APPLE_CONTAINER, and DOCKER values for step 3

**If NODE_OK=false:**

Node.js is missing or too old. Ask the user if they'd like you to install it. Offer options based on platform:

- macOS: `brew install node@22` (if brew available) or install nvm then `nvm install 22`
- Linux: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs`, or nvm

If brew/nvm aren't installed, install them first (`/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"` for brew, `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash` for nvm). After installing Node, re-run the environment check to confirm NODE_OK=true.

## 2. Install Dependencies

Run `./.claude/skills/setup/scripts/02-install-deps.sh` and parse the status block.

**If failed:** Read the tail of `logs/setup.log` to diagnose. Common fixes to try automatically:
1. Delete `node_modules` and `package-lock.json`, then re-run the script
2. If permission errors: suggest running with corrected permissions
3. If specific package fails to build (native modules like better-sqlite3): install build tools (`xcode-select --install` on macOS, `build-essential` on Linux), then retry

Only ask the user for help if multiple retries fail with the same error.

## 3. Container Runtime

### 3a. Choose runtime

Check the preflight results for `APPLE_CONTAINER` and `DOCKER`.

**If APPLE_CONTAINER=installed** (macOS only): Ask the user which runtime they'd like to use — Docker (default, cross-platform) or Apple Container (native macOS). If they choose Apple Container, run `/convert-to-apple-container` now before continuing, then skip to 3b.

**If APPLE_CONTAINER=not_found**: Use Docker (the default). Proceed to install/start Docker below.

### 3a-docker. Install Docker

- DOCKER=running → continue to 3b
- DOCKER=installed_not_running → start Docker: `open -a Docker` (macOS) or `sudo systemctl start docker` (Linux). Wait 15s, re-check with `docker info`. If still not running, tell the user Docker is starting up and poll a few more times.
- DOCKER=not_found → **ask the user for confirmation before installing.** Tell them Docker is required for running agents and ask if they'd like you to install it. If confirmed:
  - macOS: install via `brew install --cask docker`, then `open -a Docker` and wait for it to start. If brew not available, direct to Docker Desktop download at https://docker.com/products/docker-desktop
  - Linux: install with `curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER`. Note: user may need to log out/in for group membership.

### 3b. Apple Container conversion gate (if needed)

**If the chosen runtime is Apple Container**, you MUST check whether the source code has already been converted from Docker to Apple Container. Do NOT skip this step. Run:

```bash
grep -q "CONTAINER_RUNTIME_BIN = 'container'" src/container-runtime.ts && echo "ALREADY_CONVERTED" || echo "NEEDS_CONVERSION"
```

**If NEEDS_CONVERSION**, the source code still uses Docker as the runtime. You MUST run the `/convert-to-apple-container` skill NOW, before proceeding to the build step.

**If ALREADY_CONVERTED**, the code already uses Apple Container. Continue to 3c.

**If the chosen runtime is Docker**, no conversion is needed — Docker is the default. Continue to 3c.

### 3c. Build and test

Run `./.claude/skills/setup/scripts/03-setup-container.sh --runtime <chosen>` and parse the status block.

**If BUILD_OK=false:** Read `logs/setup.log` tail for the build error.
- If it's a cache issue (stale layers): run `docker builder prune -f`, then retry.
- If Dockerfile syntax or missing files: diagnose from the log and fix.
- Retry the build script after fixing.

**If TEST_OK=false but BUILD_OK=true:** The image built but won't run. Check logs — common cause is runtime not fully started. Wait a moment and retry the test.

## 4. Claude Authentication (No Script)

If HAS_ENV=true from step 1, read `.env` and check if it already has `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`. If so, confirm with user: "You already have Claude credentials configured. Want to keep them or reconfigure?" If keeping, skip to step 5.

AskUserQuestion: Claude subscription (Pro/Max) vs Anthropic API key?

**Subscription:** Tell the user:
1. Open another terminal and run: `claude setup-token`
2. Copy the token it outputs
3. Add it to the `.env` file in the project root: `CLAUDE_CODE_OAUTH_TOKEN=<token>`
4. Let me know when done

Do NOT ask the user to paste the token into the chat. Do NOT use AskUserQuestion to collect the token. Just tell them what to do, then wait for confirmation that they've added it to `.env`. Once confirmed, verify the `.env` file has the key.

**API key:** Tell the user to add `ANTHROPIC_API_KEY=<key>` to the `.env` file in the project root, then let you know when done. Once confirmed, verify the `.env` file has the key.

## 5. Matrix Configuration

If HAS_MATRIX_CONFIG=true from step 1, confirm with user: "Matrix credentials already configured. Want to keep them or reconfigure?" If keeping, skip to step 6.

Tell the user you need three values to connect to Matrix, then collect them:

1. **Homeserver URL** — e.g. `https://matrix.example.com`. Ask the user to provide it.
2. **Bot user ID** — e.g. `@botname:matrix.example.com`. The Matrix user account the bot will use. Ask the user to provide it.
3. **Access token** — Tell the user how to get one:
   - **From Element:** Settings → Help & About → scroll to "Access Token" (Advanced section)
   - **Via API:** `curl -X POST https://HOMESERVER/_matrix/client/v3/login -d '{"type":"m.login.password","user":"USERNAME","password":"PASSWORD"}'` and copy the `access_token` from the response
   - Ask the user to paste the access token (or tell you when they've added it to `.env`)

Write all three values to `.env`:
```
MATRIX_HOMESERVER_URL=<url>
MATRIX_ACCESS_TOKEN=<token>
MATRIX_BOT_USER_ID=<user_id>
```

Validate by running `./.claude/skills/setup/scripts/04-configure-matrix.sh` and parse the status block.

**If MATRIX_CONFIG=invalid:**
- `whoami_failed` → The homeserver rejected the token. Ask user to double-check the homeserver URL and access token. The token may have expired — generate a fresh one.
- `incomplete_config` → One or more values are empty. Check `.env` and fill in the missing ones.

## 6. Configure Trigger and Channel Type

AskUserQuestion: What trigger word? (default: Andy). In group rooms, messages starting with @TriggerWord go to Claude. In DM rooms, no prefix needed.

AskUserQuestion: Main channel type?
1. DM with the bot (recommended) — A direct-message room between you and the bot.
2. Group room — A Matrix room (can have multiple members).

## 7. Sync and Select Room

**For DM:** Tell the user to open their Matrix client (Element, etc.) and start a DM with the bot user (the MATRIX_BOT_USER_ID from step 5). Wait for them to confirm, then sync rooms.

**For group:** Tell the user to create a room and invite the bot user, or use an existing room where the bot is a member. Wait for them to confirm, then sync rooms.

1. Run `./.claude/skills/setup/scripts/05-sync-rooms.sh` (Bash timeout: 60000ms)
2. **If BUILD=failed:** Read `logs/setup.log`, fix the TypeScript error, re-run.
3. **If ROOMS_IN_DB=0:** Check `logs/setup.log` for the sync output. Common causes: invalid Matrix credentials (re-run step 5), bot not invited to any rooms (ask user to invite the bot).
4. Run `./.claude/skills/setup/scripts/05b-list-rooms.sh` to get rooms (pipe-separated JID|name lines). Do NOT display the output to the user.
5. Pick the most likely candidates (e.g. rooms with the trigger word or "NanoClaw" in the name, DM rooms) and present them as AskUserQuestion options — show names only, not room IDs. Include an "Other" option if their room isn't listed. If they pick Other, search by name in the DB or re-run with a higher limit.

## 8. Register Channel

Run `./.claude/skills/setup/scripts/06-register-channel.sh` with args:
- `--jid "ROOM_ID"` — from step 7
- `--name "main"` — always "main" for the first channel
- `--trigger "@TriggerWord"` — from step 6
- `--folder "main"` — always "main" for the first channel
- `--no-trigger-required` — if DM room
- `--assistant-name "Name"` — if trigger word differs from "Andy"

## 9. Mount Allowlist

AskUserQuestion: Want the agent to access directories outside the NanoClaw project? (Git repos, project folders, documents, etc.)

**If no:** Run `./.claude/skills/setup/scripts/07-configure-mounts.sh --empty`

**If yes:** Collect directory paths and permissions (read-write vs read-only). Ask about non-main group read-only restriction (recommended: yes). Build the JSON and pipe it to the script:

`echo '{"allowedRoots":[...],"blockedPatterns":[],"nonMainReadOnly":true}' | ./.claude/skills/setup/scripts/07-configure-mounts.sh`

Tell user how to grant a group access: add `containerConfig.additionalMounts` to their entry in `data/registered_groups.json`.

## 10. Start Service

If the service is already running (check `launchctl list | grep nanoclaw` on macOS), unload it first: `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist` — then proceed with a clean install.

Run `./.claude/skills/setup/scripts/08-setup-service.sh` and parse the status block.

**If SERVICE_LOADED=false:**
- Read `logs/setup.log` for the error.
- Common fix: plist already loaded with different path. Unload the old one first, then re-run.
- On macOS: check `launchctl list | grep nanoclaw` to see if it's loaded with an error status. If the PID column is `-` and the status column is non-zero, the service is crashing. Read `logs/nanoclaw.error.log` for the crash reason and fix it (common: wrong Node path, missing .env, missing Matrix config).
- On Linux: check `systemctl --user status nanoclaw` for the error and fix accordingly.
- Re-run the setup-service script after fixing.

## 11. Verify

Run `./.claude/skills/setup/scripts/09-verify.sh` and parse the status block.

**If STATUS=failed, fix each failing component:**
- SERVICE=stopped → run `npm run build` first, then restart: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `systemctl --user restart nanoclaw` (Linux). Re-check.
- SERVICE=not_found → re-run step 10.
- CREDENTIALS=missing → re-run step 4.
- MATRIX_CONFIG=missing → re-run step 5.
- REGISTERED_GROUPS=0 → re-run steps 7-8.
- MOUNT_ALLOWLIST=missing → run `./.claude/skills/setup/scripts/07-configure-mounts.sh --empty` to create a default.

After fixing, re-run `09-verify.sh` to confirm everything passes.

Tell user to test: send a message in their registered room (with or without trigger depending on channel type).

Show the log tail command: `tail -f logs/nanoclaw.log`

## Troubleshooting

**Service not starting:** Check `logs/nanoclaw.error.log`. Common causes: wrong Node path in plist (re-run step 10), missing `.env` (re-run step 4), missing Matrix config (re-run step 5).

**Container agent fails ("Claude Code process exited with code 1"):** Ensure the container runtime is running — start it with the appropriate command for your runtime. Check container logs in `groups/main/logs/container-*.log`.

**No response to messages:** Verify the trigger pattern matches. DM rooms don't need a prefix. Check the registered room ID in the database: `sqlite3 store/messages.db "SELECT * FROM registered_groups"`. Check `logs/nanoclaw.log`.

**Invalid access token:** The Matrix access token may have expired or been revoked. Generate a fresh one from Element (Settings → Help & About → Access Token) or via the login API, update it in `.env`, and restart the service.

**Homeserver unreachable:** Verify the MATRIX_HOMESERVER_URL in `.env` is correct and the server is accessible: `curl -s https://HOMESERVER/_matrix/client/versions`. Check for typos, HTTPS requirements, or network issues.

**Bot not in room:** The bot must be invited to and have joined the room. Check with: `curl -s -H "Authorization: Bearer TOKEN" https://HOMESERVER/_matrix/client/v3/joined_rooms`. If the room isn't listed, invite the bot from your Matrix client.

**E2EE rooms:** NanoClaw does not support end-to-end encrypted rooms. The bot must be in unencrypted rooms, or the room's encryption must be disabled. Create a room with encryption turned off.

**Unload service:** `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist`
