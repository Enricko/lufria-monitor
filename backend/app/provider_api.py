"""Authenticated Monitor provider management. No credential-bearing response models."""
import asyncio

from fastapi import APIRouter, Depends, HTTPException, Request

from . import auth, providers

router = APIRouter(prefix="/api/providers")


def _same_origin(request: Request):
    if not auth.same_origin(request.headers):
        raise HTTPException(403, "cross-origin provider write forbidden")


async def _body(request: Request, *, create=False) -> dict:
    # RequestValidationError/Pydantic's default errors include raw input. Parse
    # explicitly so invalid credentials/URLs never get reflected in an error.
    try:
        body = await request.json()
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(400, "Invalid provider JSON") from None
    allowed = {"name", "base_url", "api_key", "enabled"}
    if not isinstance(body, dict) or set(body) - allowed:
        raise HTTPException(400, "Invalid provider fields")
    if create and not {"name", "base_url"} <= body.keys():
        raise HTTPException(400, "Provider name and base URL are required")
    if any(not isinstance(body[key], str) for key in ("name", "base_url", "api_key") if key in body):
        raise HTTPException(400, "Provider name, base URL and API key must be strings")
    if "enabled" in body and not isinstance(body["enabled"], bool):
        raise HTTPException(400, "Provider enabled must be a boolean")
    return body


async def _operate(action=None, provider_id=None, values=None, *, discover=False):
    def work():
        registry = providers.get_registry()
        if action == "refresh":
            return registry.refresh(provider_id)
        if action == "create":
            registry.create(**values)
        elif action == "update":
            registry.update(provider_id, **values)
        elif action == "delete":
            registry.delete(provider_id)
        return registry.catalog(discover=discover or action in ("create", "update", "delete"))
    try:
        return await asyncio.to_thread(work)
    except providers.ProviderNotFound as exc:
        raise HTTPException(404, str(exc)) from None
    except providers.ProviderError as exc:
        raise HTTPException(400, str(exc)) from None
    except OSError:
        raise HTTPException(500, "Provider storage could not be saved") from None


@router.get("")
async def catalog():
    return await _operate(discover=True)


@router.post("", dependencies=[Depends(_same_origin)])
async def create(request: Request):
    return await _operate("create", values=await _body(request, create=True))


@router.post("/refresh", dependencies=[Depends(_same_origin)])
async def refresh_all():
    return await _operate("refresh")


@router.put("/{provider_id}", dependencies=[Depends(_same_origin)])
async def update(provider_id: str, request: Request):
    return await _operate("update", provider_id, await _body(request))


@router.delete("/{provider_id}", dependencies=[Depends(_same_origin)])
async def delete(provider_id: str):
    return await _operate("delete", provider_id)


@router.post("/{provider_id}/refresh", dependencies=[Depends(_same_origin)])
async def refresh_one(provider_id: str):
    return await _operate("refresh", provider_id)
