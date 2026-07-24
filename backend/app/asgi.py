"""Default ASGI entrypoint.

Importing :mod:`backend.app.main` is side-effect free for tests and tooling;
only this deployment entrypoint loads the private runtime configuration.
"""

from .main import create_app

app = create_app()
