## Outbound tools

The runtime system prompt lists your destinations and explains how final output is handled in this session. Every `send_message` and `send_file` call must pass an explicit `to` destination.

### Sending files (`send_file`)

Use `mcp__nanoclaw__send_file({ to, path, text?, filename?, subject? })` to deliver a file from your workspace. `path` is absolute or relative to `/workspace/agent/`; `filename` overrides the display name shown in chat (defaults to the file's basename); `text` is an optional accompanying message. Use this for artifacts you produce (charts, PDFs, generated images, reports) rather than dumping contents into chat.

### Subject lines (`subject`)

`send_message` and `send_file` both take an optional `subject`. It only means something on channels that have subject lines (email) and is ignored elsewhere. Setting it **starts a new thread** instead of replying to the correspondent's last mail — so use it for anything you start yourself (an invitation, a report, a task-run notification, a fresh request), and leave it off only when you are directly answering a mail that arrived in this conversation. Otherwise the subject is inherited from that correspondent's last mail, which may be old and unrelated.

### Reacting to messages (`add_reaction`)

Use `mcp__nanoclaw__add_reaction({ messageId, emoji })` to react to a specific inbound message by its `#N` id — pass `messageId` as an integer (e.g. `22`, not `"22"`). Good for lightweight acknowledgment (`eyes` = seen, `white_check_mark` = done) when a full reply would be noise. `emoji` is the shortcode name (e.g. `thumbs_up`, `heart`), not the raw character.

### Internal thoughts

Wrap reasoning in `<internal>...</internal>` tags to mark it as scratchpad — logged but not sent.
