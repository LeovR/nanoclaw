# Intent: src/container-runner.ts modifications

## What changed
Added BRING_EMAIL and BRING_PASSWORD environment variable passing to agent containers via the `buildContainerArgs()` function.

## Key sections

### buildContainerArgs() (after user ID block, before volume mount loop)
- Added: `readEnvFile(['BRING_EMAIL', 'BRING_PASSWORD'])` call to read Bring! credentials from `.env`
- Added: Loop that pushes `-e KEY=VALUE` args for each credential found
- Uses existing `readEnvFile` import (already imported on line 18)

## Invariants (must-keep)
- All volume mount logic unchanged
- readSecrets() function unchanged (secrets are passed via stdin, not env vars)
- Container name generation unchanged
- Timeout, streaming, and output parsing logic unchanged
- runContainerAgent() function signature unchanged
- writeTasksSnapshot() and writeGroupsSnapshot() unchanged
- All existing -e flags (HOME, user) unchanged
