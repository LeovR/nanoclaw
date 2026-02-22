# Intent: container/Dockerfile modifications

## What changed
Added bring-cli installation step to the container image. The `bring-cli` package is copied, compiled, and installed globally so agents can use `bring-cli` as a CLI tool.

## Key sections

### After global npm install (after line 33, before WORKDIR /app)
- Added: `COPY bring-cli/ /tmp/bring-cli/` — copies bring-cli source into build context
- Added: `RUN cd /tmp/bring-cli && npm install && npx tsc && npm install -g . && rm -rf /tmp/bring-cli` — installs deps, compiles TypeScript, installs globally, cleans up

## Invariants (must-keep)
- All system dependency installation unchanged
- Chromium environment variables unchanged
- agent-browser and claude-code global install unchanged
- agent-runner copy, install, and build unchanged
- Workspace directory creation unchanged
- Entrypoint script unchanged
- User/permission configuration unchanged
- WORKDIR settings unchanged
