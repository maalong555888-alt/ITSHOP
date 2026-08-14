"""Private Telegram bot for supported Ruijie / Reyee Cloud API operations.

The bot intentionally does not guess write endpoints. Commands such as reboot,
add-device, project creation/move, client rename, and password changes are
blocked unless Ruijie publishes those operations in the official API manual.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Any, Callable

from telegram import Update
from telegram.ext import Application, CommandHandler, ContextTypes

import config
from ruijie_client import RuijieAPIError, RuijieAuthError, RuijieSession

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("ruijie-telegram-bot")

SESSIONS: dict[int, RuijieSession] = {}
ACTIVE_GROUPS: dict[int, int] = {}


@dataclass
class CacheEntry:
    expires_at: float
    value: Any


GROUP_CACHE: dict[int, CacheEntry] = {}
DEVICE_CACHE: dict[tuple[int, int], CacheEntry] = {}
CLIENT_CACHE: dict[tuple[int, int], CacheEntry] = {}
GROUP_TTL = 300
DEVICE_TTL = 300
CLIENT_TTL = 120


def _uid(update: Update) -> int | None:
    return update.effective_user.id if update.effective_user else None


def _authorized(update: Update) -> bool:
    uid = _uid(update)
    return uid is not None and uid in config.ALLOWED_USER_IDS


async def _guard(update: Update) -> bool:
    if _authorized(update):
        return True
    if update.effective_message:
        await update.effective_message.reply_text("Not authorized. This bot is private.")
    log.warning("Unauthorized Telegram access attempt user_id=%s", _uid(update))
    return False


async def _call(func: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    return await asyncio.to_thread(func, *args, **kwargs)


async def _reply_chunks(update: Update, text: str) -> None:
    msg = update.effective_message
    if not msg:
        return
    text = text or "(empty)"
    while len(text) > 3900:
        cut = text.rfind("\n", 0, 3900)
        if cut < 1000:
            cut = 3900
        await msg.reply_text(text[:cut])
        text = text[cut:].lstrip("\n")
    await msg.reply_text(text)


def _api_message(exc: Exception) -> str:
    if isinstance(exc, RuijieAuthError):
        return f"Ruijie login failed: {exc}"
    if isinstance(exc, RuijieAPIError):
        msg = exc.message.lower()
        if "permission" in msg or str(exc.code) in {"401", "403"}:
            return "Ruijie API says this App ID does not have permission for that function."
        if str(exc.code) == "404":
            return "Ruijie API endpoint was not found for this Cloud account/region."
        return f"Ruijie API error: {exc.message}"
    return "Ruijie Cloud request failed. Check the server logs for details."


async def _require_session(update: Update) -> RuijieSession | None:
    uid = _uid(update)
    if uid is None:
        return None
    existing = SESSIONS.get(uid)
    if existing:
        return existing

    if config.RUIJIE_APP_ID and config.RUIJIE_APP_SECRET:
        session = RuijieSession(
            appid=config.RUIJIE_APP_ID,
            secret=config.RUIJIE_APP_SECRET,
            base_url=config.RUIJIE_BASE_URL,
        )
        try:
            await _call(session.authenticate)
        except Exception as exc:
            log.exception("Server-side Ruijie authentication failed")
            await update.effective_message.reply_text(_api_message(exc))
            return None
        SESSIONS[uid] = session
        return session

    await update.effective_message.reply_text(
        "Ruijie is not signed in. Use /login <appid> <secret> in this private chat."
    )
    return None


def _walk_groups(node: Any, indent: int = 0):
    if isinstance(node, list):
        for item in node:
            yield from _walk_groups(item, indent)
        return
    if not isinstance(node, dict):
        return

    gid = node.get("groupId")
    if gid is not None:
        try:
            gid_i = int(gid)
        except (TypeError, ValueError):
            gid_i = None
        if gid_i is not None:
            yield {
                "group_id": gid_i,
                "name": str(node.get("name") or node.get("groupName") or "Unnamed"),
                "type": str(node.get("type") or ""),
                "indent": indent,
            }

    children = node.get("subGroups")
    if isinstance(children, list):
        for child in children:
            yield from _walk_groups(child, indent + 1)


def _parse_groups(data: dict[str, Any]) -> list[dict[str, Any]]:
    return list(_walk_groups(data.get("groups")))


async def _groups(update: Update, session: RuijieSession, *, force: bool = False) -> list[dict[str, Any]] | None:
    uid = _uid(update)
    assert uid is not None
    cached = GROUP_CACHE.get(uid)
    if not force and cached and cached.expires_at > time.time():
        return cached.value
    try:
        data = await _call(session.get_groups, "BUILDING")
    except Exception as exc:
        log.exception("Failed to read Ruijie network groups")
        await update.effective_message.reply_text(_api_message(exc))
        return None
    rows = _parse_groups(data)
    GROUP_CACHE[uid] = CacheEntry(time.time() + GROUP_TTL, rows)
    return rows


async def _devices_for_group(update: Update, session: RuijieSession, group_id: int, *, force: bool = False):
    uid = _uid(update)
    assert uid is not None
    key = (uid, int(group_id))
    cached = DEVICE_CACHE.get(key)
    if not force and cached and cached.expires_at > time.time():
        return cached.value
    rows = await _call(session.get_devices, int(group_id))
    DEVICE_CACHE[key] = CacheEntry(time.time() + DEVICE_TTL, rows)
    return rows


async def _clients_for_group(update: Update, session: RuijieSession, group_id: int, *, force: bool = False):
    uid = _uid(update)
    assert uid is not None
    key = (uid, int(group_id))
    cached = CLIENT_CACHE.get(key)
    if not force and cached and cached.expires_at > time.time():
        return cached.value
    rows = await _call(session.get_current_clients, int(group_id))
    CLIENT_CACHE[key] = CacheEntry(time.time() + CLIENT_TTL, rows)
    return rows


def _resolve_group(update: Update, args: list[str]) -> int | None:
    if args:
        try:
            return int(args[0])
        except ValueError:
            return None
    uid = _uid(update)
    return ACTIVE_GROUPS.get(uid) if uid is not None else None


def _device_line(d: dict[str, Any]) -> str:
    sn = d.get("serialNumber") or d.get("sn") or "?"
    name = d.get("aliasName") or d.get("name") or sn
    model = d.get("productClass") or d.get("productType") or d.get("commonType") or "?"
    status_raw = str(d.get("onlineStatus") or d.get("status") or "").upper()
    status = "🟢" if status_raw == "ON" else ("🔴" if status_raw in {"OFF", "NEVER_ONLINE"} else "⚪️")
    return f"{status} {name} [{model}] SN:{sn}"


def _client_line(c: dict[str, Any]) -> str:
    name = c.get("userName") or c.get("hostname") or c.get("deviceAliasName") or "client"
    mac = c.get("mac") or ""
    ip = c.get("userIp") or c.get("ip") or ""
    ssid = c.get("ssid") or ""
    extras = " · ".join(x for x in (mac, ip, ssid) if x)
    return f"• {name}" + (f" — {extras}" if extras else "")


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await _guard(update):
        return
    uid = _uid(update)
    signed_in = uid in SESSIONS or bool(config.RUIJIE_APP_ID and config.RUIJIE_APP_SECRET)
    state = "ready ✅" if signed_in else "needs /login"
    await update.effective_message.reply_text(
        "Ruijie / Reyee Cloud bot\n"
        f"API status: {state}\n\n"
        "Read commands:\n"
        "/projects — all projects/groups\n"
        "/useproject <id> — choose a project\n"
        "/devices [id] — devices in a project\n"
        "/alldevices — scan devices across all projects\n"
        "/clients [id] — current clients\n"
        "/allclients — current clients across all projects\n"
        "/device <SN> — device status/details\n"
        "/traffic <SN> — last 24h flow\n"
        "/performance <SN> — CPU/memory\n"
        "/ports <SN> — gateway/switch ports\n"
        "/poe <SN> — switch PoE info\n"
        "/login /logout — API session"
    )


async def login(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await _guard(update):
        return
    if update.effective_chat and update.effective_chat.type != "private":
        await update.effective_message.reply_text("For safety, /login only works in a private chat.")
        return
    if len(context.args) != 2:
        await update.effective_message.reply_text("Usage: /login <appid> <secret>")
        return

    appid, secret = context.args
    try:
        await update.effective_message.delete()
    except Exception:
        pass

    session = RuijieSession(appid=appid, secret=secret, base_url=config.RUIJIE_BASE_URL)
    try:
        await _call(session.authenticate)
    except Exception as exc:
        log.exception("Ruijie authentication failed")
        await context.bot.send_message(update.effective_chat.id, _api_message(exc))
        return

    uid = _uid(update)
    old = SESSIONS.pop(uid, None)
    if old:
        old.close()
    SESSIONS[uid] = session
    GROUP_CACHE.pop(uid, None)
    await context.bot.send_message(update.effective_chat.id, "Ruijie/Reyee API login successful ✅")


async def logout(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await _guard(update):
        return
    uid = _uid(update)
    old = SESSIONS.pop(uid, None)
    ACTIVE_GROUPS.pop(uid, None)
    GROUP_CACHE.pop(uid, None)
    for cache in (DEVICE_CACHE, CLIENT_CACHE):
        for key in list(cache):
            if key[0] == uid:
                cache.pop(key, None)
    if old:
        await _call(old.close)
    await update.effective_message.reply_text("Temporary Ruijie session cleared.")


async def projects(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await _guard(update):
        return
    session = await _require_session(update)
    if not session:
        return
    rows = await _groups(update, session)
    if rows is None:
        return
    if not rows:
        await update.effective_message.reply_text("No Ruijie projects/groups were returned.")
        return
    lines = [f"Ruijie/Reyee projects & groups ({len(rows)}):"]
    for r in rows:
        prefix = "  " * int(r["indent"])
        typ = f" [{r['type']}]" if r["type"] else ""
        lines.append(f"{prefix}• {r['name']}{typ} — id:{r['group_id']}")
    await _reply_chunks(update, "\n".join(lines))


async def useproject(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await _guard(update):
        return
    session = await _require_session(update)
    if not session:
        return
    if len(context.args) != 1:
        await update.effective_message.reply_text("Usage: /useproject <group_id>")
        return
    try:
        wanted = int(context.args[0])
    except ValueError:
        await update.effective_message.reply_text("group_id must be a number.")
        return
    rows = await _groups(update, session)
    if rows is None:
        return
    match = next((r for r in rows if r["group_id"] == wanted), None)
    if not match:
        await update.effective_message.reply_text("That group ID is not in your Ruijie account.")
        return
    ACTIVE_GROUPS[_uid(update)] = wanted
    await update.effective_message.reply_text(f"Selected: {match['name']} (id {wanted}) ✅")


async def devices(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await _guard(update):
        return
    session = await _require_session(update)
    if not session:
        return
    gid = _resolve_group(update, context.args)
    if gid is None:
        await update.effective_message.reply_text("Use /devices <group_id> or /useproject <group_id> first.")
        return
    try:
        rows = await _devices_for_group(update, session, gid)
    except Exception as exc:
        log.exception("Device list failed group=%s", gid)
        await update.effective_message.reply_text(_api_message(exc))
        return
    lines = [f"Devices in group {gid}: {len(rows)}"] + [_device_line(d) for d in rows]
    await _reply_chunks(update, "\n".join(lines))


async def alldevices(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await _guard(update):
        return
    session = await _require_session(update)
    if not session:
        return
    groups = await _groups(update, session)
    if groups is None:
        return
    targets = [r for r in groups if r["type"].upper() == "BUILDING"]
    if not targets:
        targets = groups

    await update.effective_message.reply_text(
        f"Scanning {len(targets)} Ruijie projects. Results are cached to protect the API daily limit…"
    )
    lines = ["All Ruijie/Reyee equipment:"]
    total = 0
    errors = 0
    for r in targets:
        gid = r["group_id"]
        try:
            rows = await _devices_for_group(update, session, gid)
        except Exception as exc:
            errors += 1
            log.warning("Device scan failed group=%s: %s", gid, exc)
            continue
        if not rows:
            continue
        lines.append(f"\n{r['name']} (id {gid})")
        for d in rows:
            total += 1
            lines.append("  " + _device_line(d))
    lines.append(f"\nTotal devices: {total}")
    if errors:
        lines.append(f"Projects with API errors/permission limits: {errors}")
    await _reply_chunks(update, "\n".join(lines))


async def clients(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await _guard(update):
        return
    session = await _require_session(update)
    if not session:
        return
    gid = _resolve_group(update, context.args)
    if gid is None:
        await update.effective_message.reply_text("Use /clients <group_id> or /useproject <group_id> first.")
        return
    try:
        rows = await _clients_for_group(update, session, gid)
    except Exception as exc:
        log.exception("Client list failed group=%s", gid)
        await update.effective_message.reply_text(_api_message(exc))
        return
    lines = [f"Current clients in group {gid}: {len(rows)}"] + [_client_line(c) for c in rows]
    await _reply_chunks(update, "\n".join(lines))


async def allclients(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await _guard(update):
        return
    session = await _require_session(update)
    if not session:
        return
    groups = await _groups(update, session)
    if groups is None:
        return
    targets = [r for r in groups if r["type"].upper() == "BUILDING"]
    if not targets:
        targets = groups
    await update.effective_message.reply_text(
        f"Scanning current clients in {len(targets)} projects. Results are cached…"
    )
    lines = ["Current clients across Ruijie projects:"]
    total = 0
    errors = 0
    for r in targets:
        try:
            rows = await _clients_for_group(update, session, r["group_id"])
        except Exception as exc:
            errors += 1
            log.warning("Client scan failed group=%s: %s", r["group_id"], exc)
            continue
        if not rows:
            continue
        lines.append(f"\n{r['name']} (id {r['group_id']})")
        for c in rows:
            total += 1
            lines.append("  " + _client_line(c))
    lines.append(f"\nTotal current clients: {total}")
    if errors:
        lines.append(f"Projects with API errors/permission limits: {errors}")
    await _reply_chunks(update, "\n".join(lines))


async def device(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await _guard(update):
        return
    session = await _require_session(update)
    if not session:
        return
    if len(context.args) != 1:
        await update.effective_message.reply_text("Usage: /device <serial_number>")
        return
    sn = context.args[0]
    try:
        data = await _call(session.get_device, sn)
    except Exception as exc:
        await update.effective_message.reply_text(_api_message(exc))
        return
    fields = {
        "Name": data.get("name"),
        "SN": data.get("serialNumber") or sn,
        "Model": data.get("productClass"),
        "Type": data.get("productType"),
        "Status": data.get("onlineStatus"),
        "Group": data.get("groupId"),
        "Software": data.get("softwareVersion"),
        "Hardware": data.get("hardwareVersion"),
        "MAC": data.get("mac"),
    }
    text = "Device details:\n" + "\n".join(f"{k}: {v}" for k, v in fields.items() if v not in (None, ""))
    await _reply_chunks(update, text)


async def traffic(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await _guard(update):
        return
    session = await _require_session(update)
    if not session:
        return
    if len(context.args) != 1:
        await update.effective_message.reply_text("Usage: /traffic <serial_number>")
        return
    sn = context.args[0]
    try:
        data = await _call(session.get_device_flow_last_24h, sn)
    except Exception as exc:
        await update.effective_message.reply_text(_api_message(exc))
        return
    rows = data.get("list") if isinstance(data.get("list"), list) else []
    rx = sum(int(x.get("rxBytes") or 0) for x in rows if isinstance(x, dict))
    tx = sum(int(x.get("txBytes") or 0) for x in rows if isinstance(x, dict))
    await update.effective_message.reply_text(
        f"Last 24h flow for {sn}:\nDownload/RX: {rx:,} bytes\nUpload/TX: {tx:,} bytes\nSamples: {len(rows)}"
    )


async def performance(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await _guard(update):
        return
    session = await _require_session(update)
    if not session:
        return
    if len(context.args) != 1:
        await update.effective_message.reply_text("Usage: /performance <serial_number>")
        return
    sn = context.args[0]
    try:
        raw = await _call(session.get_device_performance, sn)
    except Exception as exc:
        await update.effective_message.reply_text(_api_message(exc))
        return
    data = raw.get("data") if isinstance(raw.get("data"), dict) else raw
    await update.effective_message.reply_text(
        f"Performance {sn}:\nCPU: {data.get('cpuRate', '?')}%\nMemory: {data.get('memoryRate', '?')}%\nFlash: {data.get('flashRate', '?')}%"
    )


async def ports(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await _guard(update):
        return
    session = await _require_session(update)
    if not session:
        return
    if len(context.args) != 1:
        await update.effective_message.reply_text("Usage: /ports <serial_number>")
        return
    sn = context.args[0]
    try:
        data = await _call(session.get_gateway_ports, sn)
    except Exception:
        try:
            data = await _call(session.get_switch_ports, sn)
        except Exception as exc:
            await update.effective_message.reply_text(_api_message(exc))
            return
    rows = data.get("list") or data.get("data") or []
    if not isinstance(rows, list):
        rows = []
    lines = [f"Ports for {sn}: {len(rows)}"]
    for p in rows:
        if not isinstance(p, dict):
            continue
        port = p.get("port") or p.get("portIndex") or p.get("name") or "?"
        alias = p.get("alias") or p.get("portName") or ""
        up = p.get("linestatus") if "linestatus" in p else p.get("linkStatus")
        speed = p.get("speed") or ""
        lines.append(f"• {port} {alias} — link:{up} {speed}".strip())
    await _reply_chunks(update, "\n".join(lines))


async def poe(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await _guard(update):
        return
    session = await _require_session(update)
    if not session:
        return
    if len(context.args) != 1:
        await update.effective_message.reply_text("Usage: /poe <switch_serial_number>")
        return
    sn = context.args[0]
    try:
        ports_data, power_data = await asyncio.gather(
            _call(session.get_switch_poe_info, sn),
            _call(session.get_switch_poe_power, sn),
        )
    except Exception as exc:
        await update.effective_message.reply_text(_api_message(exc))
        return
    rows = ports_data.get("data") or ports_data.get("list") or []
    power = power_data.get("data") if isinstance(power_data.get("data"), dict) else {}
    lines = [f"PoE for {sn}: {power.get('curPower', '?')} / {power.get('maxPower', '?')}"]
    if isinstance(rows, list):
        for p in rows:
            if isinstance(p, dict):
                lines.append(
                    f"• Port {p.get('port', '?')}: {p.get('poeStatus', '?')} · {p.get('powerUsed', '?')}"
                )
    await _reply_chunks(update, "\n".join(lines))


async def unsupported_write(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await _guard(update):
        return
    await update.effective_message.reply_text(
        "This write operation is disabled because Ruijie does not list a supported endpoint for it in the current API manual. No change was sent to your network."
    )


def main() -> None:
    if not config.ALLOWED_USER_IDS:
        raise RuntimeError("ALLOWED_USER_IDS is empty; refusing to start an unprotected control bot")

    app = Application.builder().token(config.TELEGRAM_BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("help", start))
    app.add_handler(CommandHandler("login", login))
    app.add_handler(CommandHandler("logout", logout))
    app.add_handler(CommandHandler("projects", projects))
    app.add_handler(CommandHandler("allprojects", projects))
    app.add_handler(CommandHandler("useproject", useproject))
    app.add_handler(CommandHandler("devices", devices))
    app.add_handler(CommandHandler("alldevices", alldevices))
    app.add_handler(CommandHandler("clients", clients))
    app.add_handler(CommandHandler("allclients", allclients))
    app.add_handler(CommandHandler("device", device))
    app.add_handler(CommandHandler("status", device))
    app.add_handler(CommandHandler("traffic", traffic))
    app.add_handler(CommandHandler("performance", performance))
    app.add_handler(CommandHandler("ports", ports))
    app.add_handler(CommandHandler("poe", poe))

    for command in (
        "reboot",
        "adddevice",
        "rename",
        "setpass",
        "createproject",
        "moveproject",
        "movedevice",
    ):
        app.add_handler(CommandHandler(command, unsupported_write))

    log.info("Starting private Ruijie/Reyee Telegram bot")
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
