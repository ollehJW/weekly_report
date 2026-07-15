import os
from pathlib import Path

from openai import AzureOpenAI

ROOT_DIR = Path(__file__).resolve().parents[1]
ENV_PATH = ROOT_DIR / ".env"


def load_env_file(path=ENV_PATH):
    if not path.exists():
        return

    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


load_env_file()

OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-5.4")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL", "")
OPENAI_API_VERSION = os.getenv("OPENAI_API_VERSION", "2025-04-01-preview")

_client = None


def create_llm_client():
    if not OPENAI_API_KEY:
        raise RuntimeError("OPENAI_API_KEY is required. Set it in .env.")
    if not OPENAI_BASE_URL:
        raise RuntimeError("OPENAI_BASE_URL is required. Set it in .env.")

    return AzureOpenAI(
        azure_endpoint=OPENAI_BASE_URL,
        api_key=OPENAI_API_KEY,
        api_version=OPENAI_API_VERSION,
    )


def get_llm_client():
    global _client
    if _client is None:
        _client = create_llm_client()
    return _client


def chat_completion(prompt, temperature=0):
    response = get_llm_client().chat.completions.create(
        model=OPENAI_MODEL,
        messages=[{"role": "user", "content": prompt}],
        temperature=temperature,
    )
    return response.choices[0].message.content.strip()
