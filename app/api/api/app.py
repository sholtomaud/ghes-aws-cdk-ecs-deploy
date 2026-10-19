"""Flask API. Reached only through the frontend's /api proxy behind the internal, Cognito-authenticated ALB."""
import json
import logging
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import urlencode

from flask import Flask, g, jsonify, redirect, request

MAX_MESSAGE_CHARS = 4000
SELFTEST_INTERVAL_SECONDS = 60
ALB_COOKIE_PREFIX = "AWSELBAuthSessionCookie"


class AgentError(Exception):
    pass


def call_agent(base_url: str, path: str, payload: dict, timeout: float) -> dict:
    """POST JSON to the agent container on the task's loopback interface."""
    req = urllib.request.Request(
        base_url.rstrip("/") + path, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        raise AgentError(str(exc)) from exc


def _logger() -> logging.Logger:
    log = logging.getLogger("api")
    if not log.handlers:
        h = logging.StreamHandler(sys.stdout)
        h.setFormatter(logging.Formatter("%(message)s"))
        log.addHandler(h)
    log.setLevel(os.environ.get("LOG_LEVEL", "INFO").upper())
    return log


def create_app() -> Flask:
    secret = os.environ.get("FLASK_SECRET_KEY", "")
    if len(secret) < 16:
        raise RuntimeError("FLASK_SECRET_KEY must be set (injected from Secrets Manager)")
    app = Flask(__name__)
    app.config["SECRET_KEY"] = secret
    log = _logger()
    agent_url = os.environ.get("AGENT_URL", "http://127.0.0.1:8000")
    smoke_enabled = os.environ.get("SMOKE_TEST_ENABLED", "false") == "true"
    selftest_lock = threading.Lock()
    last_selftest = [0.0]

    def emit(name: str, **fields) -> None:
        log.info(json.dumps({"event": name, **fields}, sort_keys=True))

    @app.before_request
    def start_timer():
        g.started = time.monotonic()

    @app.after_request
    def finish(resp):
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["Cache-Control"] = "no-store"
        # Method, path, status and timing only: never bodies, headers or tokens.
        emit("request", method=request.method, path=request.path, status=resp.status_code,
             duration_ms=round((time.monotonic() - g.get("started", time.monotonic())) * 1000))
        return resp

    @app.get("/api/healthz")
    def healthz():
        return jsonify(status="ok")

    @app.get("/api/me")
    def me():
        sub = request.headers.get("x-amzn-oidc-identity")
        if not sub:
            return jsonify(error="not authenticated"), 401
        return jsonify(sub=sub)

    @app.post("/api/chat")
    def chat():
        body = request.get_json(silent=True)
        message = body.get("message") if isinstance(body, dict) else None
        if not isinstance(message, str) or not message.strip() or len(message) > MAX_MESSAGE_CHARS:
            return jsonify(error=f"message must be a non-empty string of at most {MAX_MESSAGE_CHARS} characters"), 400
        try:
            result = call_agent(agent_url, "/invoke", {"message": message}, timeout=110)
        except AgentError:
            emit("agent_unavailable")
            return jsonify(error="the assistant is temporarily unavailable"), 502
        return jsonify(reply=result.get("reply", ""))

    @app.get("/api/selftest")
    def selftest():
        if not smoke_enabled:
            return jsonify(error="not found"), 404
        with selftest_lock:
            if time.monotonic() - last_selftest[0] < SELFTEST_INTERVAL_SECONDS and last_selftest[0] > 0:
                return jsonify(error="rate limited"), 429
            last_selftest[0] = time.monotonic()
        try:
            result = call_agent(agent_url, "/selftest", {}, timeout=60)
        except AgentError:
            return jsonify(status="error", bedrock="error"), 503
        return jsonify(status="ok" if result.get("bedrock") == "ok" else "error", bedrock=result.get("bedrock", "error"))

    @app.get("/api/logout")
    def logout():
        query = urlencode({"client_id": os.environ.get("COGNITO_CLIENT_ID", ""), "logout_uri": f"https://{os.environ.get('APP_HOSTNAME', '')}/"})
        resp = redirect(f"https://{os.environ.get('COGNITO_DOMAIN', '')}/logout?{query}", code=302)
        names = {c for c in request.cookies if c.startswith(ALB_COOKIE_PREFIX)} | {f"{ALB_COOKIE_PREFIX}-0", f"{ALB_COOKIE_PREFIX}-1"}
        for name in sorted(names):
            resp.set_cookie(name, "", expires=0, secure=True, httponly=True, samesite="Lax", path="/")
        return resp

    return app
