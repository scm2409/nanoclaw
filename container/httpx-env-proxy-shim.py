"""Make explicitly-constructed httpx transports honor the proxy environment.

Installed as `sitecustomize.py` inside a Python MCP server's virtualenv, so it
loads before any server code runs.

Why this exists: `httpx.Client`/`AsyncClient` resolve HTTPS_PROXY from the
environment themselves, but only when they build their own transport. Code that
passes `transport=httpx.AsyncHTTPTransport(...)` explicitly gets a transport with
`proxy=None`, and httpx then routes every request directly — silently bypassing
the OneCLI gateway. In NanoClaw that means no credential injection, so the
request arrives at the upstream API with the literal `onecli-managed`
placeholder and comes back 401, while the very same URL works from curl.

`nextcloud-mcp-server` does exactly this in its `nextcloud_httpx_transport()`
factory (its CalDAV path uses niquests, which does read the environment — hence
calendars work and Deck does not). Rather than forking the server, this shim
gives an explicitly-built transport the same default the client would have
picked: the proxy from the environment, unless the caller passed one.

Scope: the virtualenv it is installed into, which holds exactly one tool.
"""

import os

try:
    import httpx
except Exception:  # pragma: no cover - venv without httpx: nothing to patch
    httpx = None


_PROXY_ENV_VARS = ("HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy")


def _env_proxy():
    for name in _PROXY_ENV_VARS:
        value = os.environ.get(name)
        if value:
            return value
    return None


def _patch(cls):
    if getattr(cls, "_nanoclaw_env_proxy_patched", False):
        return
    original_init = cls.__init__

    def __init__(self, *args, **kwargs):
        if kwargs.get("proxy") is None:
            proxy = _env_proxy()
            if proxy is not None:
                kwargs["proxy"] = proxy
        original_init(self, *args, **kwargs)

    __init__.__wrapped__ = original_init
    cls.__init__ = __init__
    cls._nanoclaw_env_proxy_patched = True


if httpx is not None:
    for _cls_name in ("AsyncHTTPTransport", "HTTPTransport"):
        _cls = getattr(httpx, _cls_name, None)
        if _cls is not None:
            _patch(_cls)
