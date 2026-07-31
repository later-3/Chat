"""FastAPI 应用工厂：把已经实现的后端模块组装成一个可运行的 Web 应用。

本文件只负责进程级接线：创建对象、安装中间件、挂载路由与 AG-UI 入口。
具体产品规则由 Application Service/Coordinator 持有，不能堆进这个入口。
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api import CorrelationMiddleware, install_error_handlers, problem_responses
from .api.evidence_router import create_evidence_router
from .api.product_router import ProductApiDependencies, create_product_router
from .collaboration_contexts.api import create_collaboration_context_router
from .collaboration_intents.api import create_collaboration_intent_router
from .collaboration_protocols.api import create_collaboration_protocol_router
from .composition import (
    build_components,
    expose_components,
    register_runtime_surfaces,
)
from .config import Settings
from .execution_dispatch.api import create_execution_dispatch_router
from .harness.api import create_harness_router
from .home.api import create_home_router
from .lifecycle import create_lifespan
from .model_call_review import InMemoryModelCallReviewStore
from .model_call_workflow import ProviderTransport
from .observability.diagnostics import create_diagnostics_router
from .observability.logging import configure_observability
from .pi_gateway import PiRuntimeManager
from .product_sessions import ProductSessionService
from .project_resources.api import create_project_resource_router
from .projections.api import create_projection_router
from .runtime_adapters import assert_runtime_compatibility
from .runtime_execution.endpoint import add_runtime_management_endpoints
from .step_inputs.api import create_step_input_router


def create_app(
    settings: Settings | None = None,
    *,
    model_call_store: InMemoryModelCallReviewStore | None = None,
    model_call_transport: ProviderTransport | None = None,
    product_session_service: ProductSessionService | None = None,
    pi_runtime_manager: PiRuntimeManager | None = None,
    start_outbox_worker: bool = True,
    outbox_worker_id: str | None = None,
    start_execution_worker: bool = True,
    execution_worker_id: str | None = None,
) -> FastAPI:
    """组装一个相互隔离的 API/Runtime 进程。

    调用链是 ``asgi.py -> create_app -> build_components -> FastAPI``。
    本函数只接线：产品规则留在应用服务，HTTP 翻译留在 Router，Worker 的
    启停留在 lifespan。测试可注入 Store、Transport 或 Service，避免连接
    真实外部系统。
    """

    # 1. 把配置变成依赖对象图；此时只“造对象”，还没有开始接收请求。
    resolved = settings or Settings.from_file()
    assert_runtime_compatibility()
    configure_observability(resolved.observability)
    components = build_components(
        resolved,
        model_call_store=model_call_store,
        model_call_transport=model_call_transport,
        product_session_service=product_session_service,
        pi_runtime_manager=pi_runtime_manager,
        execution_worker_id=execution_worker_id,
    )
    # 2. FastAPI 是 ASGI 应用对象；lifespan 管理数据库初始化和后台任务。
    app = FastAPI(
        title="Chat",
        version="0.1.0",
        description="Independent AI collaboration Chat product powered by MAF and AG-UI.",
        lifespan=create_lifespan(
            components,
            start_outbox_worker=start_outbox_worker,
            start_execution_worker=start_execution_worker,
        ),
        responses=problem_responses(),
    )
    # 3. 中间件包住所有请求；Router 把 URL 翻译为应用服务调用。
    install_error_handlers(app)
    expose_components(app, components)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(resolved.frontend_origins),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=[
            "X-Request-ID",
            "X-Runtime-Cursor",
            "X-Runtime-Job-Id",
            "ETag",
            "X-Projection-Revision",
            "X-Projection-Schema-Version",
            "X-Obsidian-Tree-Hash",
        ],
    )
    app.add_middleware(CorrelationMiddleware)

    app.include_router(create_harness_router(components.harness))
    app.include_router(create_home_router(components.home))
    app.include_router(create_projection_router(components.projections))
    app.include_router(create_project_resource_router(components.project_resources))
    app.include_router(create_collaboration_context_router(components.collaboration_contexts))
    app.include_router(create_collaboration_intent_router(components.collaboration_intents))
    app.include_router(create_collaboration_protocol_router(components.collaboration_protocols))
    app.include_router(create_diagnostics_router(components.diagnostics))
    app.include_router(create_step_input_router(components.step_inputs))
    app.include_router(create_execution_dispatch_router(components.execution_dispatch))
    app.include_router(create_evidence_router(components.result_commit))
    add_runtime_management_endpoints(
        app,
        runtime=components.runtime_execution,
    )
    app.include_router(
        create_product_router(
            ProductApiDependencies(
                settings=resolved,
                model_catalog=components.model_catalog,
                product_sessions=components.product_sessions,
                runtime_execution=components.runtime_execution,
                execution_dispatch=components.execution_dispatch,
                governance=components.governance,
                tool_configurations=components.tool_configurations,
                agent_profiles=components.agent_profiles,
                review_store=components.review_store,
                pi_runtime=components.pi_runtime,
            )
        )
    )
    register_runtime_surfaces(
        app,
        components,
        outbox_worker_id=outbox_worker_id,
    )
    return app


def create_api_app() -> FastAPI:
    """创建只承载 API 的进程；Outbox 与执行 Worker 由其他进程负责。

    这体现了“代码模块”和“部署进程”是两回事：同一套应用服务既可以在本地
    单进程运行，也可以把后台执行拆到独立 Worker，而不改变 HTTP 合同。
    """

    return create_app(
        start_outbox_worker=False,
        start_execution_worker=False,
    )
