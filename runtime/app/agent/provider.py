from __future__ import annotations

import asyncio
import json
from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable
from typing import Any

import httpx
from pydantic import ValidationError

from app.agent.prompts import ACTION_SCHEMA, SYSTEM_PROMPT
from app.config import AppConfig
from app.models import AgentAction
from app.storage import Database, SecretStore


class ProviderError(RuntimeError):
    pass


class RetryableProviderError(ProviderError):
    pass


class BaseProvider(ABC):
    @abstractmethod
    def configuration_error(self) -> str | None:
        raise NotImplementedError

    @abstractmethod
    async def next_action(
        self,
        context: dict[str, Any],
        on_chunk: Callable[[str], Awaitable[None]] | None = None,
    ) -> AgentAction:
        raise NotImplementedError


class OpenAIProvider(BaseProvider):
    _REQUEST_TIMEOUT = httpx.Timeout(connect=10.0, read=120.0, write=30.0, pool=10.0)
    _MAX_ATTEMPTS = 3
    _RETRYABLE_STATUS_CODES = {408, 409, 425, 429, 500, 502, 503, 504}

    def __init__(self, config: AppConfig, database: Database, secret_store: SecretStore) -> None:
        self._config = config
        self._database = database
        self._secret_store = secret_store

    def configuration_error(self) -> str | None:
        api_key = self._secret_store.get_openai_api_key()
        if not api_key:
            return "OpenAI API key is missing or invalid. Open 全局设置 and save a valid API key before sending a task."
        return None

    async def next_action(
        self,
        context: dict[str, Any],
        on_chunk: Callable[[str], Awaitable[None]] | None = None,
    ) -> AgentAction:
        api_key = self._secret_store.get_openai_api_key()
        if not api_key:
            raise ProviderError(self.configuration_error() or "OpenAI API key is not configured.")
        settings = self._database.load_settings()
        base_url = (settings.openai_base_url or self._config_default_base_url()).rstrip("/")
        payload = {
            "model": settings.openai_model or self._config.openai_model,
            "messages": self._format_messages(context),
            "temperature": 0.1,
            "response_format": {"type": "json_object"},
        }
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        last_error: ProviderError | None = None
        for attempt in range(1, self._MAX_ATTEMPTS + 1):
            try:
                accumulated = await self._request_action_text(
                    base_url=base_url,
                    headers=headers,
                    payload=payload,
                    on_chunk=on_chunk,
                )
                return self._parse_action(accumulated)
            except RetryableProviderError as exc:
                last_error = ProviderError(self._decorate_retry_message(str(exc), attempt))
                if attempt >= self._MAX_ATTEMPTS:
                    raise last_error
                await asyncio.sleep(0.6 * attempt)
            except httpx.TimeoutException as exc:
                last_error = ProviderError(self._decorate_retry_message(self._describe_timeout_error(exc), attempt))
                if attempt >= self._MAX_ATTEMPTS:
                    raise last_error from exc
                await asyncio.sleep(0.6 * attempt)
            except httpx.TransportError as exc:
                last_error = ProviderError(self._decorate_retry_message(self._describe_transport_error(exc), attempt))
                if attempt >= self._MAX_ATTEMPTS:
                    raise last_error from exc
                await asyncio.sleep(0.6 * attempt)
            except ProviderError:
                raise
        raise last_error or ProviderError("Provider request failed for an unknown reason.")

    async def _request_action_text(
        self,
        *,
        base_url: str,
        headers: dict[str, str],
        payload: dict[str, Any],
        on_chunk: Callable[[str], Awaitable[None]] | None = None,
    ) -> str:
        async with httpx.AsyncClient(timeout=self._REQUEST_TIMEOUT) as client:
            response = await client.post(
                f"{base_url}/chat/completions",
                headers=headers,
                json=payload,
            )
        if response.status_code >= 400:
            raise self._build_api_error(response.status_code, response.text)
        try:
            response_payload = response.json()
        except json.JSONDecodeError as exc:
            raise RetryableProviderError(
                f"Provider returned an invalid JSON envelope: {exc}. Response excerpt: {self._compact_detail(response.text, limit=160)}"
            ) from exc
        content = self._extract_text(response_payload).strip()
        if not content:
            raise RetryableProviderError("Provider returned an empty response body for the next agent action.")
        if on_chunk:
            await on_chunk(content)
        return content

    def _parse_action(self, accumulated: str) -> AgentAction:
        try:
            parsed = json.loads(accumulated)
        except json.JSONDecodeError:
            parsed = self._extract_embedded_json_object(accumulated)
            if parsed is None:
                raise RetryableProviderError(
                    "Provider returned invalid JSON for agent action. "
                    f"Response excerpt: {self._compact_detail(accumulated, limit=200)}"
                )
        try:
            return AgentAction.model_validate(parsed)
        except ValidationError as exc:
            raise RetryableProviderError(
                "Provider returned an action payload that did not match the expected schema. "
                f"Validation detail: {self._compact_detail(str(exc), limit=200)}"
            ) from exc

    def _format_messages(self, context: dict[str, Any]) -> list[dict[str, Any]]:
        rendered = [{"role": "system", "content": SYSTEM_PROMPT}]
        context_blob = json.dumps(context, ensure_ascii=True, indent=2)
        rendered.append(
            {
                "role": "user",
                "content": (
                    "Plan the next single action for this local agent session.\n"
                    "Use the supplied context as the full source of truth.\n"
                    "Return exactly one JSON object with this shape: "
                    f"{json.dumps(ACTION_SCHEMA, ensure_ascii=True)}\n"
                    f"{context_blob}"
                ),
            }
        )
        return rendered

    @staticmethod
    def _extract_text(payload: dict[str, Any]) -> str:
        for choice in payload.get("choices", []):
            message = choice.get("message", {})
            content = message.get("content")
            if isinstance(content, str):
                return content
            if isinstance(content, list):
                parts: list[str] = []
                for item in content:
                    if not isinstance(item, dict):
                        continue
                    text = item.get("text")
                    if isinstance(text, str):
                        parts.append(text)
                if parts:
                    return "".join(parts)
        raise ProviderError("Provider response did not contain message content.")

    def _config_default_base_url(self) -> str:
        return "https://api.openai.com/v1"

    def _build_api_error(self, status_code: int, body: str) -> ProviderError:
        detail = self._compact_detail(body)
        message = f"Provider API error {status_code}"
        if detail:
            message = f"{message}: {detail}"
        if status_code in self._RETRYABLE_STATUS_CODES:
            return RetryableProviderError(message)
        return ProviderError(message)

    @staticmethod
    def _compact_detail(detail: str, limit: int = 240) -> str:
        compact = " ".join(detail.strip().split())
        if not compact:
            return ""
        if len(compact) <= limit:
            return compact
        return f"{compact[:limit].rstrip()}..."

    def _decorate_retry_message(self, message: str, attempt: int) -> str:
        if attempt >= self._MAX_ATTEMPTS:
            return f"{message} (after {self._MAX_ATTEMPTS} attempts)"
        return f"{message} (attempt {attempt}/{self._MAX_ATTEMPTS}, retrying)"

    @staticmethod
    def _extract_embedded_json_object(payload: str) -> dict[str, Any] | None:
        decoder = json.JSONDecoder()
        for index, char in enumerate(payload):
            if char != "{":
                continue
            try:
                parsed, _ = decoder.raw_decode(payload[index:])
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                return parsed
        return None

    @staticmethod
    def _describe_timeout_error(exc: httpx.TimeoutException) -> str:
        detail = str(exc).strip()
        if detail:
            return f"Provider request timed out: {detail}"
        return f"Provider request timed out while waiting for the upstream model response ({type(exc).__name__})."

    @staticmethod
    def _describe_transport_error(exc: httpx.TransportError) -> str:
        detail = str(exc).strip()
        if detail:
            return f"Provider transport error ({type(exc).__name__}): {detail}"
        return f"Provider transport error while contacting the upstream model ({type(exc).__name__})."
