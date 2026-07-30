from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "setup-debug-breakpoints.py"


def _load_tool() -> ModuleType:
    spec = importlib.util.spec_from_file_location("chat_debug_breakpoints_tool", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_repository_breakpoint_profiles_reference_unique_known_ids() -> None:
    tool = _load_tool()
    config = tool.load_config()

    assert len(tool._profile_breakpoints(config, "core")) == 11
    assert len(tool._profile_breakpoints(config, "sc01")) == 18
    assert len(tool._profile_breakpoints(config, "sc02")) == 20
    for profile in ("model", "pi", "recovery", "hot"):
        selected = tool._profile_breakpoints(config, profile)
        assert selected
        assert len({item["id"] for item in selected}) == len(selected)

    with pytest.raises(ValueError, match="未知断点组合"):
        tool._profile_breakpoints(config, "missing")


def test_profile_switch_removes_previous_injections_before_selective_inject(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    tool = _load_tool()
    source = tmp_path / "sample.py"
    source.write_text(
        "def first():\n"
        "    # DEBUG-BREAKPOINT-NOTE: BP-A\n"
        "    breakpoint()  # DEBUG-BREAKPOINT: BP-A\n"
        "    return 1\n\n"
        "def second():\n"
        "    # DEBUG-BREAKPOINT-NOTE: BP-B\n"
        "    breakpoint()  # DEBUG-BREAKPOINT: BP-B\n"
        "    return 2\n",
        encoding="utf-8",
    )
    config = {
        "profiles": {"first_only": ["BP-A"]},
        "breakpoints": [
            {
                "id": "BP-A",
                "symbol": "first",
                "file": "sample.py",
                "language": "python",
                "class": None,
                "line_hint": 1,
                "trigger_timing": "进入first",
                "frequency": "一次",
            },
            {
                "id": "BP-B",
                "symbol": "second",
                "file": "sample.py",
                "language": "python",
                "class": None,
                "line_hint": 6,
                "trigger_timing": "进入second",
                "frequency": "一次",
            },
        ],
    }
    monkeypatch.setattr(tool, "ROOT", tmp_path)

    assert tool.cmd_inject(config, profile="first_only") == 0

    updated = source.read_text(encoding="utf-8")
    assert "# DEBUG-BREAKPOINT: BP-A" in updated
    assert "# DEBUG-BREAKPOINT: BP-B" not in updated
    assert "def second():\n    return 2" in updated
