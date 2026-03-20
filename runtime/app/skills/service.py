from __future__ import annotations

import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any


_ENTRY_PATTERN = re.compile(r"^- ([^:]+): (.*?) \(file: (.+?)\)\s*$")
_FRONTMATTER_PATTERN = re.compile(r"^---\n(.*?)\n---\n", re.DOTALL)
_FRONTMATTER_FIELD_PATTERN = re.compile(r"^(name|description):\s*(.+)$", re.MULTILINE)
_TOKEN_PATTERN = re.compile(r"[a-z0-9_+-]+|[\u4e00-\u9fff]{1,8}", re.IGNORECASE)
_ENGLISH_STOPWORDS = {
    "a",
    "an",
    "and",
    "as",
    "after",
    "before",
    "for",
    "from",
    "in",
    "into",
    "is",
    "it",
    "local",
    "of",
    "on",
    "or",
    "the",
    "to",
    "use",
    "when",
    "with",
}


@dataclass(frozen=True, slots=True)
class SkillReference:
    name: str
    description: str
    path: Path
    source: str


class SkillService:
    def __init__(self, codex_home: Path, excerpt_bytes: int = 12 * 1024, active_skill_limit: int = 3) -> None:
        self._codex_home = codex_home
        self._excerpt_bytes = excerpt_bytes
        self._active_skill_limit = active_skill_limit

    def build_context(self, *, cwd: str | Path, latest_user_message: str | None) -> dict[str, Any]:
        resolved_cwd = Path(cwd).expanduser().resolve()
        agents_path = self._find_agents_file(resolved_cwd)
        available = self._available_skills(agents_path)
        active = self._select_skills(available, latest_user_message or "")
        return {
            "agents_path": str(agents_path) if agents_path else None,
            "registry_source": "agents" if agents_path else "codex_home",
            "available": [self._serialize_skill(reference) for reference in available],
            "active": [self._serialize_skill(reference, include_excerpt=True) for reference in active],
        }

    def _available_skills(self, agents_path: Path | None) -> list[SkillReference]:
        if agents_path:
            skills = self._parse_agents_registry(agents_path)
            if skills:
                return skills
        return self._discover_installed_skills()

    def _find_agents_file(self, cwd: Path) -> Path | None:
        for candidate in (cwd, *cwd.parents):
            path = candidate / "AGENTS.md"
            if path.exists():
                return path
        return None

    def _parse_agents_registry(self, agents_path: Path) -> list[SkillReference]:
        text = self._read_text(agents_path)
        skills: list[SkillReference] = []
        for line in text.splitlines():
            match = _ENTRY_PATTERN.match(line.strip())
            if not match:
                continue
            name, description, file_path = match.groups()
            path = Path(file_path)
            if not path.is_absolute():
                path = (agents_path.parent / path).resolve()
            if not path.exists():
                continue
            skills.append(
                SkillReference(
                    name=name.strip(),
                    description=description.strip(),
                    path=path,
                    source="agents",
                )
            )
        return skills

    def _discover_installed_skills(self) -> list[SkillReference]:
        skills_dir = self._codex_home / "skills"
        if not skills_dir.exists():
            return []
        discovered: list[SkillReference] = []
        seen: set[str] = set()
        for path in sorted(skills_dir.rglob("SKILL.md")):
            metadata = self._parse_skill_frontmatter(path)
            name = metadata.get("name") or path.parent.name
            key = name.strip().lower()
            if key in seen:
                continue
            seen.add(key)
            discovered.append(
                SkillReference(
                    name=name.strip(),
                    description=(metadata.get("description") or "").strip(),
                    path=path.resolve(),
                    source="codex_home",
                )
            )
        return discovered

    def _select_skills(self, available: list[SkillReference], latest_user_message: str) -> list[SkillReference]:
        message = latest_user_message.strip()
        if not message:
            return []
        explicit: list[SkillReference] = []
        for reference in available:
            if self._is_explicit_match(reference, message):
                explicit.append(reference)
        if explicit:
            return explicit[: self._active_skill_limit]

        scored: list[tuple[int, SkillReference]] = []
        for reference in available:
            score = self._score_skill(reference, message)
            if score > 0:
                scored.append((score, reference))
        scored.sort(key=lambda item: (-item[0], item[1].name))
        selected = [reference for score, reference in scored if score >= 2]
        return selected[: self._active_skill_limit]

    def _is_explicit_match(self, reference: SkillReference, message: str) -> bool:
        lowered_message = message.lower()
        normalized_name = self._normalize(reference.name)
        if f"${normalized_name}" in lowered_message:
            return True
        if normalized_name in self._normalize(message):
            return True
        return any(alias and alias in lowered_message for alias in self._aliases(reference))

    def _score_skill(self, reference: SkillReference, message: str) -> int:
        lowered_message = message.lower()
        score = 0
        for alias in self._aliases(reference):
            if alias and alias in lowered_message:
                score += 3
        message_tokens = self._tokenize(message)
        skill_tokens = self._tokenize(" ".join([reference.name, reference.description]))
        overlap = len(message_tokens & skill_tokens)
        score += overlap
        return score

    def _aliases(self, reference: SkillReference) -> set[str]:
        normalized_name = self._normalize(reference.name)
        aliases = {normalized_name}
        aliases.update(part for part in normalized_name.split("-") if part)
        lowered_name = normalized_name.lower()
        if "qingflow" in lowered_name:
            aliases.update({"qingflow", "轻流"})
        if "builder" in lowered_name:
            aliases.update({"builder", "表单", "应用", "视图", "流程", "工作流"})
        if "user" in lowered_name:
            aliases.update({"记录", "审批", "评论", "任务"})
        if lowered_name == "pdf":
            aliases.add("pdf")
        if lowered_name == "linear":
            aliases.update({"linear", "issue", "ticket", "工单"})
        return {alias.lower() for alias in aliases if alias}

    def _serialize_skill(self, reference: SkillReference, *, include_excerpt: bool = False) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "name": reference.name,
            "description": reference.description,
            "path": str(reference.path),
            "source": reference.source,
        }
        if include_excerpt:
            payload["instructions_excerpt"] = self._skill_excerpt(reference.path)
        return payload

    @staticmethod
    def _normalize(text: str) -> str:
        return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")

    @staticmethod
    def _tokenize(text: str) -> set[str]:
        tokens = set()
        for match in _TOKEN_PATTERN.findall(text.lower()):
            token = match.strip()
            if not token or token in _ENGLISH_STOPWORDS:
                continue
            tokens.add(token)
        return tokens

    @staticmethod
    @lru_cache(maxsize=256)
    def _read_text(path: Path) -> str:
        return path.read_text(encoding="utf-8")

    def _skill_excerpt(self, path: Path) -> str:
        content = self._read_text(path)
        if len(content) <= self._excerpt_bytes:
            return content
        return content[: self._excerpt_bytes].rstrip() + "\n..."

    def _parse_skill_frontmatter(self, path: Path) -> dict[str, str]:
        text = self._read_text(path)
        match = _FRONTMATTER_PATTERN.match(text)
        if not match:
            return {}
        frontmatter = match.group(1)
        return {key: value.strip() for key, value in _FRONTMATTER_FIELD_PATTERN.findall(frontmatter)}
