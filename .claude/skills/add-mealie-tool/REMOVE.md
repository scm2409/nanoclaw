# Remove Mealie Tool

Idempotent — safe to run even if some steps were never applied.

## 1. Unregister the MCP server (per group)

For each group that had Mealie wired (`ncl groups list` to enumerate):

```bash
ncl groups config remove-mcp-server --id <group-id> --name mealie
```

## 2. Delete the subagent and persona section

```bash
rm -f groups/<folder>/.claude/agents/mealie.md
```

Manually remove the Mealie delegation section from that group's
persona/instructions file, and any Mealie-specific facts from its
local-facts document.

## 3. Delete the copied files

```bash
rm -f src/mealie-mcp-pin.test.ts
rm -rf container/skills/mealie-restricted
```

Keep the container skill if another wired group still uses a restricted-mode
Mealie server.

## 4. Revert the Dockerfile block

Remove the `ARG MEALIE_MCP_REF=...` and its following `uv tool install`
block from `container/Dockerfile`. Keep the shared `uv` stage and
`UV_TOOL_DIR`/`UV_PYTHON_INSTALL_DIR` setup if `nextcloud-mcp-server` (or
another `uv`-installed server) is still in use.

## 5. Rebuild and restart

```bash
pnpm run build && ./container/build.sh
source setup/lib/install-slug.sh

# macOS
launchctl kickstart -k gui/$(id -u)/$(launchd_label)

# Linux
systemctl --user restart $(systemd_unit)
```

Kill running agent containers so they respawn without the server:

```bash
docker ps -q --filter 'name=nanoclaw-v2-' | xargs -r docker kill
```

## 6. Optional: drop the vault credential

```bash
onecli secrets list                    # find the "Mealie <account>" entry
onecli secrets delete --id <secret-id>
```

Also revoke the token in Mealie's own user profile (API Tokens). Deleting
the vault secret alone leaves the token itself valid.

## Verification

```bash
ls src/mealie-mcp-pin.test.ts 2>&1                        # No such file or directory
ncl groups config get --id <group-id> | grep -i mealie     # no match
```

A wired agent asked about a recipe should now report it has no such tool.
