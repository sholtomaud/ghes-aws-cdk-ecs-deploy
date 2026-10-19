import json
import logging

import pytest

from agent.app import create_app
from agent.llm import build_chain, build_model


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "fake")
    monkeypatch.setenv("FAKE_RESPONSES", "Hello from the fake model|OK")
    app = create_app()
    app.config.update(TESTING=True)
    return app.test_client()


def test_healthz_never_calls_the_model(client, monkeypatch):
    monkeypatch.setattr("agent.app._invoke", lambda *a, **k: pytest.fail("model invoked"))
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.get_json() == {"status": "ok"}


def test_invoke_returns_the_model_reply(client):
    r = client.post("/invoke", json={"message": "hi there"})
    assert r.status_code == 200
    assert r.get_json() == {"reply": "Hello from the fake model"}


@pytest.mark.parametrize("body", [None, {}, {"message": ""}, {"message": 5}, {"message": "x" * 8001}])
def test_invoke_rejects_invalid_input(client, body):
    r = client.post("/invoke", data=json.dumps(body) if body is not None else "not json", content_type="application/json")
    assert r.status_code == 400
    assert "error" in r.get_json()


def test_selftest_uses_a_fixed_prompt_and_reports_bedrock_ok(client):
    r = client.post("/selftest")
    assert r.status_code == 200
    assert r.get_json()["bedrock"] == "ok"


def test_model_failure_is_a_502_without_leaking_details(client, monkeypatch):
    def boom(*_a, **_k):
        raise RuntimeError("AccessDeniedException: arn:aws:iam::123456789012:role/secret-role")

    monkeypatch.setattr("agent.app._invoke", boom)
    r = client.post("/invoke", json={"message": "hello"})
    assert r.status_code == 502
    assert "arn:aws" not in r.get_data(as_text=True)
    s = client.post("/selftest")
    assert s.status_code == 503
    assert s.get_json()["bedrock"] == "error"


def test_logs_are_structured_and_never_contain_prompt_content(client, caplog):
    caplog.set_level(logging.INFO)
    client.post("/invoke", json={"message": "my secret prompt text"})
    text = "\n".join(r.getMessage() for r in caplog.records)
    assert "my secret prompt text" not in text
    assert "Hello from the fake model" not in text
    events = [json.loads(r.getMessage()) for r in caplog.records if r.getMessage().startswith("{")]
    assert any(e.get("event") == "invoke" and e.get("message_chars") == len("my secret prompt text") for e in events)


def test_bedrock_provider_uses_the_configured_model_and_region(monkeypatch):
    captured = {}

    class FakeConverse:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    monkeypatch.setattr("agent.llm._bedrock_class", lambda: FakeConverse)
    build_model({"LLM_PROVIDER": "bedrock", "BEDROCK_MODEL_ID": "amazon.nova-micro-v1:0", "AWS_REGION": "eu-west-1", "BEDROCK_MAX_TOKENS": "256"})
    assert captured["model"] == "amazon.nova-micro-v1:0"
    assert captured["region_name"] == "eu-west-1"
    assert captured["max_tokens"] == 256


def test_bedrock_provider_requires_a_model_id():
    with pytest.raises(ValueError, match="BEDROCK_MODEL_ID"):
        build_chain({"LLM_PROVIDER": "bedrock"})


def test_unknown_provider_is_rejected():
    with pytest.raises(ValueError, match="LLM_PROVIDER"):
        build_chain({"LLM_PROVIDER": "openai"})
