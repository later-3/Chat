#!/usr/bin/env bash
set -Eeuo pipefail

# 让终端、Chat 和 pi-web 解析到同一份本地 pi 源码构建。
#
# 这里只共享代码与构建身份，不共享进程、配置、Session 或权限：
# - 终端 pi 仍使用个人 ~/.pi/agent；
# - pi-web 仍在自己的 Next.js 进程中创建 AgentSession；
# - Chat 仍使用隔离 PI_CODING_AGENT_DIR、Provider Gate 与 Tool Gate。

CHAT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PI_SOURCE_ROOT="${PI_SOURCE_ROOT:-/Users/xulater/Code/opc-os/pi}"
PI_WEB_ROOT="${PI_WEB_ROOT:-/Users/xulater/Code/pi-web}"
GLOBAL_PI_BIN="${GLOBAL_PI_BIN:-$HOME/.local/bin/pi}"
MODE="${1:-link}"

PACKAGE_LINKS=(
  "pi-coding-agent:coding-agent"
  "pi-agent-core:agent"
  "pi-ai:ai"
  "pi-tui:tui"
)

CHANGED_DESTINATIONS=()
CHANGED_BACKUPS=()
CHANGED_HAD_ORIGINAL=()

fail() {
  echo "配置本地pi单一分发失败：$*" >&2
  return 1
}

realpath_portable() {
  node -e 'const path = require("node:path"); console.log(path.resolve(process.argv[1]))' "$1"
}

resolved_link_target() {
  node -e 'const fs = require("node:fs"); console.log(fs.realpathSync(process.argv[1]))' "$1"
}

assert_layout() {
  test -d "$PI_SOURCE_ROOT/.git" || fail "pi源码仓库不存在：$PI_SOURCE_ROOT"
  test -f "$PI_WEB_ROOT/package.json" || fail "pi-web仓库不存在：$PI_WEB_ROOT"
  test -d "$PI_WEB_ROOT/node_modules/@earendil-works" || fail "pi-web尚未安装npm依赖"
  test -f "$CHAT_ROOT/backend/config.json" || fail "Chat私有配置不存在"

  local link package_name source_dir source_package expected_version source_version
  for link in "${PACKAGE_LINKS[@]}"; do
    package_name="${link%%:*}"
    source_dir="${link##*:}"
    source_package="$PI_SOURCE_ROOT/packages/$source_dir/package.json"
    test -f "$source_package" || fail "pi源码包不存在：$source_package"
    expected_version="$(node -e 'const p=require(process.argv[1]); process.stdout.write(p.dependencies[process.argv[2]] || "")' "$PI_WEB_ROOT/package.json" "@earendil-works/$package_name")"
    source_version="$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$source_package")"
    test -n "$expected_version" || fail "pi-web没有声明@earendil-works/$package_name"
    test "$expected_version" = "$source_version" || fail "@earendil-works/$package_name版本不一致：pi-web=$expected_version，源码=$source_version"
  done
}

validate_chat_config() {
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const expectedCli = path.resolve(process.argv[2]);
    const expectedRoot = path.resolve(process.argv[3]);
    const configuredCli = path.resolve(config.pi_agent?.cli_path || "");
    const configuredRoot = path.resolve(config.pi_agent?.source_root || "");
    if (configuredCli !== expectedCli || configuredRoot !== expectedRoot) {
      process.stderr.write("Chat私有配置尚未指向同一pi源码树；未输出配置内容。\n");
      process.exit(1);
    }
  ' "$CHAT_ROOT/backend/config.json" "$PI_SOURCE_ROOT/packages/coding-agent/dist/cli.js" "$PI_SOURCE_ROOT"
}

link_destination() {
  local destination="$1"
  local source="$2"
  local backup="$3"

  if [[ -L "$destination" ]] && [[ "$(resolved_link_target "$destination")" = "$(realpath_portable "$source")" ]]; then
    return
  fi
  if [[ -e "$backup" || -L "$backup" ]]; then
    fail "备份已存在且当前链接不是目标源码，请先运行restore或人工核对：$backup"
  fi
  local had_original="false"
  if [[ -e "$destination" || -L "$destination" ]]; then
    mv "$destination" "$backup"
    had_original="true"
  fi
  ln -s "$source" "$destination"
  CHANGED_DESTINATIONS+=("$destination")
  CHANGED_BACKUPS+=("$backup")
  CHANGED_HAD_ORIGINAL+=("$had_original")
}

assert_destination_linkable() {
  local destination="$1"
  local source="$2"
  local backup="$3"

  if [[ -L "$destination" ]] && [[ "$(resolved_link_target "$destination")" = "$(realpath_portable "$source")" ]]; then
    return
  fi
  if [[ -e "$backup" || -L "$backup" ]]; then
    fail "备份已存在且当前链接不是目标源码，请先运行restore或人工核对：$backup"
  fi
}

rollback_changed_links() {
  local index destination backup had_original
  for ((index=${#CHANGED_DESTINATIONS[@]} - 1; index >= 0; index--)); do
    destination="${CHANGED_DESTINATIONS[$index]}"
    backup="${CHANGED_BACKUPS[$index]}"
    had_original="${CHANGED_HAD_ORIGINAL[$index]}"
    if [[ -L "$destination" ]]; then
      unlink "$destination"
    fi
    if [[ "$had_original" = "true" && ( -e "$backup" || -L "$backup" ) ]]; then
      mv "$backup" "$destination"
    fi
  done
}

restore_destination() {
  local destination="$1"
  local backup="$2"

  if [[ ! -e "$backup" && ! -L "$backup" ]]; then
    return
  fi
  if [[ -L "$destination" ]]; then
    unlink "$destination"
  elif [[ -e "$destination" ]]; then
    fail "恢复目标已被非链接文件占用，未覆盖：$destination"
  fi
  mv "$backup" "$destination"
}

link_stack() {
  trap 'status=$?; trap - ERR; rollback_changed_links; exit "$status"' ERR
  local scoped_dir="$PI_WEB_ROOT/node_modules/@earendil-works"
  local link package_name source_dir destination source backup
  for link in "${PACKAGE_LINKS[@]}"; do
    package_name="${link%%:*}"
    source_dir="${link##*:}"
    assert_destination_linkable \
      "$scoped_dir/$package_name" \
      "$PI_SOURCE_ROOT/packages/$source_dir" \
      "$scoped_dir/.upstream-$package_name"
  done
  assert_destination_linkable \
    "$GLOBAL_PI_BIN" \
    "$PI_SOURCE_ROOT/packages/coding-agent/dist/cli.js" \
    "$GLOBAL_PI_BIN.upstream"

  "$CHAT_ROOT/scripts/build-local-pi.sh"

  for link in "${PACKAGE_LINKS[@]}"; do
    package_name="${link%%:*}"
    source_dir="${link##*:}"
    destination="$scoped_dir/$package_name"
    source="$PI_SOURCE_ROOT/packages/$source_dir"
    backup="$scoped_dir/.upstream-$package_name"
    link_destination "$destination" "$source" "$backup"
  done

  mkdir -p "$(dirname "$GLOBAL_PI_BIN")"
  link_destination "$GLOBAL_PI_BIN" "$PI_SOURCE_ROOT/packages/coding-agent/dist/cli.js" "$GLOBAL_PI_BIN.upstream"

  validate_chat_config

  test "$(resolved_link_target "$GLOBAL_PI_BIN")" = "$(realpath_portable "$PI_SOURCE_ROOT/packages/coding-agent/dist/cli.js")" \
    || fail "全局pi没有解析到源码构建"
  for link in "${PACKAGE_LINKS[@]}"; do
    package_name="${link%%:*}"
    source_dir="${link##*:}"
    test "$(resolved_link_target "$scoped_dir/$package_name")" = "$(realpath_portable "$PI_SOURCE_ROOT/packages/$source_dir")" \
      || fail "pi-web的$package_name没有解析到源码包"
  done

  "$GLOBAL_PI_BIN" --version
  (
    cd "$PI_WEB_ROOT"
    node --input-type=module -e '
      await Promise.all([
        import("@earendil-works/pi-coding-agent"),
        import("@earendil-works/pi-agent-core"),
        import("@earendil-works/pi-ai"),
        import("@earendil-works/pi-tui"),
      ]);
      console.log("pi-web本地pi SDK解析通过");
    '
  )

  echo "本地pi单一分发已生效：终端、Chat与pi-web共用${PI_SOURCE_ROOT}的构建。"
  echo "运行进程、配置、Session和权限仍按3个消费者分别隔离。"
  trap - ERR
}

restore_stack() {
  local scoped_dir="$PI_WEB_ROOT/node_modules/@earendil-works"
  local link package_name destination backup
  for link in "${PACKAGE_LINKS[@]}"; do
    package_name="${link%%:*}"
    destination="$scoped_dir/$package_name"
    backup="$scoped_dir/.upstream-$package_name"
    restore_destination "$destination" "$backup"
  done
  restore_destination "$GLOBAL_PI_BIN" "$GLOBAL_PI_BIN.upstream"
  echo "已恢复全局pi和pi-web原npm安装；Chat仍按私有配置使用源码构建。"
}

case "$MODE" in
  link)
    assert_layout
    link_stack
    ;;
  restore)
    assert_layout
    restore_stack
    ;;
  *)
    fail "仅支持link或restore"
    ;;
esac
