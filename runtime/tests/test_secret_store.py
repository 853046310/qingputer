from pathlib import Path

from app.config import AppConfig
from app.storage.keychain import SecretStore


def test_secret_store_caches_keychain_reads(monkeypatch, tmp_path: Path) -> None:
    calls: list[tuple[str, str]] = []

    def fake_get_password(service: str, key: str) -> str:
        calls.append((service, key))
        return "sk-test"

    monkeypatch.setattr("app.storage.keychain.keyring.get_password", fake_get_password)

    store = SecretStore(AppConfig(home_directory=tmp_path))

    assert store.get_openai_api_key() == "sk-test"
    assert store.get_openai_api_key() == "sk-test"
    assert calls == [("com.qingputer.desktop", "openai_api_key")]


def test_secret_store_checks_keychain_metadata_without_loading_secret(monkeypatch, tmp_path: Path) -> None:
    calls: list[list[str]] = []

    def fail_get_password(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("unexpected secret read")

    class FakeCompletedProcess:
        def __init__(self, returncode: int) -> None:
            self.returncode = returncode

    def fake_run(args: list[str], **_kwargs: object) -> FakeCompletedProcess:
        calls.append(args)
        return FakeCompletedProcess(returncode=0)

    monkeypatch.setattr("app.storage.keychain.keyring.get_password", fail_get_password)
    monkeypatch.setattr("app.storage.keychain.subprocess.run", fake_run)

    store = SecretStore(AppConfig(home_directory=tmp_path))

    assert store.has_openai_api_key() is True
    assert calls == [["security", "find-generic-password", "-s", "com.qingputer.desktop", "-a", "openai_api_key"]]
