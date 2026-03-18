from __future__ import annotations

import json
from pathlib import Path

from app.config import AppConfig
from app.models import EventEnvelope


class AuditLogger:
    def __init__(self, config: AppConfig) -> None:
        self._directory = config.session_logs_directory

    def append(self, event: EventEnvelope) -> None:
        target = Path(self._directory) / f"{event.session_id}.jsonl"
        with target.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event.model_dump(mode="json"), ensure_ascii=True))
            handle.write("\n")

    def export_path(self, session_id: str) -> Path:
        return Path(self._directory) / f"{session_id}.jsonl"
