#!/usr/bin/env python3
"""调试断点注入与清理工具。

读取 scripts/debug-breakpoints.json 配置，在源码函数体首行插入 breakpoint()（Python）
或 debugger;（TypeScript）语句，带唯一标记注释。提供 --clean 选项恢复源码。

使用：
    python scripts/setup-debug-breakpoints.py           # 注入断点
    python scripts/setup-debug-breakpoints.py --clean    # 清理全部断点
    python scripts/setup-debug-breakpoints.py --list     # 列出所有断点配置
    python scripts/setup-debug-breakpoints.py --status   # 查看注入状态

重要：
- Python 的 breakpoint() 在 debugpy 附加时由 VS Code 调试器拦截；非调试运行会进入 pdb。
  运行后端测试或直接 uvicorn 前，请执行 `export PYTHONBREAKPOINT=0` 禁用，或先 --clean。
- TypeScript 的 debugger; 只在浏览器 DevTools 打开时暂停，非调试运行自动忽略。
- 注入和清理都是幂等的，可重复运行。
"""

from __future__ import annotations

import argparse
import ast
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "scripts" / "debug-breakpoints.json"

PYTHON_MARKER = "# DEBUG-BREAKPOINT:"
TS_MARKER = "// DEBUG-BREAKPOINT:"


def load_config() -> dict:
    """加载断点配置。"""
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


def find_python_insert_line(source: str, symbol: str, class_name: str | None) -> int | None:
    """用 AST 找到 Python 函数体首行行号（1-based），跳过 docstring。

    支持顶层函数、类方法和嵌套函数。返回 None 表示未找到。
    """
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return None

    func_node: ast.FunctionDef | ast.AsyncFunctionDef | None = None

    if class_name:
        # 在指定类的作用域内搜索（包括类内嵌套函数）
        for node in ast.walk(tree):
            if isinstance(node, ast.ClassDef) and node.name == class_name:
                for child in ast.walk(node):
                    if (
                        isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef))
                        and child.name == symbol
                        and child is not node
                    ):
                        func_node = child
                        break
                break
    else:
        # 在整个树中搜索（包括顶层函数和嵌套函数）
        for node in ast.walk(tree):
            if (
                isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                and node.name == symbol
            ):
                func_node = node
                break

    if func_node is None:
        return None

    body = func_node.body
    # 跳过 docstring（首条语句是字符串字面量表达式）
    if (
        body
        and isinstance(body[0], ast.Expr)
        and isinstance(body[0].value, ast.Constant)
        and isinstance(body[0].value.value, str)
    ):
        body = body[1:]

    if not body:
        return None

    return body[0].lineno


def find_typescript_insert_line(
    lines: list[str], symbol: str, line_hint: int
) -> int | None:
    """用文本搜索找到 TS 函数体首行行号（1-based）。

    策略：在 line_hint ± 10 行内搜索包含 symbol 的行，
    然后向下找到第一个 { ，再找下一个非空行作为函数体首行。
    """
    search_start = max(0, line_hint - 11)
    search_end = min(len(lines), line_hint + 9)

    def_line: int | None = None
    for i in range(search_start, search_end):
        if symbol in lines[i]:
            def_line = i
            break

    if def_line is None:
        return None

    # 从 def_line 向下搜索第一个 {
    for i in range(def_line, min(len(lines), def_line + 20)):
        if "{" in lines[i]:
            # 找到 { 后，向下找第一个非空行
            for j in range(i + 1, min(len(lines), i + 5)):
                if lines[j].strip():
                    return j + 1  # 1-based
            break

    return None


def is_already_injected(lines: list[str], marker: str, bp_id: str) -> bool:
    """检查断点是否已注入（幂等性）。"""
    for line in lines:
        if marker in line and bp_id in line:
            return True
    return False


def inject_breakpoint(file_path: Path, bp_config: dict) -> tuple[bool, str]:
    """在文件中注入断点。返回 (成功, 消息)。"""
    if not file_path.exists():
        return False, f"文件不存在: {file_path}"

    raw = file_path.read_text(encoding="utf-8")
    lines = raw.splitlines(keepends=True)

    language = bp_config["language"]
    marker = PYTHON_MARKER if language == "python" else TS_MARKER
    bp_id = bp_config["id"]

    if is_already_injected(lines, marker, bp_id):
        return True, f"已注入(跳过): {bp_id} {bp_config['symbol']}"

    if language == "python":
        insert_line = find_python_insert_line(
            raw, bp_config["symbol"], bp_config.get("class")
        )
    else:
        insert_line = find_typescript_insert_line(
            lines, bp_config["symbol"], bp_config["line_hint"]
        )

    if insert_line is None:
        class_name = bp_config.get("class")
        symbol_display = f"{class_name}.{bp_config['symbol']}" if class_name else bp_config["symbol"]
        return False, f"未找到符号: {bp_id} {symbol_display}"

    # 获取函数体首行的缩进
    target_line = lines[insert_line - 1]  # 0-based index
    indent = len(target_line) - len(target_line.lstrip())
    indent_str = " " * indent

    if language == "python":
        bp_line = f"{indent_str}breakpoint()  {marker} {bp_id}\n"
    else:
        bp_line = f"{indent_str}debugger; {marker} {bp_id}\n"

    # 插入到函数体首行之前
    lines.insert(insert_line - 1, bp_line)
    file_path.write_text("".join(lines), encoding="utf-8")
    class_name = bp_config.get("class")
    symbol_display = f"{class_name}.{bp_config['symbol']}" if class_name else bp_config["symbol"]
    return True, f"已注入: {bp_id} {symbol_display} @ {file_path.name}:{insert_line}"


def clean_file(file_path: Path) -> int:
    """清理文件中的所有断点行。返回清理的断点数。"""
    if not file_path.exists():
        return 0

    lines = file_path.read_text(encoding="utf-8").splitlines(keepends=True)
    original_count = len(lines)
    cleaned_lines = [
        line for line in lines
        if PYTHON_MARKER not in line and TS_MARKER not in line
    ]
    removed = original_count - len(cleaned_lines)
    if removed > 0:
        file_path.write_text("".join(cleaned_lines), encoding="utf-8")
    return removed


def cmd_inject(config: dict) -> int:
    """注入所有断点。"""
    breakpoints = config["breakpoints"]
    success_count = 0
    skip_count = 0
    fail_count = 0

    print(f"开始注入 {len(breakpoints)} 个断点...\n")
    for bp in breakpoints:
        file_path = ROOT / bp["file"]
        ok, msg = inject_breakpoint(file_path, bp)
        if ok:
            if "跳过" in msg:
                skip_count += 1
            else:
                success_count += 1
            print(f"  ✓ {msg}")
        else:
            fail_count += 1
            print(f"  ✗ {msg}")

    print(f"\n注入完成: {success_count} 新增, {skip_count} 已存在, {fail_count} 失败")

    if success_count > 0:
        print("\n⚠ 重要提示:")
        print("  Python 的 breakpoint() 在非调试运行时会进入 pdb 阻塞程序。")
        print("  运行测试或直接 uvicorn 前，请执行:")
        print("    export PYTHONBREAKPOINT=0")
        print("  或先运行清理:")
        print("    python scripts/setup-debug-breakpoints.py --clean")
        print("  VS Code 调试模式（Chat Full Stack）下 debugpy 会自动拦截，无需额外设置。")

    return 0 if fail_count == 0 else 1


def cmd_clean(config: dict) -> int:
    """清理所有断点。"""
    breakpoints = config["breakpoints"]
    # 收集所有涉及的文件（去重）
    files = sorted({(ROOT / bp["file"]) for bp in breakpoints})
    total_removed = 0

    print(f"开始清理 {len(files)} 个文件中的断点...\n")
    for file_path in files:
        removed = clean_file(file_path)
        if removed > 0:
            print(f"  ✓ 清理 {removed} 个断点: {file_path.relative_to(ROOT)}")
            total_removed += removed

    print(f"\n清理完成: 共移除 {total_removed} 个断点")
    return 0


def cmd_list(config: dict) -> int:
    """列出所有断点配置及触发时机。"""
    breakpoints = config["breakpoints"]
    print(f"共 {len(breakpoints)} 个断点:\n")
    for bp in breakpoints:
        lang = "Python" if bp["language"] == "python" else "TypeScript"
        symbol = bp["symbol"]
        if bp.get("class"):
            symbol = f"{bp['class']}.{symbol}"
        trigger = bp.get("trigger_timing", "")
        frequency = bp.get("frequency", "")
        print(f"{bp['id']}  [{lang}]  {symbol}")
        print(f"  文件: {bp['file']}")
        if trigger:
            print(f"  触发: {trigger}")
        if frequency:
            print(f"  频率: {frequency}")
        print()
    return 0


def cmd_status(config: dict) -> int:
    """查看注入状态。"""
    breakpoints = config["breakpoints"]
    injected = 0
    not_injected = 0
    missing = 0

    print("断点注入状态:\n")
    for bp in breakpoints:
        file_path = ROOT / bp["file"]
        if not file_path.exists():
            print(f"  ✗ {bp['id']} 文件缺失: {bp['file']}")
            missing += 1
            continue

        lines = file_path.read_text(encoding="utf-8").splitlines(keepends=True)
        marker = PYTHON_MARKER if bp["language"] == "python" else TS_MARKER
        if is_already_injected(lines, marker, bp["id"]):
            print(f"  ● {bp['id']} 已注入: {bp['symbol']}")
            injected += 1
        else:
            print(f"  ○ {bp['id']} 未注入: {bp['symbol']}")
            not_injected += 1

    print(f"\n状态: {injected} 已注入, {not_injected} 未注入, {missing} 文件缺失")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="调试断点注入与清理工具",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--clean", action="store_true", help="清理所有断点，恢复源码")
    group.add_argument("--list", action="store_true", help="列出所有断点配置")
    group.add_argument("--status", action="store_true", help="查看注入状态")

    args = parser.parse_args()

    try:
        config = load_config()
    except FileNotFoundError:
        print(f"错误: 配置文件不存在: {CONFIG_PATH}", file=sys.stderr)
        return 1
    except json.JSONDecodeError as exc:
        print(f"错误: 配置文件解析失败: {exc}", file=sys.stderr)
        return 1

    if args.clean:
        return cmd_clean(config)
    if args.list:
        return cmd_list(config)
    if args.status:
        return cmd_status(config)
    return cmd_inject(config)


if __name__ == "__main__":
    sys.exit(main())
