"""One-time, secret-safe migration from backend/.env to backend/config.json."""

from __future__ import annotations

import ast
import argparse
import json
import os
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SOURCE = PROJECT_ROOT / "backend" / ".env"
TARGET = PROJECT_ROOT / "backend" / "config.json"


def _dotenv_values(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line.removeprefix("export ").strip()
        if "=" not in line:
            continue
        key, raw_value = line.split("=", 1)
        value = raw_value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            try:
                value = str(ast.literal_eval(value))
            except (SyntaxError, ValueError):
                value = value[1:-1]
        values[key.strip()] = value
    return values


def _required(values: dict[str, str], key: str) -> str:
    value = values.get(key, "").strip()
    if not value:
        raise ValueError(f"backend/.env缺少必填配置: {key}")
    return value


def _integer(values: dict[str, str], key: str, default: int) -> int:
    raw = values.get(key, "").strip()
    return int(raw) if raw else default


def _boolean(values: dict[str, str], key: str, default: bool) -> bool:
    raw = values.get(key, "").strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on"}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--upgrade-provider-protocols",
        action="store_true",
        help="Upgrade known provider protocol metadata without printing secret values.",
    )
    args = parser.parse_args()
    if args.upgrade_provider_protocols:
        if not TARGET.exists():
            raise SystemExit("backend/config.json不存在，无法升级")
        payload = json.loads(TARGET.read_text(encoding="utf-8"))
        providers = payload.get("providers")
        if not isinstance(providers, list):
            raise SystemExit("backend/config.json缺少providers数组")
        updated = False
        for provider in providers:
            if isinstance(provider, dict) and provider.get("id") == "dashscope":
                if provider.get("protocol") != "openai_chat_completions":
                    provider["protocol"] = "openai_chat_completions"
                    updated = True
        if updated:
            temporary = TARGET.with_suffix(".json.tmp")
            temporary.write_text(
                json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            os.chmod(temporary, 0o600)
            temporary.replace(TARGET)
        print("Provider协议元数据已检查；未输出任何配置值。")
        return

    if not SOURCE.exists():
        raise SystemExit("backend/.env不存在，无法迁移")
    if TARGET.exists():
        raise SystemExit("backend/config.json已存在；为避免覆盖密钥，迁移已停止")

    values = _dotenv_values(SOURCE)
    ark_model = _required(values, "ARK_MODEL")
    dashscope_model = _required(values, "DASHSCOPE_VISION_MODEL")
    origins = [
        item.strip()
        for item in values.get(
            "CHAT_FRONTEND_ORIGINS",
            "http://localhost:5073,http://127.0.0.1:5073",
        ).split(",")
        if item.strip()
    ]
    payload = {
        "version": 1,
        "server": {
            "host": values.get("CHAT_BACKEND_HOST", "127.0.0.1"),
            "port": _integer(values, "CHAT_BACKEND_PORT", 8030),
            "frontend_origins": origins,
        },
        "frontend": {
            "port": _integer(values, "CHAT_FRONTEND_PORT", 5073),
            "public_host": values.get("CHAT_FRONTEND_PUBLIC_HOST", "localhost"),
            "url": values.get("CHAT_FRONTEND_URL", "http://localhost:5073"),
        },
        "history": {
            "directory": values.get("CHAT_HISTORY_DIR", ".chat-history"),
        },
        "default_provider_id": "ark",
        "providers": [
            {
                "id": "ark",
                "label": "火山方舟",
                "enabled": True,
                "protocol": "openai_responses",
                "base_url": _required(values, "ARK_BASE_URL"),
                "api_key": _required(values, "ARK_API_KEY"),
                "default_model": ark_model,
                "models": [{"id": ark_model, "label": ark_model}],
                "capabilities": {
                    "image_input": _boolean(values, "ARK_SUPPORTS_IMAGE_INPUT", False),
                },
            },
            {
                "id": "dashscope",
                "label": "阿里云百炼",
                "enabled": True,
                "protocol": "openai_chat_completions",
                "base_url": _required(values, "DASHSCOPE_BASE_URL"),
                "api_key": _required(values, "DASHSCOPE_API_KEY"),
                "default_model": dashscope_model,
                "models": [{"id": dashscope_model, "label": dashscope_model}],
                "capabilities": {"image_input": True},
            },
        ],
    }

    temporary = TARGET.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(temporary, 0o600)
    temporary.replace(TARGET)
    print("已生成backend/config.json，包含Provider: ark, dashscope；未输出任何配置值。")


if __name__ == "__main__":
    main()
