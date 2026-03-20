from pathlib import Path

from app.skills import SkillService


def write_skill(path: Path, *, name: str, description: str, body: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f"---\nname: {name}\ndescription: {description}\n---\n\n{body}\n",
        encoding="utf-8",
    )


def test_skill_service_uses_agents_registry_and_explicit_mentions(tmp_path: Path) -> None:
    codex_home = tmp_path / ".codex"
    pdf_skill = codex_home / "skills" / "pdf" / "SKILL.md"
    builder_skill = codex_home / "skills" / "qingflow-app-builder" / "SKILL.md"
    write_skill(pdf_skill, name="pdf", description="Review PDF files", body="# PDF\nUse Poppler.")
    write_skill(builder_skill, name="qingflow-app-builder", description="Build Qingflow apps", body="# Builder\nUse builder tools.")
    (tmp_path / "AGENTS.md").write_text(
        "\n".join(
            [
                "## Skills",
                "### Available skills",
                f"- pdf: Review PDF files. (file: {pdf_skill})",
                f"- qingflow-app-builder: Build Qingflow apps. (file: {builder_skill})",
            ]
        ),
        encoding="utf-8",
    )

    service = SkillService(codex_home)
    context = service.build_context(cwd=tmp_path, latest_user_message="请用 $pdf 看这个文件。")

    assert context["agents_path"] == str(tmp_path / "AGENTS.md")
    assert [item["name"] for item in context["available"]] == ["pdf", "qingflow-app-builder"]
    assert [item["name"] for item in context["active"]] == ["pdf"]
    assert "Use Poppler." in context["active"][0]["instructions_excerpt"]


def test_skill_service_falls_back_to_installed_skills_and_matches_qingflow_aliases(tmp_path: Path) -> None:
    codex_home = tmp_path / ".codex"
    builder_skill = codex_home / "skills" / "qingflow-app-builder" / "SKILL.md"
    write_skill(
        builder_skill,
        name="qingflow-app-builder",
        description="Build and modify Qingflow apps",
        body="# Builder\nModify forms, views, and workflows.",
    )

    service = SkillService(codex_home)
    context = service.build_context(cwd=tmp_path, latest_user_message="帮我修改轻流应用的表单布局和视图。")

    assert context["agents_path"] is None
    assert [item["name"] for item in context["active"]] == ["qingflow-app-builder"]
    assert "Modify forms" in context["active"][0]["instructions_excerpt"]
