from pathlib import Path

import httpx
import pytest

from app.agent.provider import OpenAIProvider, ProviderError
from app.config import AppConfig
from app.models import AgentActionKind, ModelProvider, SettingsPayload


class FakeDatabase:
    def load_settings(self) -> SettingsPayload:
        return SettingsPayload(openai_base_url="https://example.com/v1", openai_model="gpt-5.4")


class FakeSecretStore:
    def get_openai_api_key(self) -> str:
        return "sk-test"

    def get_openrouter_api_key(self) -> str:
        return "sk-or-test"


class StubProvider(OpenAIProvider):
    def __init__(self, responses: list[object], home: Path) -> None:
        super().__init__(AppConfig(home_directory=home), FakeDatabase(), FakeSecretStore())
        self._responses = responses
        self.calls = 0

    async def _request_action_text(self, **_: object) -> str:
        self.calls += 1
        next_response = self._responses.pop(0)
        if isinstance(next_response, Exception):
            raise next_response
        return str(next_response)


@pytest.mark.asyncio
async def test_provider_retries_after_empty_timeout_and_succeeds(tmp_path: Path) -> None:
    provider = StubProvider(
        responses=[
            httpx.ReadTimeout(""),
            '{"kind":"final_answer","args":{"content":"ok"}}',
        ],
        home=tmp_path,
    )

    action = await provider.next_action({"messages": []})

    assert provider.calls == 2
    assert action.kind == AgentActionKind.FINAL_ANSWER
    assert action.args["content"] == "ok"


@pytest.mark.asyncio
async def test_provider_timeout_error_is_never_blank(tmp_path: Path) -> None:
    provider = StubProvider(
        responses=[
            httpx.ReadTimeout(""),
            httpx.ReadTimeout(""),
            httpx.ReadTimeout(""),
        ],
        home=tmp_path,
    )

    with pytest.raises(ProviderError) as exc_info:
        await provider.next_action({"messages": []})

    message = str(exc_info.value)
    assert "timed out" in message
    assert "ReadTimeout" in message
    assert "after 3 attempts" in message


@pytest.mark.asyncio
async def test_provider_retries_after_invalid_action_json_and_succeeds(tmp_path: Path) -> None:
    provider = StubProvider(
        responses=[
            '{"kind":"final_answer","args":{"content":"oops""extra":"bad"}}',
            '{"kind":"final_answer","args":{"content":"ok"}}',
        ],
        home=tmp_path,
    )

    action = await provider.next_action({"messages": []})

    assert provider.calls == 2
    assert action.kind == AgentActionKind.FINAL_ANSWER
    assert action.args["content"] == "ok"


@pytest.mark.asyncio
async def test_provider_extracts_json_object_from_wrapped_content(tmp_path: Path) -> None:
    provider = StubProvider(
        responses=[
            '```json\n{"kind":"final_answer","args":{"content":"ok"}}\n```',
        ],
        home=tmp_path,
    )

    action = await provider.next_action({"messages": []})

    assert provider.calls == 1
    assert action.kind == AgentActionKind.FINAL_ANSWER
    assert action.args["content"] == "ok"


class MissingKeySecretStore:
    def get_openai_api_key(self) -> None:
        return None

    def get_openrouter_api_key(self) -> None:
        return None


@pytest.mark.asyncio
async def test_provider_configuration_error_mentions_invalid_or_missing_key(tmp_path: Path) -> None:
    provider = OpenAIProvider(AppConfig(home_directory=tmp_path), FakeDatabase(), MissingKeySecretStore())

    with pytest.raises(ProviderError) as exc_info:
        await provider.next_action({"messages": []})

    assert "missing or invalid" in str(exc_info.value)


class OpenRouterDatabase:
    def load_settings(self) -> SettingsPayload:
        return SettingsPayload(
            model_provider=ModelProvider.OPENROUTER,
            openrouter_base_url="https://openrouter.ai/api/v1",
            openrouter_model="openai/gpt-4.1",
        )


@pytest.mark.asyncio
async def test_provider_uses_openrouter_settings_and_headers(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    class FakeResponse:
        status_code = 200
        text = '{"choices":[{"message":{"content":"{\\"kind\\":\\"final_answer\\",\\"args\\":{\\"content\\":\\"ok\\"}}"}}]}'

        def json(self) -> dict[str, object]:
            return {
                "choices": [
                    {
                        "message": {
                            "content": '{"kind":"final_answer","args":{"content":"ok"}}',
                        }
                    }
                ]
            }

    class FakeAsyncClient:
        def __init__(self, *args: object, **kwargs: object) -> None:
            self.called_with: tuple[str, dict[str, object]] | None = None

        async def __aenter__(self) -> "FakeAsyncClient":
            return self

        async def __aexit__(self, exc_type, exc, tb) -> None:
            return None

        async def post(self, url: str, **kwargs: object) -> FakeResponse:
            self.called_with = (url, kwargs)
            return FakeResponse()

    fake_client = FakeAsyncClient()
    monkeypatch.setattr(httpx, "AsyncClient", lambda *args, **kwargs: fake_client)
    provider = OpenAIProvider(AppConfig(home_directory=tmp_path), OpenRouterDatabase(), FakeSecretStore())

    action = await provider.next_action({"messages": []})

    assert action.kind == AgentActionKind.FINAL_ANSWER
    assert fake_client.called_with is not None
    url, kwargs = fake_client.called_with
    assert url == "https://openrouter.ai/api/v1/chat/completions"
    assert kwargs["headers"]["Authorization"] == "Bearer sk-or-test"
    assert kwargs["headers"]["HTTP-Referer"] == "https://qingputer.app"
    assert kwargs["headers"]["X-Title"] == "Qingputer"
    assert kwargs["json"]["model"] == "openai/gpt-4.1"


@pytest.mark.asyncio
async def test_request_action_text_uses_asyncclient_post_with_url(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    class FakeResponse:
        status_code = 200
        text = '{"choices":[{"message":{"content":"{\\"kind\\":\\"final_answer\\",\\"args\\":{\\"content\\":\\"ok\\"}}"}}]}'

        def json(self) -> dict[str, object]:
            return {
                "choices": [
                    {
                        "message": {
                            "content": '{"kind":"final_answer","args":{"content":"ok"}}',
                        }
                    }
                ]
            }

    class FakeAsyncClient:
        def __init__(self, *args: object, **kwargs: object) -> None:
            self.called_with: tuple[str, dict[str, object]] | None = None

        async def __aenter__(self) -> "FakeAsyncClient":
            return self

        async def __aexit__(self, exc_type, exc, tb) -> None:
            return None

        async def post(self, url: str, **kwargs: object) -> FakeResponse:
            self.called_with = (url, kwargs)
            return FakeResponse()

    fake_client = FakeAsyncClient()
    monkeypatch.setattr(httpx, "AsyncClient", lambda *args, **kwargs: fake_client)
    provider = OpenAIProvider(AppConfig(home_directory=tmp_path), FakeDatabase(), FakeSecretStore())

    text = await provider._request_action_text(
        base_url="https://example.com/v1",
        headers={"Authorization": "Bearer sk-test"},
        payload={"model": "gpt-5.4"},
    )

    assert text == '{"kind":"final_answer","args":{"content":"ok"}}'
    assert fake_client.called_with is not None
    url, kwargs = fake_client.called_with
    assert url == "https://example.com/v1/chat/completions"
    assert kwargs["headers"] == {"Authorization": "Bearer sk-test"}
    assert kwargs["json"] == {"model": "gpt-5.4"}
