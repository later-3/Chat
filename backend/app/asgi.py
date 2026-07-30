"""后端进程的默认 ASGI 入口。

运行 ``uvicorn backend.app.asgi:app`` 时，Uvicorn 会先导入这个 Python
模块，再取得下面名为 ``app`` 的对象。真正的装配逻辑在 ``create_app``；
把入口与工厂分开后，测试可以传入隔离配置，而不会在导入 ``main`` 时读取
本机运行配置或启动 Worker。
"""

from .main import create_app

# 这里才为默认部署创建应用实例；单元测试通常直接调用 create_app(test_settings)。
app = create_app()
