"""Read model configuration from Qingputer's runtime state.db + keychain."""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path

import keyring


_SERVICE = "com.qingputer.desktop"

_QINGPUTER_SUPPORT_DIR = Path.home() / "Library" / "Application Support" / "Qingputer"
_QINGPUTER_STATE_DB = _QINGPUTER_SUPPORT_DIR / "state.db"
_QINGPUTER_SECRETS_JSON = _QINGPUTER_SUPPORT_DIR / "secrets.json"


@dataclass
class ModelConfig:
    provider: str
    base_url: str
    model: str
    api_key: str | None
    api_key_set: bool


def _load_settings_payload() -> dict | None:
    db_path = _QINGPUTER_STATE_DB
    if not db_path.exists():
        return None
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT value_json FROM settings WHERE key = 'settings'"
        ).fetchone()
        conn.close()
        if not row:
            return None
        return json.loads(row["value_json"])
    except Exception:
        return None


def _get_secret(key: str) -> str | None:
    """Read a secret from keychain, with fallback to secrets.json."""
    try:
        value = keyring.get_password(_SERVICE, key)
        if value:
            return value
    except Exception:
        pass
    # Fallback to secrets.json
    return _read_secrets_json(key)


def _read_secrets_json(key: str) -> str | None:
    path = _QINGPUTER_SECRETS_JSON
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            value = data.get(key)
            return value if isinstance(value, str) and value else None
    except Exception:
        pass
    return None


def resolve_model_config() -> ModelConfig:
    """Return the active model config from Qingputer's settings.

    Reads state.db for provider/base_url/model, then keychain (or secrets.json)
    for the corresponding API key.
    """
    payload = _load_settings_payload()
    if payload is None:
        payload = {}

    provider = payload.get("model_provider", "openai")

    if provider == "openrouter":
        base_url = payload.get("openrouter_base_url", "https://openrouter.ai/api/v1")
        model = payload.get("openrouter_model", "openai/gpt-4.1")
        api_key = _get_secret("openrouter_api_key")
        api_key_set = payload.get("openrouter_api_key_set", False) or api_key is not None
    else:
        # openai (default)
        base_url = payload.get("openai_base_url", "https://api.openai.com/v1")
        model = payload.get("openai_model", "gpt-4.1")
        api_key = _get_secret("openai_api_key")
        api_key_set = payload.get("openai_api_key_set", False) or api_key is not None

    return ModelConfig(
        provider=provider,
        base_url=base_url,
        model=model,
        api_key=api_key,
        api_key_set=api_key_set,
    )
