from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass, field
from typing import Awaitable, Callable

import pexpect

from app.config import AppConfig

OutputCallback = Callable[[str], Awaitable[None]]


class TerminalBusyError(RuntimeError):
    pass


@dataclass
class TerminalSession:
    shell: str
    cwd: str
    env: dict[str, str]
    child: pexpect.spawn | None = None
    command_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    active_command: str | None = None


class TerminalCapability:
    def __init__(self, config: AppConfig) -> None:
        self._config = config

    async def run_command(
        self,
        session: TerminalSession,
        command: str,
        on_output: OutputCallback,
        cwd: str | None = None,
        env_overrides: dict[str, str] | None = None,
        timeout_sec: int | None = None,
    ) -> dict[str, object]:
        if session.command_lock.locked():
            raise TerminalBusyError("Only one foreground terminal command can run per session.")
        async with session.command_lock:
            session.active_command = command
            working_directory = cwd or session.cwd
            child = await asyncio.to_thread(
                self._spawn_command,
                session,
                command,
                working_directory,
                env_overrides,
            )
            session.child = child
            try:
                exit_code = await self._stream_process(child, on_output, timeout_sec)
                session.cwd = working_directory
                return {"command": command, "exit_code": exit_code, "cwd": session.cwd}
            finally:
                session.active_command = None
                session.child = None

    async def kill_process(self, session: TerminalSession) -> dict[str, object]:
        if session.child is None or not session.child.isalive():
            return {"killed": False, "reason": "terminal_not_running"}
        session.child.sendcontrol("c")
        session.active_command = None
        return {"killed": True}

    async def close(self, session: TerminalSession) -> None:
        if session.child is not None and session.child.isalive():
            await asyncio.to_thread(session.child.terminate, True)

    def _spawn_command(
        self,
        session: TerminalSession,
        command: str,
        cwd: str,
        env_overrides: dict[str, str] | None,
    ) -> pexpect.spawn:
        env = session.env.copy()
        if env_overrides:
            env.update({key: str(value) for key, value in env_overrides.items()})
        shell_args = ["-lc", command]
        return pexpect.spawn(
            session.shell,
            shell_args,
            encoding="utf-8",
            echo=False,
            env=env,
            cwd=cwd,
            timeout=0.1,
        )

    async def _stream_process(
        self,
        child: pexpect.spawn,
        on_output: OutputCallback,
        timeout_sec: int | None,
    ) -> int:
        deadline = asyncio.get_running_loop().time() + timeout_sec if timeout_sec else None
        while True:
            if deadline is not None and asyncio.get_running_loop().time() > deadline:
                child.sendcontrol("c")
                raise TimeoutError("Terminal command timed out.")
            try:
                chunk = await asyncio.to_thread(child.read_nonblocking, 4096, 0.1)
            except pexpect.TIMEOUT:
                continue
            except pexpect.EOF:
                remaining = child.before.replace("\r\n", "\n") if child.before else ""
                if remaining:
                    await on_output(remaining)
                child.close()
                return int(child.exitstatus or 0)
            if chunk:
                await on_output(chunk.replace("\r\n", "\n"))
