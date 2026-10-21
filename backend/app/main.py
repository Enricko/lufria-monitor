import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import auth, db, energy, sampler, terminal
from .collectors import services, speedtest, system
from .config import FRONTEND_DIST, PUBLIC_ORIGIN, TARIFF_PRESETS

RANGES = {"1h": 3600, "6h": 6 * 3600, "24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400}


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.conn()
    tasks = [asyncio.create_task(sampler.run()), asyncio.create_task(speedtest.scheduler())]
    yield
    terminal.close_all()
    for t in tasks:
        t.cancel()


app = FastAPI(title="Lufria Monitor", lifespan=lifespan)
app.add_middleware(auth.AuthMiddleware)


def _threaded(fn, *args):
    return asyncio.get_running_loop().run_in_executor(None, fn, *args)


def _same_origin(request: Request):
    if not auth.same_origin(request.headers):
        raise HTTPException(403, "cross-site request refused")


def _ip(request: Request) -> str:
    return auth.client_ip(dict(request.headers), request.client.host if request.client else "")


def _not_locked(request: Request) -> str:
    ip = _ip(request)
    if auth.locked_out(ip):
        raise HTTPException(429, "Too many attempts, try again in 5 minutes")
    return ip


async def _fail(ip: str, status: int, detail: str):
    auth.record_fail(ip)
    await asyncio.sleep(1)
    raise HTTPException(status, detail)


def _start_session(request: Request, response: Response):
    secure = request.headers.get("x-forwarded-proto", request.url.scheme) == "https"
    response.set_cookie(auth.COOKIE, auth.make_session(), max_age=auth.SESSION_TTL,
                        httponly=True, secure=secure, samesite="lax")


@app.get("/api/auth/status")
async def auth_status(request: Request):
    return {"enabled": auth.enabled(),
            "authenticated": auth.valid_session(request.cookies.get(auth.COOKIE)),
            "password": auth.password_enabled(), "passkeys": auth.has_passkeys(), "origin": PUBLIC_ORIGIN}


@app.post("/api/auth/login")
async def auth_login(body: dict, request: Request, response: Response):
    ip = _not_locked(request)
    if auth.has_passkeys():
        raise HTTPException(403, "Password sign-in is off, use a passkey or the QR code")
    if not await _threaded(auth.verify_password, str(body.get("password", ""))):
        await _fail(ip, 401, "Wrong password")
    _start_session(request, response)
    return {"ok": True}


@app.post("/api/auth/passkey/options")
async def passkey_login_options():
    return auth.authentication_options("login")


@app.post("/api/auth/passkey")
async def passkey_login(body: dict, request: Request, response: Response):
    ip = _not_locked(request)
    if not auth.verify_passkey(body.get("flow"), body.get("credential"), "login"):
        await _fail(ip, 401, "Passkey not accepted")
    _start_session(request, response)
    return {"ok": True}


@app.post("/api/auth/qr")
async def qr_start(request: Request):
    if not auth.has_passkeys():
        raise HTTPException(409, "Add a passkey first")
    return auth.qr_start(_ip(request), request.headers.get("user-agent", ""), request.headers.get("cf-ipcountry"))


@app.post("/api/auth/qr/{rid}/poll")
async def qr_poll(rid: str, body: dict, request: Request, response: Response):
    status = auth.qr_poll(rid, body.get("poll", ""))
    if status == "approved":
        _start_session(request, response)
    return {"status": status}


@app.get("/api/auth/qr/{rid}")
async def qr_info(rid: str):
    info = auth.qr_info(rid)
    if info is None:
        raise HTTPException(404, "This code has expired")
    return info


@app.post("/api/auth/qr/{rid}/options")
async def qr_options(rid: str):
    if auth.qr_info(rid) is None:
        raise HTTPException(404, "This code has expired")
    return auth.authentication_options(f"qr:{rid}")


@app.post("/api/auth/qr/{rid}/approve")
async def qr_approve(rid: str, body: dict, request: Request):
    ip = _not_locked(request)
    if not auth.qr_approve(rid, body.get("flow"), body.get("credential")):
        await _fail(ip, 401, "Passkey not accepted, or the code expired")
    return {"ok": True}


@app.post("/api/auth/qr/{rid}/deny")
async def qr_deny(rid: str):
    auth.qr_deny(rid)
    return {"ok": True}


@app.post("/api/auth/enroll/options")
async def enroll_options(body: dict, request: Request):
    ip = _not_locked(request)
    if not auth.enroll_ok(body.get("token")):
        await _fail(ip, 404, "This link has expired, make a new one with `python -m app.auth enroll`")
    return auth.registration_options("enroll")


@app.post("/api/auth/enroll")
async def enroll(body: dict, request: Request, response: Response):
    ip = _not_locked(request)
    if not auth.enroll_ok(body.get("token")):
        await _fail(ip, 404, "This link has expired, make a new one with `python -m app.auth enroll`")
    if not auth.add_passkey(body.get("flow"), body.get("credential"), str(body.get("name", "")), "enroll"):
        await _fail(ip, 400, "Passkey not accepted")
    auth.enroll_done()
    _start_session(request, response)
    return {"ok": True}


@app.get("/api/passkeys")
async def passkeys():
    return auth.list_passkeys()


@app.post("/api/passkeys/options")
async def passkey_register_options(request: Request):
    _same_origin(request)
    return auth.registration_options("register")


@app.post("/api/passkeys")
async def passkey_register(body: dict, request: Request, response: Response):
    _same_origin(request)
    if not auth.add_passkey(body.get("flow"), body.get("credential"), str(body.get("name", "")), "register"):
        raise HTTPException(400, "Passkey not accepted")
    _start_session(request, response)  # the first passkey replaces the secret, which ends the old session
    return {"ok": True}


@app.delete("/api/passkeys/{cred_id}")
async def passkey_remove(cred_id: str, request: Request):
    _same_origin(request)
    if err := auth.remove_passkey(cred_id):
        raise HTTPException(400, err)
    return {"ok": True}


@app.post("/api/auth/logout")
async def auth_logout(response: Response):
    response.delete_cookie(auth.COOKIE)
    return {"ok": True}


@app.get("/api/specs")
async def get_specs():
    return await _threaded(system.specs)


@app.get("/api/live")
async def get_live():
    return sampler.latest


@app.get("/api/history")
async def get_history(range: str = "1h"):
    if range not in RANGES:
        raise HTTPException(400, f"range must be one of {list(RANGES)}")
    return await _threaded(sampler.history, RANGES[range])


@app.get("/api/processes")
async def get_processes():
    return await _threaded(system.top_processes)


@app.get("/api/storage")
async def get_storage():
    return await _threaded(system.storage)


@app.get("/api/services")
async def get_services():
    watched = db.get_settings()["watched_services"]
    systemd, docker, tunnel = await asyncio.gather(
        _threaded(services.systemd, watched), _threaded(services.docker), _threaded(services.tunnel)
    )
    return {"systemd": systemd, "docker": docker, "tunnel": tunnel}


@app.get("/api/power/summary")
async def get_power_summary():
    return await _threaded(energy.summary)


@app.get("/api/power/buckets")
async def get_power_buckets(period: str = "hour"):
    if period not in energy.PERIODS:
        raise HTTPException(400, f"period must be one of {list(energy.PERIODS)}")
    return await _threaded(energy.buckets, period)


@app.get("/api/power/apps")
async def get_power_apps(window: str = "24h"):
    if window not in energy.APP_WINDOWS:
        raise HTTPException(400, f"window must be one of {list(energy.APP_WINDOWS)}")
    return await _threaded(energy.apps, window)


@app.get("/api/speedtest")
async def get_speedtests():
    return {"running": speedtest.state["running"], "history": speedtest.history()}


@app.post("/api/speedtest")
async def run_speedtest():
    if speedtest.state["running"]:
        raise HTTPException(409, "speedtest already running")
    asyncio.create_task(speedtest.run())
    return {"started": True}


@app.get("/api/settings")
async def get_settings():
    return {"settings": db.get_settings(), "tariff_presets": TARIFF_PRESETS}


@app.put("/api/settings")
async def put_settings(values: dict):
    preset = values.get("tariff_preset")
    if preset and preset != "custom":
        if preset not in TARIFF_PRESETS:
            raise HTTPException(400, "unknown tariff preset")
        values["tariff_rp_per_kwh"] = TARIFF_PRESETS[preset]["rate"]
    return {"settings": db.save_settings(values), "tariff_presets": TARIFF_PRESETS}


@app.get("/api/terminal")
async def list_terminals():
    return terminal.overview()


@app.post("/api/terminal")
async def open_terminal(body: dict, request: Request):
    _same_origin(request)
    if len(terminal.sessions) >= terminal.MAX_SESSIONS:
        raise HTTPException(409, f"at most {terminal.MAX_SESSIONS} terminals can be open")
    return terminal.Session(body.get("cols"), body.get("rows")).info()


@app.delete("/api/terminal/{sid}")
async def close_terminal(sid: str, request: Request):
    _same_origin(request)
    s = terminal.sessions.get(sid)
    if s is None:
        raise HTTPException(404, "no such terminal")
    s.kill()
    return {"ok": True}


@app.websocket("/ws/terminal/{sid}")
async def ws_terminal(ws: WebSocket, sid: str, since: int | None = None):
    if not auth.same_origin(ws.headers):
        await ws.close()  # before accept: the handshake is refused with 403
        return
    await ws.accept()
    s = terminal.sessions.get(sid)
    if s is None:
        await ws.close(4404)
        return
    await terminal.serve(ws, s, since)


@app.websocket("/ws/live")
async def ws_live(ws: WebSocket):
    await ws.accept()
    q: asyncio.Queue = asyncio.Queue(maxsize=2)
    sampler.subscribers.add(q)
    try:
        if sampler.latest:
            await ws.send_json(sampler.latest)
        while True:
            await ws.send_json(await q.get())
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        sampler.subscribers.discard(q)


# Built React app (frontend/dist), with SPA fallback
if (FRONTEND_DIST / "assets").exists():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")


@app.get("/{path:path}", include_in_schema=False)
async def spa(path: str):
    file = FRONTEND_DIST / path
    if path and file.is_file() and FRONTEND_DIST in file.resolve().parents:
        return FileResponse(file)
    index = FRONTEND_DIST / "index.html"
    if index.exists():
        return FileResponse(index)
    raise HTTPException(404, "frontend not built - run `npm run build` in frontend/")
