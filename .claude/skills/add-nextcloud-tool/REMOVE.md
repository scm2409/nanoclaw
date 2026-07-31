# Remove Nextcloud Tool

Idempotent — safe to run even if some steps were never applied.

## 1. Unregister the MCP server (per group)

For each group that had Nextcloud wired (`ncl groups list` to enumerate):

```bash
ncl groups config remove-mcp-server --id <group-id> --name nextcloud
```

## 2. Delete the copied files

```bash
rm -f src/nextcloud-dockerfile.test.ts container/httpx-env-proxy-shim.py
```

Keep the shim if another Python MCP server in the image relies on it — it is generic
(it only restores httpx's env-proxy default for explicitly-built transports).

## 3. Revert the Dockerfile edits

In `container/Dockerfile`, delete the whole `Python CLIs (uv)` block — the `ARG NEXTCLOUD_MCP_VERSION`, the `COPY --from=uvbin` line, the `ENV UV_TOOL_DIR/...` line, the `RUN ... uv tool install` line, and the `COPY httpx-env-proxy-shim.py` + `RUN cp ... sitecustomize.py` pair — plus the global `ARG UV_VERSION` and the `FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uvbin` stage above the main `FROM`.

Keep the block if another skill has since added a second Python CLI to it; in that case only drop the `nextcloud-mcp-server==${NEXTCLOUD_MCP_VERSION}` spec and its `ARG`.

## 4. Rebuild and restart

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

## 5. Optional: drop the vault credential

```bash
onecli secrets list                    # find the "Nextcloud <user>" entry
onecli secrets delete --id <secret-id>
```

Also revoke the app password in Nextcloud (Settings → Security → the device entry → trash icon). Deleting the vault secret alone leaves the app password valid.

## Verification

```bash
ls src/nextcloud-dockerfile.test.ts 2>&1                  # No such file or directory
ncl groups config get --id <group-id> | grep -i nextcloud # no match
```

A wired agent asked for its Nextcloud calendars should now report it has no such tool.
