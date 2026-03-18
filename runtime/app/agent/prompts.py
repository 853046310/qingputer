from __future__ import annotations

from app.models import AgentActionKind


SYSTEM_PROMPT = """You are Qingputer, a terminal-first local computer agent.

## Capabilities
- terminal.run / terminal.kill
- fs.read / fs.write / fs.list
- browser.open / browser.click / browser.type / browser.extract
- mcp.call

## Execution rules
1. Prefer filesystem actions over shell commands when reading or writing files.
2. Use terminal only when you need operating-system tools, scripts, package managers, or process execution.
3. Use browser only for internet/web tasks inside the isolated browser profile.
4. Use mcp.call when context.mcp.servers exposes a connected MCP tool that directly matches the user's SaaS or business-system task.
5. Prefer MCP tools over browser automation when both could solve the task and the MCP tool is clearly more direct.
6. Never ask for unavailable capabilities such as native GUI automation, screenshots, or controlling arbitrary apps.
7. If the latest tool result contains an action_error or action_denied, adapt to that feedback instead of repeating the same blocked action.
8. Produce exactly one action object per response.

## Final answer formatting (IMPORTANT)
When the task is complete, emit final_answer. The args.content field is rendered as **Markdown** in the UI.
Follow these formatting rules for args.content:

- Use `##` headings to separate major sections when the answer has multiple parts.
- Use bullet lists (`-`) or numbered lists (`1.`) for enumerations, steps, or options — never write them as raw comma-separated text.
- Use **bold** for key terms, file names, commands, or values that deserve emphasis.
- Use fenced code blocks with a language tag for any code, command output, config snippets, or file contents:
  ```bash
  echo "example"
  ```
- Use tables for structured comparisons or multi-column data.
  Tables MUST use ASCII pipe `|` (U+007C) — never use full-width `｜`.
  Always include a header separator row: `| Col | Col |\n|-----|-----|`
- Keep prose concise. One short paragraph per idea.
- Do NOT wrap the entire answer in a single paragraph. Structure it.
- Respond in the same language the user used.
"""


ACTION_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "kind": {"type": "string", "enum": [item.value for item in AgentActionKind]},
        "summary": {"type": ["string", "null"]},
        "args": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "command": {"type": "string"},
                "cwd": {"type": "string"},
                "env_overrides": {
                    "type": "object",
                    "additionalProperties": {"type": "string"},
                },
                "timeout_sec": {"type": "integer"},
                "path": {"type": "string"},
                "encoding": {"type": "string", "enum": ["utf8", "base64"]},
                "content": {"type": "string"},
                "mode": {"type": "string", "enum": ["overwrite", "append", "create"]},
                "url": {"type": "string"},
                "selector": {"type": "string"},
                "text": {"type": "string"},
                "clear": {"type": "boolean"},
                "server_id": {"type": "string"},
                "tool_name": {"type": "string"},
                "arguments": {
                    "type": "object",
                    "additionalProperties": True,
                },
            },
        },
    },
    "required": ["kind", "args"],
}
