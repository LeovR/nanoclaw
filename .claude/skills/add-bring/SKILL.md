---
name: add-bring
description: Add Bring! shopping list management to NanoClaw. Agents can view, add, remove, and complete items on shared Bring! shopping lists.
---

# Add Bring! Shopping Lists

This skill adds Bring! shopping list management to NanoClaw via `bring-cli`, a CLI tool installed in the agent container. Agents can view lists, add/remove items, mark items as purchased, and send notifications.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `bring` is in `applied_skills`, skip to Phase 3 (Configure). The code changes are already in place.

### Ask the user

1. **Do they have a Bring! account?** If no, they'll need to create one at https://getbring.com
2. **Collect credentials**: Ask for their Bring! email and password.

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-bring
```

This deterministically:
- Adds `container/bring-cli/` (CLI tool: bring-cli.ts, package.json, tsconfig.json, tests)
- Adds `container/skills/bring/SKILL.md` (agent-facing documentation)
- Three-way merges bring-cli install step into `container/Dockerfile`
- Three-way merges BRING env var passing into `src/container-runner.ts`
- Three-way merges BRING env var tests into `src/container-runner.test.ts`
- Updates `.env.example` with `BRING_EMAIL` and `BRING_PASSWORD`
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent files:
- `modify/container/Dockerfile.intent.md` — what changed for Dockerfile
- `modify/src/container-runner.ts.intent.md` — what changed for container-runner.ts
- `modify/src/container-runner.test.ts.intent.md` — what changed for container-runner.test.ts

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass and build must be clean before proceeding.

## Phase 3: Configure

### Add Bring! credentials

Add to `.env`:

```bash
BRING_EMAIL=<their-email>
BRING_PASSWORD=<their-password>
```

These are read from `.env` at container launch and passed as environment variables to the container. They are never written to disk inside the container.

### Build container and restart

```bash
./container/build.sh
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 4: Verify

### Test with a shopping list request

Tell the user:

> Ask the agent about your shopping lists in any registered chat. For example: "What's on my shopping list?" or "Add milk to the groceries list."

### Check logs if needed

```bash
tail -f logs/nanoclaw.log | grep -i bring
```

Look for:
- `bring-cli` in container logs — tool being used
- Authentication errors — check credentials
- List not found — check Bring! account has lists

## Troubleshooting

### Agent doesn't recognize shopping list requests

1. Verify the container was rebuilt after applying the skill (`./container/build.sh`)
2. Check that `container/skills/bring/SKILL.md` exists (agent needs this to know about bring-cli)
3. Restart the service

### Authentication fails

1. Check `BRING_EMAIL` and `BRING_PASSWORD` in `.env` are correct
2. Try logging in to https://getbring.com with the same credentials
3. Check container logs for the specific error message

### "No list found" errors

1. Verify the Bring! account has shopping lists (check the Bring! app)
2. List names support partial matching — try a shorter search term
3. If using a shared list, ensure the account is a member of that list
