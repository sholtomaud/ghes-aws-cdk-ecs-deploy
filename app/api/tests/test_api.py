import json
import logging
from urllib.parse import parse_qs, urlparse

import pytest

from api.app import create_app, AgentError


@pytest.fixture
def env(monkeypatch):
    for k, v in {
        "FLASK_SECRET_KEY": "test-secret-key-0123456789",
        "AGENT_URL": "http://127.0.0.1:8000",
        "APP_HOSTNAME": "assistant.corp.example.com",
        "COGNITO_DOMAIN": "corp-assistant.auth.us-east-1.amazoncognito.com",
        "COGNITO_CLIENT_ID": "client123",
        "SMOKE_TEST_ENABLED": "false",
    }.items():
        monkeypatch.setenv(k, v)


@pytest.fixture
def agent_calls(monkeypatch):
    calls = []

    def fake(base_url, path, payload, timeout):
        calls.append((base_url, path, payload, timeout))
        if path == "/invoke":
            return {"reply": "hello back"}
        return {"status": "ok", "bedrock": "ok"}

    monkeypatch.setattr("api.app.call_agent", fake)
    return calls


@pytest.fixture
def client(env, agent_calls):
    app = create_app()
    app.config.update(TESTING=True)
    return app.test_client()


def test_requires_a_secret_key(monkeypatch, env):
    monkeypatch.delenv("FLASK_SECRET_KEY")
    with pytest.raises(RuntimeError, match="FLASK_SECRET_KEY"):
        create_app()


def test_healthz(client, agent_calls):
    r = client.get("/api/healthz")
    assert r.status_code == 200 and r.get_json() == {"status": "ok"}
    assert agent_calls == []


def test_chat_forwards_to_the_agent_over_loopback(client, agent_calls):
    r = client.post("/api/chat", json={"message": "hi"}, headers={"x-amzn-oidc-identity": "user-sub-1"})
    assert r.status_code == 200
    assert r.get_json() == {"reply": "hello back"}
    assert agent_calls[0][:3] == ("http://127.0.0.1:8000", "/invoke", {"message": "hi"})


@pytest.mark.parametrize("body", [None, {}, {"message": "  "}, {"message": ["x"]}, {"message": "x" * 4001}])
def test_chat_validates_input(client, body, agent_calls):
    r = client.post("/api/chat", data=json.dumps(body) if body is not None else "nope", content_type="application/json")
    assert r.status_code == 400
    assert agent_calls == []


def test_agent_failure_is_a_502_without_internal_details(client, monkeypatch):
    def broken(*_a, **_k):
        raise AgentError("connection refused to 127.0.0.1:8000")

    monkeypatch.setattr("api.app.call_agent", broken)
    r = client.post("/api/chat", json={"message": "hi"})
    assert r.status_code == 502
    assert "127.0.0.1" not in r.get_data(as_text=True)


def test_selftest_is_disabled_by_default(client, agent_calls):
    assert client.get("/api/selftest").status_code == 404
    assert agent_calls == []


def test_selftest_when_enabled_is_rate_limited(monkeypatch, env, agent_calls):
    monkeypatch.setenv("SMOKE_TEST_ENABLED", "true")
    app = create_app()
    c = app.test_client()
    r = c.get("/api/selftest")
    assert r.status_code == 200 and r.get_json() == {"status": "ok", "bedrock": "ok"}
    assert c.get("/api/selftest").status_code == 429
    assert [p for (_, p, _, _) in agent_calls] == ["/selftest"]


def test_logout_expires_alb_session_cookies_and_redirects_to_cognito_logout(client):
    r = client.get("/api/logout", headers={"Cookie": "AWSELBAuthSessionCookie-0=a; AWSELBAuthSessionCookie-1=b"})
    assert r.status_code == 302
    loc = urlparse(r.headers["Location"])
    assert loc.scheme == "https" and loc.netloc == "corp-assistant.auth.us-east-1.amazoncognito.com" and loc.path == "/logout"
    assert parse_qs(loc.query) == {"client_id": ["client123"], "logout_uri": ["https://assistant.corp.example.com/"]}
    cookies = r.headers.getlist("Set-Cookie")
    for name in ("AWSELBAuthSessionCookie-0", "AWSELBAuthSessionCookie-1"):
        c = next(x for x in cookies if x.startswith(name + "="))
        assert "Expires=Thu, 01 Jan 1970" in c and "Secure" in c and "HttpOnly" in c


def test_me_reports_the_alb_authenticated_identity(client):
    assert client.get("/api/me", headers={"x-amzn-oidc-identity": "abc-123"}).get_json() == {"sub": "abc-123"}
    assert client.get("/api/me").status_code == 401


def test_request_logs_are_structured_and_exclude_message_content(client, caplog):
    caplog.set_level(logging.INFO)
    client.post("/api/chat", json={"message": "confidential question"}, headers={"Authorization": "Bearer t0ken"})
    text = "\n".join(r.getMessage() for r in caplog.records)
    assert "confidential question" not in text and "t0ken" not in text
    events = [json.loads(r.getMessage()) for r in caplog.records]
    assert any(e["event"] == "request" and e["path"] == "/api/chat" and e["status"] == 200 for e in events)


def test_security_headers(client):
    r = client.get("/api/healthz")
    assert r.headers["X-Content-Type-Options"] == "nosniff"
    assert r.headers["Cache-Control"] == "no-store"
