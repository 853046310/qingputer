from __future__ import annotations

from pathlib import Path

from app.config import AppConfig


def ensure_directories(config: AppConfig) -> None:
    for path in (
        config.support_directory,
        config.logs_directory,
        config.session_logs_directory,
        config.browser_profile_directory,
    ):
        Path(path).mkdir(parents=True, exist_ok=True)
