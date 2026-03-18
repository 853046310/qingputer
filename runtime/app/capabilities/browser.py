from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from playwright.async_api import BrowserContext, Error, Page, async_playwright

from app.config import AppConfig


@dataclass
class BrowserSession:
    context: BrowserContext | None = None
    page: Page | None = None


class BrowserCapability:
    def __init__(self, config: AppConfig) -> None:
        self._config = config
        self._playwright = None
        self._shared_context: BrowserContext | None = None
        self._pages: set[Page] = set()

    async def _ensure_context(self, session: BrowserSession) -> None:
        if session.page is not None and not session.page.is_closed():
            return
        if self._shared_context is None:
            if self._playwright is None:
                self._playwright = await async_playwright().start()
            profile_dir = Path(self._config.browser_profile_directory)
            self._shared_context = await self._playwright.chromium.launch_persistent_context(
                str(profile_dir),
                headless=True,
            )
        session.context = self._shared_context
        session.page = await self._shared_context.new_page()
        self._pages.add(session.page)

    async def open_page(self, session: BrowserSession, url: str) -> dict[str, object]:
        await self._ensure_context(session)
        assert session.page is not None
        await session.page.goto(url, wait_until="domcontentloaded")
        return {"url": session.page.url, "title": await session.page.title()}

    async def click(self, session: BrowserSession, selector: str) -> dict[str, object]:
        await self._ensure_context(session)
        assert session.page is not None
        await session.page.locator(selector).first.click()
        return {"selector": selector, "url": session.page.url, "title": await session.page.title()}

    async def type_text(self, session: BrowserSession, selector: str, text: str, clear: bool = True) -> dict[str, object]:
        await self._ensure_context(session)
        assert session.page is not None
        locator = session.page.locator(selector).first
        if clear:
            await locator.fill("")
        await locator.type(text)
        return {"selector": selector, "typed_length": len(text), "url": session.page.url}

    async def extract_text(self, session: BrowserSession, selector: str | None = None) -> dict[str, object]:
        await self._ensure_context(session)
        assert session.page is not None
        if selector:
            text = await session.page.locator(selector).first.inner_text()
        else:
            try:
                text = await session.page.locator("body").inner_text(timeout=2000)
            except Error:
                text = await session.page.content()
        text = text[: self._config.page_excerpt_bytes]
        return {"selector": selector, "url": session.page.url, "title": await session.page.title(), "text": text}

    async def close(self, session: BrowserSession) -> None:
        if session.page is not None and not session.page.is_closed():
            await session.page.close()
        if session.page is not None:
            self._pages.discard(session.page)
        session.page = None
        session.context = None
        if not self._pages and self._shared_context is not None:
            await self._shared_context.close()
            self._shared_context = None
            if self._playwright is not None:
                await self._playwright.stop()
                self._playwright = None

    async def shutdown(self) -> None:
        for page in list(self._pages):
            if not page.is_closed():
                await page.close()
        self._pages.clear()
        if self._shared_context is not None:
            await self._shared_context.close()
            self._shared_context = None
        if self._playwright is not None:
            await self._playwright.stop()
            self._playwright = None
