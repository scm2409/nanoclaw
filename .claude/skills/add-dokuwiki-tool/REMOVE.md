# Remove DokuWiki Tool

Idempotent — safe to run even if some steps were never applied.

## 1. Unregister the MCP server (per group)

For each group that had DokuWiki wired (`ncl groups list` to enumerate):

```bash
ncl groups config remove-mcp-server --id <group-id> --name dokuwiki
```

## 2. Delete the subagent and persona section

```bash
rm -f groups/<folder>/.claude/agents/dokuwiki.md
```

Manually remove the DokuWiki delegation section from that group's persona fragment.

## 3. Delete the copied files

```bash
rm -f src/dokuwiki-cli-tools.test.ts
rm -rf container/skills/dokuwiki-reviewqueue
```

Keep the container skill if another wired group still uses a DokuWiki with a review queue.

## 4. Revert the `cli-tools.json` entry

Remove the `{ "name": "mcp-remote", ... }` entry from `container/cli-tools.json`. Keep it if another skill has since started using the same bridge for a different remote MCP server.

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
onecli secrets list                    # find the "DokuWiki <agent-account>" entry
onecli secrets delete --id <secret-id>
```

Also revoke/regenerate the token in the DokuWiki agent account's profile. Deleting the vault secret alone leaves the token itself valid.

## Verification

```bash
ls src/dokuwiki-cli-tools.test.ts 2>&1        # No such file or directory
ncl groups config get --id <group-id> | grep -i dokuwiki  # no match
```

A wired agent asked to edit a wiki page should now report it has no such tool.
