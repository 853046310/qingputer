from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import keyring

from app.config import AppConfig


class SecretStore:
    def __init__(self, config: AppConfig) -> None:
        self._service = config.keychain_service
        self._fallback_path = config.support_directory / "secrets.json"
        self._cache: dict[str, str | None] = {}
        self._loaded_keys: set[str] = set()

    def get_openai_api_key(self) -> str | None:
        value = self._get_secret("openai_api_key")
        normalized = self._normalize_api_key(value)
        self._cache_secret("openai_api_key", normalized)
        return normalized

    def get_openrouter_api_key(self) -> str | None:
        value = self._get_secret("openrouter_api_key")
        normalized = self._normalize_api_key(value)
        self._cache_secret("openrouter_api_key", normalized)
        return normalized

    def get_qingflow_api_token(self) -> str | None:
        value = self._get_secret("qingflow_api_token")
        normalized = self._normalize_api_key(value)
        self._cache_secret("qingflow_api_token", normalized)
        return normalized

    def has_openai_api_key(self) -> bool:
        return self._has_secret("openai_api_key")

    def has_openrouter_api_key(self) -> bool:
        return self._has_secret("openrouter_api_key")

    def has_qingflow_api_token(self) -> bool:
        return self._has_secret("qingflow_api_token")

    def set_openai_api_key(self, api_key: str) -> None:
        normalized = self._normalize_api_key(api_key)
        if normalized is None:
            raise ValueError("API key must be ASCII text without whitespace, and cannot be empty.")
        stored = False
        try:
            keyring.set_password(self._service, "openai_api_key", normalized)
            stored = keyring.get_password(self._service, "openai_api_key") == normalized
        except Exception:
            stored = False
        if not stored:
            self._write_fallback("openai_api_key", normalized)
        else:
            self._delete_fallback("openai_api_key")
        self._cache_secret("openai_api_key", normalized)

    def set_openrouter_api_key(self, api_key: str) -> None:
        normalized = self._normalize_api_key(api_key)
        if normalized is None:
            raise ValueError("API key must be ASCII text without whitespace, and cannot be empty.")
        stored = False
        try:
            keyring.set_password(self._service, "openrouter_api_key", normalized)
            stored = keyring.get_password(self._service, "openrouter_api_key") == normalized
        except Exception:
            stored = False
        if not stored:
            self._write_fallback("openrouter_api_key", normalized)
        else:
            self._delete_fallback("openrouter_api_key")
        self._cache_secret("openrouter_api_key", normalized)

    def set_qingflow_api_token(self, token: str) -> None:
        normalized = self._normalize_api_key(token)
        if normalized is None:
            raise ValueError("Token must be ASCII text without whitespace, and cannot be empty.")
        stored = False
        try:
            keyring.set_password(self._service, "qingflow_api_token", normalized)
            stored = keyring.get_password(self._service, "qingflow_api_token") == normalized
        except Exception:
            stored = False
        if not stored:
            self._write_fallback("qingflow_api_token", normalized)
        else:
            self._delete_fallback("qingflow_api_token")
        self._cache_secret("qingflow_api_token", normalized)

    def delete_openai_api_key(self) -> None:
        try:
            keyring.delete_password(self._service, "openai_api_key")
        except Exception:
            pass
        self._delete_fallback("openai_api_key")
        self._cache_secret("openai_api_key", None)

    def delete_openrouter_api_key(self) -> None:
        try:
            keyring.delete_password(self._service, "openrouter_api_key")
        except Exception:
            pass
        self._delete_fallback("openrouter_api_key")
        self._cache_secret("openrouter_api_key", None)

    def delete_qingflow_api_token(self) -> None:
        try:
            keyring.delete_password(self._service, "qingflow_api_token")
        except Exception:
            pass
        self._delete_fallback("qingflow_api_token")
        self._cache_secret("qingflow_api_token", None)

    def get_openai_base_url(self) -> str | None:
        return self._get_secret("openai_base_url")

    def set_openai_base_url(self, base_url: str) -> None:
        stored = False
        try:
            keyring.set_password(self._service, "openai_base_url", base_url)
            stored = keyring.get_password(self._service, "openai_base_url") == base_url
        except Exception:
            stored = False
        if not stored:
            self._write_fallback("openai_base_url", base_url)
        else:
            self._delete_fallback("openai_base_url")
        self._cache_secret("openai_base_url", base_url)

    def _get_secret(self, key: str) -> str | None:
        if key in self._loaded_keys:
            return self._cache.get(key)
        try:
            value = keyring.get_password(self._service, key)
        except Exception:
            value = None
        cached = value or self._read_fallback(key)
        self._cache_secret(key, cached)
        return cached

    def _cache_secret(self, key: str, value: str | None) -> None:
        self._cache[key] = value
        self._loaded_keys.add(key)

    def _has_secret(self, key: str) -> bool:
        if key in self._loaded_keys:
            return bool(self._cache.get(key))
        if self._read_fallback(key):
            return True
        return self._has_keychain_item(key)

    def _has_keychain_item(self, key: str) -> bool:
        if sys.platform != "darwin":
            return False
        try:
            result = subprocess.run(
                ["security", "find-generic-password", "-s", self._service, "-a", key],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
        except Exception:
            return False
        return result.returncode == 0

    def _read_fallback(self, key: str) -> str | None:
        data = self._load_fallback()
        value = data.get(key)
        return value if isinstance(value, str) and value else None

    def _write_fallback(self, key: str, value: str) -> None:
        data = self._load_fallback()
        data[key] = value
        self._fallback_path.parent.mkdir(parents=True, exist_ok=True)
        self._fallback_path.write_text(json.dumps(data, ensure_ascii=True), encoding="utf-8")
        self._fallback_path.chmod(0o600)

    def _delete_fallback(self, key: str) -> None:
        data = self._load_fallback()
        if key in data:
            data.pop(key, None)
            self._fallback_path.parent.mkdir(parents=True, exist_ok=True)
            self._fallback_path.write_text(json.dumps(data, ensure_ascii=True), encoding="utf-8")
            self._fallback_path.chmod(0o600)

    def _load_fallback(self) -> dict[str, str]:
        if not Path(self._fallback_path).exists():
            return {}
        try:
            raw = self._fallback_path.read_text(encoding="utf-8")
            payload = json.loads(raw)
        except Exception:
            return {}
        return payload if isinstance(payload, dict) else {}

    @staticmethod
    def _normalize_api_key(value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            return None
        if not normalized.isascii():
            return None
        if any(ch.isspace() for ch in normalized):
            return None
        return normalized
