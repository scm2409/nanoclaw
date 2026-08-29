# Remove Coding Subagent

Remove the installed file-based coding subagent from the agent group:

```bash
rm groups/<group-folder>/.claude/agents/coder.md
```

Replace `<group-folder>` with the agent group used during installation. Do not remove other files from `.claude/agents/`. Restart the target group through the normal NanoClaw workflow so the running container reloads its agent definitions.
