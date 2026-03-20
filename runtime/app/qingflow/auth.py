from __future__ import annotations

import asyncio
import base64
import contextlib
from typing import Any

import httpx
import rsa

from app.config import AppConfig
from app.mcp import McpManager
from app.models import (
    McpConnectionStatus,
    QingflowAuthStatus,
    QingflowMcpSyncState,
    QingflowWorkspaceOption,
)
from app.models.schemas import (
    QINGFLOW_APP_BUILDER_MCP_SERVER_ID,
    QINGFLOW_APP_USER_MCP_SERVER_ID,
)
from app.storage import Database, SecretStore


class QingflowAuthManager:
    def __init__(
        self,
        config: AppConfig,
        database: Database,
        secret_store: SecretStore,
        mcp: McpManager,
    ) -> None:
        self.config = config
        self.database = database
        self.secret_store = secret_store
        self._mcp = mcp
        self._status = QingflowAuthStatus()
        self._mcp_sync_task: asyncio.Task[None] | None = None

    async def startup(self) -> None:
        settings = self.database.load_settings()
        token = self.secret_store.get_qingflow_api_token()
        if not token:
            self._status = self._status_from_settings(settings, token_set=False)
            return
        await self._hydrate_cached_user_info(force=settings.qingflow_user_avatar_url is None)
        settings = self.database.load_settings()

        # Fetch workspaces so the frontend can show the selector immediately
        workspaces: list[QingflowWorkspaceOption] = []
        try:
            workspaces = await self._fetch_workspaces(settings.qingflow_api_base_url, token)
        except Exception:
            pass  # token may be expired; frontend will show login again

        saved_ws_id = settings.qingflow_selected_ws_id
        has_saved_ws = saved_ws_id is not None and any(
            ws.ws_id == saved_ws_id for ws in workspaces
        )

        self._status = self._status_from_settings(
            settings,
            token_set=True,
            connected=False,
            last_error=None,
        ).model_copy(
            update={
                "workspaces": workspaces,
                "requires_workspace_selection": bool(workspaces) and not has_saved_ws,
                "requires_workspace_creation": not workspaces,
            }
        )

        # If the user previously selected a workspace that still exists, auto-reconnect
        if has_saved_ws:
            try:
                await self._change_workspace(settings.qingflow_api_base_url, token, saved_ws_id)  # type: ignore[arg-type]
                self._status = self._status.model_copy(
                    update={
                        "connected": True,
                        "requires_workspace_selection": False,
                        "mcp_sync": self._pending_mcp_sync_state(),
                    }
                )
                self._start_background_mcp_sync(settings.qingflow_api_base_url, token, saved_ws_id)  # type: ignore[arg-type]
            except Exception:
                # Workspace switch failed — let user pick again
                self._status = self._status.model_copy(
                    update={"requires_workspace_selection": bool(workspaces)}
                )

    async def shutdown(self) -> None:
        await self._cancel_mcp_sync_task()

    def get_status(self) -> QingflowAuthStatus:
        settings = self.database.load_settings()
        cached = self._status_from_settings(
            settings,
            token_set=self.secret_store.has_qingflow_api_token(),
            connected=self._status.connected,
            last_error=self._status.last_error,
        )
        return cached.model_copy(
            update={
                "workspaces": self._status.workspaces,
                "requires_workspace_selection": self._status.requires_workspace_selection,
                "requires_workspace_creation": self._status.requires_workspace_creation,
                "mcp_sync": self._status.mcp_sync,
                "user_name": self._status.user_name or cached.user_name,
                "user_email": self._status.user_email or cached.user_email,
                "user_avatar_url": self._status.user_avatar_url or cached.user_avatar_url,
                "selected_ws_id": self._status.selected_ws_id or cached.selected_ws_id,
                "selected_ws_name": self._status.selected_ws_name or cached.selected_ws_name,
            }
        )

    async def refresh_status(self) -> QingflowAuthStatus:
        await self._hydrate_cached_user_info(force=False)
        return self.get_status()

    async def login_with_password(self, email: str, password: str) -> QingflowAuthStatus:
        settings = self.database.load_settings()
        normalized_email = email.strip()
        normalized_password = password.strip()
        if not normalized_email:
            raise ValueError("邮箱不能为空。")
        if not normalized_password:
            raise ValueError("密码不能为空。")

        public_key = await self._fetch_public_key(settings.qingflow_api_base_url)
        encrypted_password = self._encrypt_password(public_key, normalized_password)
        candidates = await self._request_json_public(
            settings.qingflow_api_base_url,
            "POST",
            "/user/pwd",
            json_body={
                "email": normalized_email,
                "password": encrypted_password,
                "loginType": "email",
            },
        )
        if not isinstance(candidates, list) or not candidates:
            raise RuntimeError("邮箱或密码错误，或当前账号暂不支持原生登录。")

        login_candidate = self._select_login_candidate(candidates)
        if login_candidate is None:
            raise RuntimeError("当前账号存在多个可登录身份，请使用浏览器完成登录。")

        login_info = await self._request_json_public(
            settings.qingflow_api_base_url,
            "POST",
            "/user/login/uid",
            json_body=login_candidate,
        )
        if not isinstance(login_info, dict):
            raise RuntimeError("轻流登录接口返回了无效结果。")

        login_token = self._coerce_str(login_info, "loginToken")
        login_token_required = bool(login_token)
        security = login_info.get("userSecurityVO")
        being_uninitialized = False
        auth_method = 0
        if isinstance(security, dict):
            being_uninitialized = bool(security.get("beingUninitialized"))
            multiple_factor = security.get("multipleFactorInfo")
            if isinstance(multiple_factor, dict) and isinstance(multiple_factor.get("authMethod"), int):
                auth_method = multiple_factor["authMethod"]

        if login_token_required or being_uninitialized or auth_method != 0:
            raise RuntimeError("当前账号需要初始化密码或多因子验证，请使用浏览器完成登录。")

        token = self._coerce_str(login_info, "token")
        if token is None:
            raise RuntimeError("轻流登录成功，但未返回正式 token。")

        return await self.connect(token)

    async def connect(self, token: str, detected_ws_id: int | None = None) -> QingflowAuthStatus:
        settings = self.database.load_settings()
        normalized_token = token.strip()
        if not normalized_token:
            raise ValueError("Qingflow token cannot be empty.")

        user_info = await self._fetch_user_info(settings.qingflow_api_base_url, normalized_token)
        workspaces = await self._fetch_workspaces(settings.qingflow_api_base_url, normalized_token)

        self.secret_store.set_qingflow_api_token(normalized_token)

        settings.qingflow_user_name = user_info.get("user_name")
        settings.qingflow_user_email = user_info.get("user_email")
        settings.qingflow_user_avatar_url = user_info.get("user_avatar_url")

        await self._cancel_mcp_sync_task()
        settings.qingflow_selected_ws_id = None
        settings.qingflow_selected_ws_name = None
        self.database.save_settings(settings)
        self._status = QingflowAuthStatus(
            web_origin=settings.qingflow_web_origin,
            api_base_url=settings.qingflow_api_base_url,
            token_set=True,
            connected=False,
            user_name=settings.qingflow_user_name,
            user_email=settings.qingflow_user_email,
            user_avatar_url=settings.qingflow_user_avatar_url,
            selected_ws_id=None,
            selected_ws_name=None,
            workspaces=workspaces,
            requires_workspace_selection=bool(workspaces),
            requires_workspace_creation=not workspaces,
            mcp_sync=QingflowMcpSyncState(),
            last_error=None,
        )
        return self._status

    async def select_workspace(self, ws_id: int) -> QingflowAuthStatus:
        token = self.secret_store.get_qingflow_api_token()
        if not token:
            raise RuntimeError("Qingflow is not logged in.")

        settings = self.database.load_settings()
        workspaces = await self._fetch_workspaces(settings.qingflow_api_base_url, token)
        selected_ws = next((item for item in workspaces if item.ws_id == ws_id), None)
        if selected_ws is None:
            raise ValueError(f"Workspace {ws_id} is not available for the current Qingflow account.")

        verified = await self._change_workspace(settings.qingflow_api_base_url, token, ws_id)
        selected_ws = selected_ws.model_copy(
            update={
                "ws_name": self._coerce_str(verified, "workspaceName")
                or self._coerce_str(verified, "wsName")
                or selected_ws.ws_name
            }
        )

        settings.qingflow_selected_ws_id = selected_ws.ws_id
        settings.qingflow_selected_ws_name = selected_ws.ws_name
        self.database.save_settings(settings)

        await self._cancel_mcp_sync_task()
        self._status = self.get_status().model_copy(
            update={
                "connected": True,
                "selected_ws_id": selected_ws.ws_id,
                "selected_ws_name": selected_ws.ws_name,
                "workspaces": workspaces,
                "requires_workspace_selection": False,
                "requires_workspace_creation": False,
                "mcp_sync": self._pending_mcp_sync_state(),
                "last_error": None,
            }
        )
        self._start_background_mcp_sync(settings.qingflow_api_base_url, token, selected_ws.ws_id)
        return self._status

    async def sync_mcp(self) -> QingflowAuthStatus:
        token = self.secret_store.get_qingflow_api_token()
        settings = self.database.load_settings()
        if not token or settings.qingflow_selected_ws_id is None:
            self._status = self.get_status().model_copy(
                update={
                    "connected": False,
                    "mcp_sync": QingflowMcpSyncState(),
                    "last_error": "Qingflow token or workspace selection is missing.",
                }
            )
            return self._status

        await self._cancel_mcp_sync_task()
        mcp_sync = await self._sync_mcp(
            settings.qingflow_api_base_url,
            token,
            settings.qingflow_selected_ws_id,
        )
        self._status = self.get_status().model_copy(
            update={
                "connected": True,
                "mcp_sync": mcp_sync,
                "last_error": mcp_sync.last_error,
            }
        )
        return self._status

    async def logout(self) -> QingflowAuthStatus:
        settings = self.database.load_settings()
        token = self.secret_store.get_qingflow_api_token()
        last_error: str | None = None

        await self._cancel_mcp_sync_task()

        if token:
            with contextlib.suppress(Exception):
                await self._request_json(
                    settings.qingflow_api_base_url,
                    "GET",
                    "/user/quit",
                    token=token,
                    ws_id=settings.qingflow_selected_ws_id,
                )

        self.secret_store.delete_qingflow_api_token()
        settings.qingflow_user_name = None
        settings.qingflow_user_email = None
        settings.qingflow_user_avatar_url = None
        settings.qingflow_selected_ws_id = None
        settings.qingflow_selected_ws_name = None
        self.database.save_settings(settings)

        mcp_sync = QingflowMcpSyncState()
        for server_id, status_key in (
            (QINGFLOW_APP_BUILDER_MCP_SERVER_ID, "builder_status"),
            (QINGFLOW_APP_USER_MCP_SERVER_ID, "user_status"),
        ):
            if not await self._ensure_managed_server(server_id):
                continue
            try:
                await self._mcp.call_tool(server_id, "auth_logout", {"forget_persisted": True})
                with contextlib.suppress(Exception):
                    await self._mcp.refresh_server(server_id)
                setattr(mcp_sync, status_key, McpConnectionStatus.DISCONNECTED)
            except Exception as exc:
                setattr(mcp_sync, status_key, McpConnectionStatus.ERROR)
                if last_error is None:
                    last_error = str(exc)

        mcp_sync.last_error = last_error
        self._status = QingflowAuthStatus(
            web_origin=settings.qingflow_web_origin,
            api_base_url=settings.qingflow_api_base_url,
            token_set=False,
            connected=False,
            mcp_sync=mcp_sync,
            last_error=last_error,
        )
        return self._status

    def _status_from_settings(
        self,
        settings: Any,
        *,
        token_set: bool,
        connected: bool = False,
        last_error: str | None = None,
    ) -> QingflowAuthStatus:
        return QingflowAuthStatus(
            web_origin=settings.qingflow_web_origin,
            api_base_url=settings.qingflow_api_base_url,
            token_set=token_set,
            connected=connected,
            user_name=settings.qingflow_user_name,
            user_email=settings.qingflow_user_email,
            user_avatar_url=settings.qingflow_user_avatar_url,
            selected_ws_id=settings.qingflow_selected_ws_id,
            selected_ws_name=settings.qingflow_selected_ws_name,
            mcp_sync=QingflowMcpSyncState(),
            last_error=last_error,
        )

    async def _fetch_user_info(self, api_base_url: str, token: str) -> dict[str, Any]:
        payload = await self._request_json(api_base_url, "GET", "/user", token=token)
        last_ws = payload.get("lastWsInfo") if isinstance(payload, dict) else None
        return {
            "user_name": self._coerce_str(payload, "nickName") or self._coerce_str(payload, "userName"),
            "user_email": self._coerce_str(payload, "email"),
            "user_avatar_url": self._normalize_avatar_url(
                self._coerce_str(payload, "headImg") or self._coerce_str(payload, "avatar")
            ),
            "last_ws_id": last_ws.get("wsId") if isinstance(last_ws, dict) else None,
        }

    async def _fetch_public_key(self, api_base_url: str) -> str:
        payload = await self._request_json_public(api_base_url, "GET", "/user/pubkey")
        public_key = None
        if isinstance(payload, dict):
            public_key = self._coerce_str(payload, "pubkey") or self._coerce_str(payload, "publicKey")
        if public_key is None:
            raise RuntimeError("轻流未返回登录公钥。")
        return public_key

    async def _fetch_workspaces(self, api_base_url: str, token: str) -> list[QingflowWorkspaceOption]:
        payload = await self._request_json(api_base_url, "GET", "/ws", token=token)
        if isinstance(payload, dict):
            raw_items = payload.get("workspaces")
            if not isinstance(raw_items, list):
                raw_items = payload.get("list")
        elif isinstance(payload, list):
            raw_items = payload
        else:
            raw_items = []

        workspaces: list[QingflowWorkspaceOption] = []
        for item in raw_items if isinstance(raw_items, list) else []:
            if not isinstance(item, dict):
                continue
            ws_id = item.get("wsId")
            ws_name = item.get("wsName")
            if not isinstance(ws_id, int) or not isinstance(ws_name, str) or not ws_name.strip():
                continue
            workspaces.append(
                QingflowWorkspaceOption(
                    ws_id=ws_id,
                    ws_name=ws_name,
                    identity=self._coerce_str(item, "identity"),
                    auth=item.get("auth") if isinstance(item.get("auth"), int) else None,
                    being_disabled=(
                        item.get("beingDisabled")
                        if isinstance(item.get("beingDisabled"), bool)
                        else None
                    ),
                )
            )
        return workspaces

    async def _change_workspace(self, api_base_url: str, token: str, ws_id: int) -> dict[str, Any]:
        payload = await self._request_json(
            api_base_url,
            "POST",
            "/ws/change",
            token=token,
            json_body={"wsId": ws_id},
        )
        return payload if isinstance(payload, dict) else {}

    async def _sync_mcp(self, api_base_url: str, token: str, ws_id: int) -> QingflowMcpSyncState:
        mcp_sync = QingflowMcpSyncState()
        errors: list[str] = []
        for server_id, status_key in (
            (QINGFLOW_APP_BUILDER_MCP_SERVER_ID, "builder_status"),
            (QINGFLOW_APP_USER_MCP_SERVER_ID, "user_status"),
        ):
            if not await self._ensure_managed_server(server_id):
                setattr(mcp_sync, status_key, McpConnectionStatus.DISCONNECTED)
                continue
            try:
                await self._mcp.refresh_server(server_id)
                await self._mcp.call_tool(
                    server_id,
                    "auth_use_token",
                    {
                        "base_url": api_base_url,
                        "token": token,
                        "ws_id": str(ws_id),
                        "persist": True,
                    },
                )
                await self._mcp.call_tool(server_id, "workspace_select", {"ws_id": ws_id})
                await self._mcp.call_tool(server_id, "auth_whoami", {})
                setattr(mcp_sync, status_key, McpConnectionStatus.CONNECTED)
            except Exception as exc:
                setattr(mcp_sync, status_key, McpConnectionStatus.ERROR)
                errors.append(f"{server_id}: {exc}")
        mcp_sync.last_error = "; ".join(errors) if errors else None
        return mcp_sync

    async def _cancel_mcp_sync_task(self) -> None:
        task = self._mcp_sync_task
        self._mcp_sync_task = None
        if task and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    def _start_background_mcp_sync(self, api_base_url: str, token: str, ws_id: int) -> None:
        async def runner() -> None:
            try:
                mcp_sync = await self._sync_mcp(api_base_url, token, ws_id)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                mcp_sync = QingflowMcpSyncState(
                    builder_status=McpConnectionStatus.ERROR,
                    user_status=McpConnectionStatus.ERROR,
                    last_error=str(exc),
                )

            current = self.get_status()
            if not current.token_set or current.selected_ws_id != ws_id:
                return
            self._status = current.model_copy(
                update={
                    "connected": True,
                    "mcp_sync": mcp_sync,
                    "last_error": mcp_sync.last_error,
                }
            )

        self._mcp_sync_task = asyncio.create_task(runner())

    @staticmethod
    def _pending_mcp_sync_state() -> QingflowMcpSyncState:
        return QingflowMcpSyncState(
            builder_status=McpConnectionStatus.CONNECTING,
            user_status=McpConnectionStatus.CONNECTING,
            last_error=None,
        )

    async def _ensure_managed_server(self, server_id: str) -> bool:
        if self._mcp.has_server(server_id):
            return True
        settings = self.database.load_settings()
        await self._mcp.sync_servers(settings.mcp_servers)
        return self._mcp.has_server(server_id)

    async def _request_json(
        self,
        api_base_url: str,
        method: str,
        path: str,
        *,
        token: str,
        ws_id: int | None = None,
        json_body: dict[str, Any] | None = None,
    ) -> Any:
        headers = {"token": token}
        if ws_id is not None:
            headers["wsId"] = str(ws_id)
        timeout = httpx.Timeout(connect=10.0, read=30.0, write=10.0, pool=10.0)
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            response = await client.request(
                method,
                f"{api_base_url.rstrip('/')}{path}",
                headers=headers,
                json=json_body,
            )
        try:
            payload = response.json()
        except Exception as exc:
            raise RuntimeError(f"Qingflow API returned invalid JSON for {path}: {exc}") from exc

        status_code = None
        message = None
        if isinstance(payload, dict):
            status_code = payload.get("code")
            if status_code is None:
                status_code = payload.get("statusCode")
            if not isinstance(status_code, int) and isinstance(payload.get("data"), dict):
                nested_code = payload["data"].get("statusCode")
                if isinstance(nested_code, int):
                    status_code = nested_code
            message = payload.get("message")
            if message is None and isinstance(payload.get("data"), dict):
                message = payload["data"].get("message")

        if response.status_code >= 400:
            detail = message or response.text or f"HTTP {response.status_code}"
            raise RuntimeError(f"Qingflow API request failed for {path}: {detail}")
        if isinstance(status_code, int) and status_code not in {0, 200}:
            detail = message or f"statusCode={status_code}"
            raise RuntimeError(f"Qingflow API request failed for {path}: {detail}")

        if isinstance(payload, dict):
            if isinstance(payload.get("data"), (dict, list)):
                return payload["data"]
            if "result" in payload and isinstance(payload.get("result"), (dict, list)):
                return payload["result"]
        return payload

    async def _request_json_public(
        self,
        api_base_url: str,
        method: str,
        path: str,
        *,
        json_body: dict[str, Any] | None = None,
    ) -> Any:
        timeout = httpx.Timeout(connect=10.0, read=30.0, write=10.0, pool=10.0)
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            response = await client.request(
                method,
                f"{api_base_url.rstrip('/')}{path}",
                json=json_body,
            )
        try:
            payload = response.json()
        except Exception as exc:
            raise RuntimeError(f"Qingflow API returned invalid JSON for {path}: {exc}") from exc

        status_code = None
        message = None
        if isinstance(payload, dict):
            status_code = payload.get("code")
            if status_code is None:
                status_code = payload.get("statusCode")
            if not isinstance(status_code, int) and isinstance(payload.get("data"), dict):
                nested_code = payload["data"].get("statusCode")
                if isinstance(nested_code, int):
                    status_code = nested_code
            message = payload.get("message")
            if message is None and isinstance(payload.get("data"), dict):
                message = payload["data"].get("message")

        if response.status_code >= 400:
            detail = message or response.text or f"HTTP {response.status_code}"
            raise RuntimeError(f"Qingflow API request failed for {path}: {detail}")
        if isinstance(status_code, int) and status_code not in {0, 200}:
            detail = message or f"statusCode={status_code}"
            raise RuntimeError(f"Qingflow API request failed for {path}: {detail}")

        if isinstance(payload, dict):
            if isinstance(payload.get("data"), (dict, list)):
                return payload["data"]
            if "result" in payload and isinstance(payload.get("result"), (dict, list)):
                return payload["result"]
        return payload

    @staticmethod
    def _encrypt_password(public_key: str, password: str) -> str:
        try:
            key = rsa.PublicKey.load_pkcs1_openssl_der(base64.b64decode(public_key))
            encrypted = rsa.encrypt(password.encode("utf-8"), key)
        except Exception as exc:
            raise RuntimeError(f"轻流登录密码加密失败: {exc}") from exc
        return base64.b64encode(encrypted).decode("ascii")

    @staticmethod
    def _select_login_candidate(
        candidates: list[Any],
    ) -> dict[str, Any] | None:
        normalized_candidates: list[dict[str, Any]] = []
        for item in candidates:
            if not isinstance(item, dict):
                continue
            uid = item.get("uid")
            ticket = item.get("ticket")
            if not isinstance(uid, int) or not isinstance(ticket, str) or not ticket.strip():
                continue
            normalized_candidates.append(
                {
                    "uid": uid,
                    "ticket": ticket,
                    "loginType": "EMAIL",
                    "wsId": item.get("wsId") if isinstance(item.get("wsId"), int) else None,
                }
            )

        if not normalized_candidates:
            return None
        if len(normalized_candidates) == 1:
            return {key: value for key, value in normalized_candidates[0].items() if key != "wsId"}
        return None

    @staticmethod
    def _coerce_str(payload: Any, key: str) -> str | None:
        if not isinstance(payload, dict):
            return None
        value = payload.get(key)
        return value if isinstance(value, str) and value.strip() else None

    @staticmethod
    def _normalize_avatar_url(value: str | None) -> str | None:
        if not value:
            return None
        normalized = value.strip()
        if not normalized:
            return None
        if normalized.startswith("//"):
            return f"https:{normalized}"
        if normalized.startswith("http:"):
            return normalized.replace("http:", "https:", 1)
        return normalized

    async def _hydrate_cached_user_info(self, *, force: bool) -> None:
        token = self.secret_store.get_qingflow_api_token()
        if not token:
            return
        settings = self.database.load_settings()
        if (
            not force
            and settings.qingflow_user_name
            and settings.qingflow_user_email
            and settings.qingflow_user_avatar_url
        ):
            return
        try:
            user_info = await self._fetch_user_info(settings.qingflow_api_base_url, token)
        except Exception:
            return
        settings.qingflow_user_name = user_info.get("user_name")
        settings.qingflow_user_email = user_info.get("user_email")
        settings.qingflow_user_avatar_url = user_info.get("user_avatar_url")
        self.database.save_settings(settings)
