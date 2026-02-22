# Intent: src/container-runner.test.ts modifications

## What changed
Added a new `describe('container-runner BRING env vars')` test block that verifies BRING_EMAIL and BRING_PASSWORD are passed as container environment variables via `-e` flags when configured in `.env`.

## Key sections

### New describe block (after existing timeout tests)
- Added: `passes BRING credentials as container env vars when set` — mocks `readEnvFile` to return BRING credentials, verifies spawn args include `-e BRING_EMAIL=...` and `-e BRING_PASSWORD=...`
- Added: `omits BRING env vars when not configured` — mocks `readEnvFile` to return empty for BRING keys, verifies no BRING-related `-e` flags in spawn args

## Invariants (must-keep)
- All existing timeout behavior tests unchanged
- Mock setup (config, logger, fs, child_process, mount-security) unchanged
- `createFakeProcess()` helper unchanged
- Test group and input fixtures unchanged
- `emitOutputMarker()` helper unchanged
