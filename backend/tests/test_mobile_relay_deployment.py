"""Static safety contracts for the HTTP-stage mobile cloud relay."""

from __future__ import annotations

from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]


def _read(relative: str) -> str:
    return (PROJECT_ROOT / relative).read_text(encoding="utf-8")


def test_backend_launch_agent_uses_project_venv_and_loopback_only() -> None:
    template = _read("deploy/macos/com.later.chat.backend.plist.in")

    assert "__PROJECT_ROOT__/.venv/bin/python" in template
    assert "backend.app.asgi:app" in template
    assert "<string>127.0.0.1</string>" in template
    assert "<string>0.0.0.0</string>" not in template
    assert "<key>KeepAlive</key>" in template


def test_reverse_relay_never_opens_the_cloud_port_publicly() -> None:
    template = _read("deploy/macos/com.later.chat.cloud-relay.plist.in")

    assert "127.0.0.1:__REMOTE_PORT__:127.0.0.1:__LOCAL_PORT__" in template
    assert "0.0.0.0:__REMOTE_PORT__" not in template
    assert "ExitOnForwardFailure=yes" in template
    assert "ServerAliveInterval=30" in template
    assert "StrictHostKeyChecking=yes" in template


def test_nginx_protects_static_and_api_paths_and_preserves_streaming() -> None:
    snippet = _read("deploy/nginx/chat-locations.conf")

    assert snippet.count('auth_basic "Chat private workspace";') == 3
    assert snippet.count("auth_basic_user_file /etc/nginx/chat.htpasswd;") == 3
    assert "location ^~ /chat/" in snippet
    assert "location ^~ /chat-api/" in snippet
    assert "location ^~ /chat-pwa-http-test/" in snippet
    assert "return 308 /chat/;" in snippet
    assert "proxy_pass http://127.0.0.1:4620/;" in snippet
    assert "proxy_buffering off;" in snippet
    assert "proxy_read_timeout 1260s;" in snippet
    assert 'proxy_set_header Authorization "";' in snippet


def test_operational_scripts_do_not_use_system_python_or_expose_secrets() -> None:
    installer = _read("scripts/install-mobile-relay.sh")
    deployer = _read("scripts/deploy-mobile-web.sh")
    remote_installer = _read("deploy/server/install-chat-relay.sh")
    verifier = _read("scripts/verify-mobile-relay.sh")

    assert "$project_root/.venv/bin/python" in installer
    assert "$project_root/.venv/bin/python" in deployer
    assert "/usr/bin/python" not in installer
    assert "/usr/bin/python" not in deployer
    assert "openssl passwd -apr1 -stdin" in deployer
    assert "chat-http-access-password" in deployer
    assert '--user "later:$(<"$password_file")"' in verifier
    assert 'echo "$password' not in deployer
    assert "install -o root -g www-data -m 0640" in remote_installer
    assert 'find "$release_dir" -type d -exec chmod 0755 {} +' in remote_installer
    assert 'find "$release_dir/web" -type f -exec chmod 0644 {} +' in remote_installer
