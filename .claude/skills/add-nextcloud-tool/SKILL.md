---
name: add-nextcloud-tool
description: Add Nextcloud as an MCP tool (calendar/CalDAV events and tasks, Deck boards and cards, optionally notes/contacts/files) using OneCLI-managed HTTP Basic auth. No app password ever reaches the container — the gateway rewrites the Authorization header at request time.
---

# Add Nextcloud Tool (OneCLI-native)

This skill wires [`nextcloud-mcp-server`](https://github.com/cbcoutinho/nextcloud-mcp-server) into selected agent groups. The MCP server is configured with the literal placeholder `onecli-managed` as its password; the OneCLI gateway intercepts outbound calls to the Nextcloud host and replaces the `Authorization` header with a real `Basic` credential from its vault.

**Why this package:** it is the only actively maintained Nextcloud MCP server that covers both CalDAV calendars/tasks *and* Deck boards, and it has a per-app tool switch (`-e/--enable-app`) so the tool surface stays small. It is Python, not Node — hence the `uv` block in the Dockerfile rather than an entry in `cli-tools.json`.

**Why the tool surface matters:** the server can register 110+ tools across a dozen Nextcloud apps. Every registered tool sits in the system prompt with its full JSON schema on *every* turn. Enable only the apps the group actually needs; adding one later is an `--args` change plus a container restart, no image rebuild.

Tools appear as `mcp__nextcloud__<name>`.

## Phase 1: Nextcloud-side prerequisites

These cannot be done from NanoClaw — the operator does them in the Nextcloud web UI:

1. **App password.** Settings → Security → "Create new app password". Mandatory when 2FA is on; it is shown exactly once. Never use the account login password.
2. **Enable the apps.** Calendar and Deck must be installed and enabled for that account. Without Deck, `/index.php/apps/deck/api/v1.0/boards` returns 404, not 403.
3. **Prefer a dedicated Nextcloud user for the agent**, with the relevant calendars and Deck boards explicitly shared to it (write permission). The agent's tools can delete events and cards; a dedicated account bounds the blast radius to what was shared.
4. **Brute-force protection.** Nextcloud throttles per source IP, and every agent container appears as the same IP (the OneCLI gateway's egress). Don't loop failing auth tests; add the IP to `bruteforce.protection.allowlist` in `config.php` if it gets stuck.
5. **Self-hosted with a private CA or self-signed cert only:** the *gateway* must trust the upstream certificate, and `NEXTCLOUD_CA_BUNDLE` must point at a bundle inside the container. With a public domain and a valid certificate, neither is needed.

There is no separate "enable the API" setting — CalDAV and the Deck REST API come with the apps.

## Phase 2: Store the credential in the OneCLI vault

OneCLI 2.2.5 has no Basic-auth secret type; Basic is expressed generically as a header template, and the base64 must be produced by hand.

Never pass the app password as a command-line argument — it would land in shell history. Read it interactively:

```bash
read -rp  'Nextcloud username: '     NC_USER
read -rp  'Nextcloud host (no scheme, e.g. cloud.example.org): ' NC_HOST
read -rsp 'Nextcloud app password: ' NC_PW; echo

onecli secrets create \
  --name "Nextcloud ${NC_USER}" \
  --type generic \
  --value "$(printf '%s:%s' "$NC_USER" "$NC_PW" | base64 -w0)" \
  --host-pattern "$NC_HOST" \
  --header-name "Authorization" \
  --value-format "Basic {value}"

unset NC_PW
```

**Scope caveat.** An OneCLI agent in `secretMode: all` receives every vault secret whose host pattern matches — so this secret applies to any agent group that talks to that host, not only the wired one. Check with `onecli agents list`. To restrict it, put the other agents in `selective` mode and assign their secrets explicitly; `onecli agents set-secrets` **replaces** the whole list, so read-merge-write.

### Verify the injection before touching the image

Two assumptions have to hold, and both are cheap to test. `onecli run` puts the same proxy environment around a local command that a container gets:

```bash
# 1) Does the gateway OVERRIDE a client-supplied Authorization header?
onecli run -- curl -s -o /dev/null -w '%{http_code}\n' \
  -u "dummy:onecli-managed" -H 'OCS-APIRequest: true' \
  "https://$NC_HOST/ocs/v2.php/cloud/user?format=json"
# expect 200 — 401 means the gateway only fills a missing header, and the
# placeholder-password design below cannot work.

# 2) Do CalDAV verbs survive the proxy?
onecli run -- curl -s -o /dev/null -w '%{http_code}\n' \
  -X PROPFIND -u "dummy:onecli-managed" -H 'Depth: 0' \
  "https://$NC_HOST/remote.php/dav/calendars/$NC_USER/"
# expect 207 Multi-Status
```

If (1) returns 401, stop and decide with the operator: either the app password goes into the group's MCP `env` in clear text (stored in `data/v2.db` and materialized into `groups/<folder>/container.json`), or this integration doesn't ship. Do not silently switch.

## Phase 3: Apply code changes

### Check if already applied

```bash
grep -q 'NEXTCLOUD_MCP_VERSION' container/Dockerfile && \
echo "ALREADY APPLIED — skip to Phase 4"
```

### Add the Python CLI to the image

`container/Dockerfile` is `node:22-slim` and `container/cli-tools.json` only handles pnpm globals, so this server needs its own block. Insert it before the `ncl CLI wrapper` section (which is before `USER node`):

```dockerfile
ARG UV_VERSION=0.11.32
ARG NEXTCLOUD_MCP_VERSION=0.145.0
COPY --from=ghcr.io/astral-sh/uv:${UV_VERSION} /uv /usr/local/bin/uv
ENV UV_TOOL_DIR=/opt/uv/tools \
    UV_PYTHON_INSTALL_DIR=/opt/uv/python \
    UV_TOOL_BIN_DIR=/usr/local/bin
RUN --mount=type=cache,target=/root/.cache/uv \
    uv tool install --python 3.12 "nextcloud-mcp-server==${NEXTCLOUD_MCP_VERSION}" && \
    chmod -R a+rX /opt/uv
```

Directly after it, install the httpx proxy shim into the server's virtualenv:

```bash
cp .claude/skills/add-nextcloud-tool/httpx-env-proxy-shim.py container/httpx-env-proxy-shim.py
```

```dockerfile
COPY httpx-env-proxy-shim.py /tmp/httpx-env-proxy-shim.py
RUN cp /tmp/httpx-env-proxy-shim.py \
       "$(ls -d /opt/uv/tools/nextcloud-mcp-server/lib/python3.*/site-packages)/sitecustomize.py" && \
    rm /tmp/httpx-env-proxy-shim.py
```

**Why the shim is not optional.** The server builds its own httpx transport in
`nextcloud_httpx_transport()`, and httpx only resolves `HTTPS_PROXY` when *it* builds the
transport — an explicitly passed one routes directly. Those requests therefore bypass the
OneCLI gateway, arrive at Nextcloud carrying the literal `onecli-managed` placeholder, and
come back 401 while the identical URL answers 200 from `curl` in the same container. It
splits by code path: calendars work (CalDAV goes through niquests, which does read the
environment), Deck does not. The shim gives an explicitly-built transport the proxy the
client would have picked. Verified in-container:

```
default client       -> 200
explicit transport   -> 401
explicit transport + proxy -> 200
```

- `uv` brings its own Python — no `apt install python3`, no second system package manager in `PATH`.
- `UV_TOOL_DIR` / `UV_PYTHON_INSTALL_DIR` must be redirected out of `/root`: the container runs as `node` and cannot read root's home. `chmod -R a+rX` makes the resulting tree readable.
- Both pins are hand-picked. PyPI is outside pnpm's `minimumReleaseAge` gate, so check the release date on PyPI and take something at least a week old rather than the newest tag.
- Cost: roughly 150–250 MB of image, and it applies to *every* agent group, not just the wired one.

`container/agent-runner/src/providers/claude.ts` derives the allow-pattern from each group's `mcpServers` map, so registering the server in Phase 4 automatically allows `mcp__nextcloud__*`.

### Install the dependency-guard test

The server is a stdio CLI, not an imported module — `tsc` and the runtime tests never reference it, so the Dockerfile edit is the only in-tree footprint worth guarding:

```bash
cp .claude/skills/add-nextcloud-tool/nextcloud-dockerfile.test.ts src/nextcloud-dockerfile.test.ts
pnpm exec vitest run src/nextcloud-dockerfile.test.ts
```

`cp` overwrites in place, so re-running this skill is safe. The Phase 4 `ncl` call is a runtime write to the central DB and leaves no source line a test could catch; it is verified at runtime in Phase 6 instead.

### Rebuild

```bash
./container/build.sh
```

Sanity-check the binary landed and the app switch exists in this version:

```bash
docker run --rm --entrypoint nextcloud-mcp-server nanoclaw-agent:latest run --help | grep -A2 enable-app
```

## Phase 4: Wire per agent group

Persist to the **central DB** (`data/v2.db`). Editing `groups/<folder>/container.json` by hand does not stick — `materializeContainerJson` (`src/container-config.ts`) regenerates it on every spawn.

```bash
ncl groups config add-mcp-server \
  --id <group-id> \
  --name nextcloud \
  --command nextcloud-mcp-server \
  --args '["run","--transport","stdio","-e","calendar","-e","deck"]' \
  --env '{"NEXTCLOUD_HOST":"https://<host>","NEXTCLOUD_USERNAME":"<user>","NEXTCLOUD_PASSWORD":"onecli-managed","MCP_DEPLOYMENT_MODE":"single_user_basic","SSL_CERT_FILE":"/tmp/onecli-combined-ca.pem","REQUESTS_CA_BUNDLE":"/tmp/onecli-combined-ca.pem","CURL_CA_BUNDLE":"/tmp/onecli-combined-ca.pem"}'
```

- `NEXTCLOUD_PASSWORD=onecli-managed` is the stub convention from `container/skills/onecli-gateway/SKILL.md`. The real value is added at the proxy; nothing on disk in the container is usable.
- The gateway MITMs TLS, so its CA has to be trusted: `/tmp/onecli-combined-ca.pem` is written into every container by `applyContainerConfig` (public roots plus the gateway CA). httpx picks it up via `SSL_CERT_FILE`, caldav/niquests via `REQUESTS_CA_BUNDLE`.
- **Do not set `NEXTCLOUD_CA_BUNDLE`,** even though it looks like the intended knob. It makes `get_nextcloud_ssl_verify()` return an `ssl.SSLContext`, and the caldav/niquests stack rejects that object — every calendar call then dies with `CERTIFICATE_VERIFY_FAILED: self-signed certificate in certificate chain`. The same bundle as a plain path string works, which is exactly what the two env vars above produce.
- No mount and no mount-allowlist entry: unlike the Gmail/Calendar servers, this one writes no token file back.
- Enabling more apps later (`-e webdav`, `-e contacts`, `-e notes`, `-e tables`) is a re-run of this same command with extended `--args` — it overwrites the named entry — plus a container restart. No rebuild.
- From inside a container this verb is approval-gated; from a host operator shell it executes immediately. The response says which path it took.

## Phase 5: Build and restart

```bash
pnpm run build
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
systemctl --user restart $(systemd_unit)              # Linux
docker ps -q --filter 'name=nanoclaw-v2-' | xargs -r docker kill
```

## Phase 6: Verify

From a wired agent:

> "Which calendars do I have?" · "Add an event tomorrow at 15:00 called Test" · "Which Deck boards exist?" · "Create a card X in stack Y"

Then have it delete what it created — that exercises the write and delete paths too. First call takes a few seconds while the Python server starts.

Log signals (`tail -100 logs/nanoclaw.log | grep -iE 'nextcloud|mcp'`):

- `command not found: nextcloud-mcp-server` → image not rebuilt, or `UV_TOOL_BIN_DIR` not on `PATH`.
- `Permission denied` reading `/opt/uv/...` → the `chmod -R a+rX` step is missing; the `node` user cannot read uv's default tree.
- `401 Unauthorized` from the Nextcloud host → the gateway isn't injecting. Check `onecli agents list` (secret mode) and re-run the Phase 2 verification.
- Calendars work but **Deck** returns 401 → the shim is missing or didn't land in the venv. Confirm with `docker run --rm --entrypoint sh <image> -c 'ls -l /opt/uv/tools/nextcloud-mcp-server/lib/python3.*/site-packages/sitecustomize.py'`.
- `CERTIFICATE_VERIFY_FAILED ... self-signed certificate in certificate chain` → either the CA env vars are missing, or `NEXTCLOUD_CA_BUNDLE` is set and must be removed (see Phase 4).
- `404` on Deck endpoints → the Deck app isn't enabled for that Nextcloud account.
- Agent says it has no Nextcloud tools → the server isn't in that group's `mcpServers` (re-run Phase 4 and restart the group).

Container logs vanish on exit (`--rm`), so the host log is the only trail.

## Removal

See [REMOVE.md](REMOVE.md).

## Credits & references

- **MCP server:** [`cbcoutinho/nextcloud-mcp-server`](https://github.com/cbcoutinho/nextcloud-mcp-server) — AGPL-3.0, Python, covers Notes, Calendar, Contacts, Deck, WebDAV, Tables and more.
- **Skill pattern:** sibling of [`/add-gcal-tool`](../add-gcal-tool/SKILL.md); same "container never sees the credential" mechanism, but HTTP Basic instead of OAuth bearer.
