"""Agent HTTP service. Listens on 127.0.0.1-reachable PORT inside the task; only the Flask API calls it."""
import os
import time

from flask import Flask, jsonify, request

from .llm import build_chain
from .logs import configure, event

MAX_MESSAGE_CHARS = 8000
SELFTEST_PROMPT = "Reply with the single word OK."


def _invoke(chain, message: str) -> str:
    return chain.invoke({"message": message})


def create_app() -> Flask:
    app = Flask(__name__)
    log = configure("agent")
    chain = build_chain(os.environ)

    @app.get("/healthz")
    def healthz():
        return jsonify(status="ok")

    @app.post("/invoke")
    def invoke():
        body = request.get_json(silent=True)
        message = body.get("message") if isinstance(body, dict) else None
        if not isinstance(message, str) or not message.strip() or len(message) > MAX_MESSAGE_CHARS:
            return jsonify(error=f"message must be a non-empty string of at most {MAX_MESSAGE_CHARS} characters"), 400
        started = time.monotonic()
        try:
            reply = _invoke(chain, message)
        except Exception as exc:  # model/provider failure: log the type only, never the content
            event(log, "invoke_failed", level=40, error_type=type(exc).__name__)
            return jsonify(error="the model is unavailable"), 502
        event(log, "invoke", message_chars=len(message), reply_chars=len(reply), duration_ms=round((time.monotonic() - started) * 1000))
        return jsonify(reply=reply)

    @app.post("/selftest")
    def selftest():
        """Minimal fixed-prompt model call for installation tests. Carries no user content."""
        try:
            _invoke(chain, SELFTEST_PROMPT)
        except Exception as exc:
            event(log, "selftest_failed", level=40, error_type=type(exc).__name__)
            return jsonify(status="error", bedrock="error"), 503
        event(log, "selftest_ok")
        return jsonify(status="ok", bedrock="ok")

    return app
