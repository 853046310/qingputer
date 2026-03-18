from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _default_shell() -> str:
    return os.environ.get("SHELL", "/bin/zsh")


@dataclass(slots=True)
class AppConfig:
    app_name: str = "Qingputer"
    keychain_service: str = "com.qingputer.desktop"
    openai_model: str = "gpt-4.1"
    idle_timeout_minutes: int = 60
    absolute_timeout_hours: int = 8
    event_context_limit: int = 50
    command_tail_lines: int = 200
    file_excerpt_bytes: int = 16 * 1024
    file_read_limit_bytes: int = 1024 * 1024
    page_excerpt_bytes: int = 16 * 1024
    login_shell: str = _default_shell()
    home_directory: Path = Path.home()
    enable_default_mcp_servers: bool = True

    @property
    def support_directory(self) -> Path:
        return self.home_directory / "Library" / "Application Support" / self.app_name

    @property
    def logs_directory(self) -> Path:
        return self.home_directory / "Library" / "Logs" / self.app_name

    @property
    def browser_profile_directory(self) -> Path:
        return self.support_directory / "browser" / "default"

    @property
    def database_path(self) -> Path:
        return self.support_directory / "state.db"

    @property
    def session_logs_directory(self) -> Path:
        return self.logs_directory / "sessions"
