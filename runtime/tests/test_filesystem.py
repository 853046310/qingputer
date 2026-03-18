from pathlib import Path

from app.config import AppConfig
from app.capabilities.filesystem import FilesystemCapability


def test_write_then_read_round_trip(tmp_path: Path) -> None:
    capability = FilesystemCapability(AppConfig(home_directory=tmp_path))
    target = tmp_path / "hello.txt"

    capability.write_file(str(target), "hello world")
    payload = capability.read_file(str(target))

    assert payload["content"] == "hello world"
    assert payload["truncated"] is False


def test_directory_listing_returns_entries(tmp_path: Path) -> None:
    capability = FilesystemCapability(AppConfig(home_directory=tmp_path))
    (tmp_path / "one.txt").write_text("1", encoding="utf-8")
    (tmp_path / "two.txt").write_text("2", encoding="utf-8")

    payload = capability.list_directory(str(tmp_path))

    names = [entry["name"] for entry in payload["entries"]]
    assert names == ["one.txt", "two.txt"]
