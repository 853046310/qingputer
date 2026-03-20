from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _data_dir() -> Path:
    return Path(
        os.environ.get(
            "QINGCODE_DATA_DIR",
            Path.home() / "Library" / "Application Support" / "Qingputer" / "qingcode",
        )
    )


@dataclass
class QingCodeConfig:
    data_dir: Path = field(default_factory=_data_dir)
    db_name: str = "qingcode.db"
    keychain_service: str = "com.qingputer.desktop"
    max_iterations: int = 50

    @property
    def db_path(self) -> Path:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        return self.data_dir / self.db_name
