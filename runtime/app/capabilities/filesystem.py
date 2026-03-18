from __future__ import annotations

import base64
import difflib
from pathlib import Path

from app.config import AppConfig


class FilesystemCapability:
    def __init__(self, config: AppConfig) -> None:
        self._config = config

    def read_file(self, path: str, encoding: str = "utf8") -> dict[str, object]:
        target = Path(path).expanduser().resolve()
        if encoding == "base64":
            raw = target.read_bytes()
            truncated = len(raw) > self._config.file_read_limit_bytes
            raw = raw[: self._config.file_read_limit_bytes]
            return {
                "path": str(target),
                "encoding": "base64",
                "content": base64.b64encode(raw).decode("ascii"),
                "truncated": truncated,
            }
        raw = target.read_bytes()
        truncated = len(raw) > self._config.file_read_limit_bytes
        raw = raw[: self._config.file_read_limit_bytes]
        return {
            "path": str(target),
            "encoding": "utf8",
            "content": raw.decode("utf-8", errors="replace"),
            "truncated": truncated,
        }

    def write_file(self, path: str, content: str, encoding: str = "utf8", mode: str = "overwrite") -> dict[str, object]:
        target = Path(path).expanduser().resolve()
        target.parent.mkdir(parents=True, exist_ok=True)
        existed = target.exists()
        previous_text = ""
        if existed:
            previous_text = target.read_text(encoding="utf-8", errors="replace")

        if mode == "create" and existed:
            raise FileExistsError(f"Refusing to overwrite existing file: {target}")

        if mode == "append":
            if encoding == "base64":
                chunk = base64.b64decode(content.encode("ascii"))
                with target.open("ab") as handle:
                    handle.write(chunk)
            else:
                with target.open("a", encoding="utf-8") as handle:
                    handle.write(content)
            current_text = target.read_text(encoding="utf-8", errors="replace")
        else:
            temp_path = target.with_name(f".{target.name}.qingputer.tmp")
            if encoding == "base64":
                temp_path.write_bytes(base64.b64decode(content.encode("ascii")))
                current_text = temp_path.read_text(encoding="utf-8", errors="replace") if self._looks_textual(temp_path) else ""
            else:
                temp_path.write_text(content, encoding="utf-8")
                current_text = content
            temp_path.replace(target)

        diff = ""
        if previous_text or current_text:
            diff = "\n".join(
                difflib.unified_diff(
                    previous_text.splitlines(),
                    current_text.splitlines(),
                    fromfile=f"{target}.before",
                    tofile=str(target),
                    lineterm="",
                )
            )
        return {
            "path": str(target),
            "mode": mode,
            "bytes_written": target.stat().st_size,
            "diff_preview": diff[: self._config.file_excerpt_bytes],
        }

    def list_directory(self, path: str) -> dict[str, object]:
        target = Path(path).expanduser().resolve()
        entries = []
        for item in sorted(target.iterdir(), key=lambda entry: entry.name.lower()):
            stat = item.stat()
            entries.append(
                {
                    "name": item.name,
                    "path": str(item),
                    "is_dir": item.is_dir(),
                    "size": stat.st_size,
                    "mtime": stat.st_mtime,
                }
            )
        return {"path": str(target), "entries": entries}

    @staticmethod
    def _looks_textual(path: Path) -> bool:
        try:
            path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            return False
        return True
