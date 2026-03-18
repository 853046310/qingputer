from __future__ import annotations

from typing import Any

from app.mcp import McpManager


class McpCapability:
    def __init__(self, manager: McpManager) -> None:
        self._manager = manager

    async def call_tool(self, server_id: str, tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        return await self._manager.call_tool(server_id, tool_name, arguments)
