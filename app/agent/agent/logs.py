"""Structured JSON logging to stdout. Never pass prompt or completion text to these helpers."""
import json
import logging
import os
import sys


def configure(service: str) -> logging.Logger:
    logger = logging.getLogger(service)
    if not logger.handlers:
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(logging.Formatter("%(message)s"))
        logger.addHandler(handler)
    logger.setLevel(os.environ.get("LOG_LEVEL", "INFO").upper())
    return logger


def event(logger: logging.Logger, name: str, level: int = logging.INFO, **fields) -> None:
    logger.log(level, json.dumps({"event": name, **fields}, sort_keys=True, default=str))
