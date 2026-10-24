"""Monitor-owned provider credentials, discovery snapshots and exact routing.

Only this module's credential resolver may expose keys internally. Public catalog
objects are explicitly projected, never copies of private provider records.
"""
import copy
import json
import os
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx

from .config import DATA_DIR, ROOT

ENV_FILE = ROOT / ".env"
PROVIDERS: list[dict[str, Any]] = [
    {"id": "binav", "name": "Binav Router", "base_url": "https://router.binav.id/v1",
     "key_env": "HERMES_CUSTOM_ROUTER_BINAV_ID_API_KEY"},
    {"id": "lufria", "name": "Lufria Router", "base_url": "https://9router.lufria.tech/v1",
     "key_env": "HERMES_CUSTOM_9ROUTER_LUFRIA_TECH_API_KEY"},
    {"id": "omo", "name": "OMO API HUB", "base_url": "https://omoapicall.web.id/v1",
     "key_env": "HERMES_CUSTOM_OMOAPICALL_WEB_ID_API_KEY"},
]
_CACHE_TTL = 300.0


class ProviderError(ValueError):
    """Safe, user-facing provider configuration/routing error."""


class ProviderNotFound(ProviderError):
    pass


def get_api_key(key_env: str) -> str:
    """Keep existing environment/.env fallback without changing Hermes config."""
    val = os.environ.get(key_env, "")
    if val:
        return val
    try:
        for line in ENV_FILE.read_text("utf-8").splitlines():
            if line.startswith(f"{key_env}="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return ""


def atomic_write_json(path: Path, value) -> None:
    """Replace a private JSON file atomically; no world-readable temp window."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            os.fchmod(stream.fileno(), 0o600)
            json.dump(value, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def validate_url(value: str) -> str:
    try:
        if not isinstance(value, str) or any(c.isspace() or ord(c) < 32 for c in value) or any(c in value for c in ("?", "#", "\\")):
            raise ValueError
        parsed = urlsplit(value)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username is not None or parsed.password is not None:
            raise ValueError
        _ = parsed.port
    except (ValueError, TypeError):
        raise ProviderError("Base URL must be HTTP(S) without credentials, query or fragment") from None
    return value.rstrip("/")


def validate_name(value: str) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > 200:
        raise ProviderError("Provider name must contain 1–200 characters")
    return value.strip()


class ProviderRegistry:
    def __init__(self, path: Path, *, builtins=None):
        self.path = Path(path)
        self.lock = threading.RLock()
        if self.path.exists():
            # Fail closed on corrupt state; never silently resurrect deleted providers.
            try:
                stored = json.loads(self.path.read_text("utf-8"))
                self.records = stored["providers"]
                if not isinstance(self.records, list):
                    raise ValueError
            except (OSError, ValueError, KeyError, TypeError):
                raise ProviderError("Provider storage is unreadable") from None
        else:
            example_path = self.path.with_name("providers.example.json")
            if builtins is None and example_path.exists():
                try:
                    stored = json.loads(example_path.read_text("utf-8"))
                    self.records = stored.get("providers", [])
                except Exception:
                    self.records = []
            else:
                self.records = []

            if not self.records:
                self.records = copy.deepcopy(PROVIDERS if builtins is None else builtins)
                for record in self.records:
                    record.update(enabled=True, models=[], last_refreshed=None, error=None)

    def _find(self, provider_id):
        for record in self.records:
            if record["id"] == provider_id:
                return record
        raise ProviderNotFound("Provider not found")

    @staticmethod
    def _key(record):
        return record.get("api_key") or (get_api_key(record["key_env"]) if record.get("key_env") else "")

    def _commit(self, records):
        atomic_write_json(self.path, {"version": 1, "providers": records})
        self.records = records

    def _public_provider(self, record):
        return {"id": record["id"], "name": record["name"], "base_url": record["base_url"],
                "enabled": record["enabled"], "api_key_configured": bool(self._key(record)),
                "model_count": len(record.get("models", [])),
                "last_refreshed": record.get("last_refreshed"), "error": record.get("error")}

    def catalog(self, *, discover=True):
        with self.lock:
            if discover:
                now = time.time()
                for record in list(self.records):
                    if record["enabled"] and now - record.get("last_attempt", 0) >= _CACHE_TTL:
                        self.refresh(record["id"])
            models = [
                {"id": model["id"], "name": model["name"], "provider": record["name"], "provider_id": record["id"]}
                for record in self.records if record["enabled"] for model in record.get("models", [])
            ]
            return {"providers": [self._public_provider(r) for r in self.records], "models": models}

    def refresh(self, provider_id=None):
        with self.lock:
            if provider_id is not None:
                self._find(provider_id)
            records = copy.deepcopy(self.records)
            for record in records:
                if not record["enabled"] or (provider_id is not None and record["id"] != provider_id):
                    continue
                record["last_attempt"] = time.time()
                try:
                    key = self._key(record)
                    response = httpx.get(f"{record['base_url']}/models",
                                         headers={"Authorization": f"Bearer {key}"} if key else {},
                                         timeout=7.0, follow_redirects=False)
                    if response.status_code != 200:
                        raise ProviderError(f"Model discovery failed (HTTP {response.status_code})")
                    data = response.json().get("data")
                    if not isinstance(data, list):
                        raise ProviderError("Model discovery returned an invalid model list")
                    seen = set()
                    models = []
                    for model in data:
                        if not isinstance(model, dict) or not isinstance(model.get("id"), str) or not model["id"]:
                            raise ProviderError("Model discovery returned an invalid model list")
                        mid = model["id"]
                        if mid not in seen:
                            seen.add(mid)
                            name = model.get("name")
                            models.append({"id": mid, "name": name if isinstance(name, str) and name else mid})
                    record.update(models=models, last_refreshed=time.time(), error=None)
                except ProviderError as exc:
                    record["error"] = str(exc)
                except Exception:
                    # Never forward response bodies, URLs, headers or exception strings.
                    record["error"] = "Model discovery failed (network or invalid response)"
            self._commit(records)
            return self.catalog(discover=False)

    def create(self, *, name, base_url, api_key="", enabled=True):
        with self.lock:
            record = {"id": uuid.uuid4().hex, "name": validate_name(name), "base_url": validate_url(base_url),
                      "api_key": api_key or "", "enabled": enabled, "models": [],
                      "last_refreshed": None, "error": None}
            self._commit([*self.records, record])
            return self._public_provider(record)

    def update(self, provider_id, **changes):
        with self.lock:
            self._find(provider_id)
            records = copy.deepcopy(self.records)
            record = next(r for r in records if r["id"] == provider_id)
            if "base_url" in changes:
                old_origin = urlsplit(record["base_url"])
                new_origin = urlsplit(validate_url(changes["base_url"]))
                if (old_origin.scheme, old_origin.netloc) != (new_origin.scheme, new_origin.netloc) and self._key(record) and not changes.get("api_key"):
                    raise ProviderError("Re-enter an API key when changing the provider host or protocol; the existing key is not sent to a new origin")
            for field in ("name", "base_url", "enabled"):
                if field in changes:
                    record[field] = validate_name(changes[field]) if field == "name" else validate_url(changes[field]) if field == "base_url" else changes[field]
            if "base_url" in changes and record["base_url"] != self._find(provider_id)["base_url"]:
                record.update(models=[], last_refreshed=None, last_attempt=0, error=None)
            elif changes.get("api_key") or (changes.get("enabled") and not self._find(provider_id)["enabled"]):
                record["last_attempt"] = 0
            if changes.get("api_key"):
                record["api_key"] = changes["api_key"]
            self._commit(records)
            return self._public_provider(record)

    def delete(self, provider_id):
        with self.lock:
            self._find(provider_id)
            self._commit([r for r in self.records if r["id"] != provider_id])

    def resolve_model(self, model_id, provider_id=None):
        with self.lock:
            if provider_id is not None:
                record = self._find(provider_id)
                if not record["enabled"]:
                    raise ProviderError("Provider is disabled")
                return record["base_url"], self._key(record), record["name"]
            self.catalog()
            enabled = [r for r in self.records if r["enabled"]]
            for record in enabled:
                if any(m["id"] == model_id for m in record.get("models", [])):
                    return record["base_url"], self._key(record), record["name"]
            preferred = "binav" if model_id.startswith(("omop/", "omop-c/")) else "omo" if model_id.startswith(("glm-5.3-flash", "deepseek-v4-flash", "mimo-v2.6", "nemotron")) else None
            record = next((r for r in enabled if r["id"] == preferred), None) if preferred else None
            if record is None:
                record = next((r for pid in ("binav", "lufria") for r in enabled if r["id"] == pid and self._key(r)), None)
            if record is None:
                record = next(iter(enabled), None)
            if record is None:
                raise ProviderError("No enabled provider is configured")
            return record["base_url"], self._key(record), record["name"]


_registry = None
_registry_lock = threading.Lock()


def get_registry() -> ProviderRegistry:
    global _registry
    with _registry_lock:
        if _registry is None:
            _registry = ProviderRegistry(DATA_DIR / "providers.json")
        return _registry


def get_all_models(force_refresh: bool = False) -> list[dict]:
    registry = get_registry()
    return (registry.refresh() if force_refresh else registry.catalog())["models"]


def resolve_model(model_id: str, provider_id: str | None = None) -> tuple[str, str, str]:
    return get_registry().resolve_model(model_id, provider_id)
