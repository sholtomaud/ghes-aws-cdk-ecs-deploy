"""LangChain chain construction. The provider is Amazon Bedrock in production; 'fake' is for local tests."""
from typing import Mapping

from langchain_core.output_parsers import StrOutputParser
from langchain_core.prompts import ChatPromptTemplate

SYSTEM_PROMPT = (
    "You are a helpful assistant for employees of the deploying organisation. "
    "Answer concisely. If you do not know, say so."
)


def _bedrock_class():
    from langchain_aws import ChatBedrockConverse  # imported lazily: not needed for local fake mode

    return ChatBedrockConverse


def build_model(env: Mapping[str, str]):
    provider = env.get("LLM_PROVIDER", "bedrock")
    if provider == "bedrock":
        model_id = env.get("BEDROCK_MODEL_ID")
        if not model_id:
            raise ValueError("BEDROCK_MODEL_ID is required when LLM_PROVIDER=bedrock")
        return _bedrock_class()(
            model=model_id,
            region_name=env.get("AWS_REGION"),
            max_tokens=int(env.get("BEDROCK_MAX_TOKENS", "1024")),
            temperature=0.2,
        )
    if provider == "fake":
        from langchain_core.language_models.fake_chat_models import FakeListChatModel

        responses = env.get("FAKE_RESPONSES", "This is a local test response.").split("|")
        return FakeListChatModel(responses=responses)
    raise ValueError(f"unsupported LLM_PROVIDER {provider!r} (expected 'bedrock' or 'fake')")


def build_chain(env: Mapping[str, str]):
    prompt = ChatPromptTemplate.from_messages([("system", SYSTEM_PROMPT), ("human", "{message}")])
    return prompt | build_model(env) | StrOutputParser()
