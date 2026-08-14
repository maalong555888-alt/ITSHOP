"""
Telegram <-> Ruijie/Reyee Cloud bridge bot.

Account-wide commands:
  /projects                       list the full project/group tree
  /allprojects                    alias for /projects
  /useproject <group_id>          select a default project/group
  /devices [group_id]             devices in one project (or selected project)
  /alldevices                     devices across every project/group
  /clients [group_id]             connected clients in one project
  /allclients                     connected clients across every project/group
  /traffic <serial>               traffic stats for one device
  /reboot <serial>                reboot a device (asks for confirmation)
  /adddevice <group_id> <serial> [mac]
                                  add/register equipment to any project/group
  /rename <group_id> <mac> <name> rename a connected client
  /setpass <group_id> <mac> <pw>  change a client's portal password
  /login <appid> <secret>         sign in (private chat only; message deleted)
  /logout                         wipe stored credentials

Project creation/move commands are intentionally NOT guessed. They will be
added only after Ruijie confirms the official V2.0.3 endpoint + request schema.

Only Telegram user IDs listed in ALLOWED_USER_IDS can use this bot.
"""

from __future__ import annotations

import logging
from typing import Any

from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    Application,
    CommandHandler,
    CallbackQueryHandler,
    ContextTypes,
)

import config
from ruijie_client import RuijieSession, RuijieAPIError, RuijieAuthError

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("ruijie-bot")

SESSIONS: dict[int, RuijieSession] = {}
ACTIVE_GROUPS: dict[int, int] = {}


def _authorized(update: Update) -> bool:
    uid = update.effective_user.id if update.effective_user else None
    return uid in config.ALLOWED_USER_IDS


async def _guard(update: Update) -> bool:
    if not _authorized(update):
        if update.message:
            await update.message.reply_text("Not authorized. This bot is private.")
        log.warning("Unauthorized access attempt from user_id=%s", getattr(update.effective_user, "id", None))
        return False
    return True


def _session(update: Update) -> RuijieSession | None:
    if not update.effective_user:
        return None
    return SESSIONS.get(update.effective_user.id)


async def _reply_chunks(update: Update, text: str) -> None:
    """Telegram messages have a size limit; split large account-wide results."""
    if not update.message:
        return
    text = text or "(empty)"
    while len(text) > 3900:
        cut = text.rfind("\n", 0, 3900)
        if cut < 1000:
            cut = 3900
        await update.message.reply_text(text[:cut])
        text = text[cut:].lstrip("\n")
    await update.message.reply_text(text)


def _walk_groups(node: Any, indent: int = 0):
    """Yield (group_id, name, indent) for every group/project recursively."""
    if not node:
        return
    if isinstance(node, list):
        for item in node:
            yield from _walk_groups(item, indent)
        return
    if not isinstance(node, dict):
        return

    gid = node.get("groupId")
    name = node.get("name") or node.get("groupName") or "Unnamed"
    if gid is not None:
        yield int(gid), str(name), indent

    for child in node.get("subGroups", []) or []:
        yield from _walk_groups(child, indent + 1)


def _group_rows(data: dict) -> list[tuple[int, str, int]]:
    root = data.get("groups")
    return list(_walk_groups(root))


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await _guard(update):
        return
    has_session = _session(update) is not None
    status = "logged in ✅" if has_session else "not logged in — use /login <appid> <secret>"
    selected = ACTIVE_GROUPS.get(update.effective_user.id) if update.effective_user else None
    selected_text = f"\nSelected project/group: {selected}" if selected else ""
    await update.message.reply_text(
        "Ruijie / Reyee Cloud control bot\n"
        f"Status: {status}{selected_text}\n\n"
        "Account-wide: /projects /alldevices /allclients\n"
        "Project: /useproject /devices /clients\n"
        "Device: /traffic /reboot /adddevice\n"
        "Client: /rename /setpass\n"
        "Session: /login /logout"
    )


async def login(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await _guard(update):
        return
    if update.effective_chat and update.effective_chat.type != "private":
        await update.message.reply_text("For safety, /login is allowed only in a private chat with this bot.")
        return
    try:
        await update.message.delete()
    except Exception:
        pass
    if len(context.args) != 2:
        await context.bot.send_message(
            update.effective_chat.id,
            "Usage: /login <appid> <secret>\n(your login message is deleted for safety)",
        )
        return
    appid, secret = context.args
    session = RuijieSession(appid=appid, secret=secret, base_url=config.RUIJIE_BASE_URL)
    try:
        session.authenticate()
    except RuijieAuthError as e:
        await context.bot.send_message(update.effective_chat.id, f"Login failed: {e}")
        return
    except Exception as e:
        log.exception("Unexpected Ruijie login error")
        await context.bot.send_message(update.effective_chat.id, f"Login error: {e}")
        return
    SESSIONS[update.effective_user.id] = session
    await context.bot.send_message(update.effective_chat.id, "Logged in to Ruijie/Reyee Cloud ✅")


async def logout(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await _guard(update):
        return
    uid = update.effective_user.id
    old = SESSIONS.pop(uid, None)
    ACTIVE_GROUPS.pop(uid, None)
    if old:
        try:
            old.close()
        except Exception:
            pass
    await update.message.reply_text("Credentials and selected project cleared.")


async def _require_session(update: Update) -> RuijieSession | None:
    session = _session(update)
    if not session:
        await update.message.reply_text("You are not signed in. Use /login <appid> <secret> in a private chat.")
    return session


async def _load_groups(update: Update, session: RuijieSession) -> list[tuple[int, str, int]] | None:
    try:
        data = session.get_groups(depth="DEVICE")
        return _group_rows(data)
    except (RuijieAPIError, RuijieAuthError) as e:
        await update.message.reply_text(f"API error: {e}")
        return None
    except Exception as e:
        log.exception("Failed loading Ruijie project tree")
        await update.message.reply_text(f"Cloud error: {e}")
        return None


async def projects(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await _guard(update):
        return
    session = await _require_session(update)
    if not session:
        return
    rows = await _load_groups(update, session)
    if rows is None:
        return
    if not rows:
        await update.message.reply_text("No projects/groups found in this Cloud account.")
        return
    lines = ["All Ruijie/Reyee projects & groups:"]
    for gid, name, indent in rows:
        lines.append(f"{'  ' * indent}• {name} — id: {gid}")
    await _reply_chunks(update, "\n".join(lines))


async def useproject(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await _guard(update):
        return
    session = await _require_session(update)
    if not session:
        return
    if len(context.args) != 1:
        await update.message.reply_text("Usage: /useproject <group_id>  (see /projects)")
        return
    try:
        target = int(context.args[0])
    except ValueError:
        await update.message.reply_text("group_id must be a number.")
        return
    rows = await _load_groups(update, session)
    if rows is None:
        return
    match = next(((gid, name) for gid, name, _ in rows if gid == target), None)
    if not match:
        await update.message.reply_text("That project/group ID is not in your Cloud account.")
        return
    ACTIVE_GROUPS[update.effective_user.id] = target
    await update.message.reply_text(f"Selected project/group: {match[1]} (id {target}) ✅")


def _resolve_group(update: Update, args: list[str]) -> int | None:
    if args:
        try:
            return int(args[0])
        except ValueError:
            return None
    if update.effective_user:
        return ACTIVE_GROUPS.get(update.effective_user.id)
    return None


async def devices(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await _guard(update):
        return
    session = await _require_session(update)
    if not session:
        return
    group_id = _resolve_group(update, context.args)
    if group_id is None:
        await update.message.reply_text("Usage: /devices <group_id> or first /useproject <group_id>")
        return
    try:
        devs = session.get_devices(group_id)
    except (RuijieAPIError, RuijieAuthError) as e:
        await update.message.reply_text(f"API error: {e}")
        return
    if not devs:
        await update.message.reply_text(f"No devices found in project/group {group_id}.")
        return
    lines = [f"Devices in project/group {group_id}:"]
    for d in devs:
        online = d.get("online") if d.get("online") is not None else d.get("isOnline")
        status = "🟢 online" if online else "🔴 offline"
        sn = d.get("sn") or d.get("serialNumber") or "?"
        name = d.get("name") or d.get("deviceName") or sn
        ptype = d.get("productType") or d.get("type") or "?"
        lines.append(f"• {name} [{ptype}] SN:{sn} {status}")
    await _reply_chunks(update, "\n".join(lines))


async def alldevices(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await _guard(update):
        return
    session = await _require_session(update)
    if not session:
        return
    rows = await _load_groups(update, session)
    if rows is None:
        return
    lines = ["All Ruijie/Reyee equipment across all projects:"]
    total = 0
    errors = 0
    for gid, name, _ in rows:
        try:
            devs = session.get_devices(gid)
        except Exception as e:
            errors += 1
            lines.append(f"\n{name} (id {gid}) — unable to read: {e}")
            continue
        if not devs:
            continue
        lines.append(f"\n{name} (id {gid})")
        for d in devs:
            total += 1
            online = d.get("online") if d.get("online") is not None else d.get("isOnline")
            status = "🟢" if online else "🔴"
            sn = d.get("sn") or d.get("serialNumber") or "?"
            dname = d.get("name") or d.get("deviceName") or sn
            ptype = d.get("productType") or d.get("type") or "?"
            lines.append(f"  {status} {dname} [{ptype}] SN:{sn}")
    lines.append(f"\nTotal equipment found: {total}")
    if errors:
        lines.append(f"Projects/groups with read errors: {errors}")
    await _reply_chunks(update, "\n".join(lines))


async def clients(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await _guard(update):
        return
    session = await _require_session(update)
    if not session:
        return
    group_id = _resolve_group(update, context.args)
    if group_id is None:
        await update.message.reply_text("Usage: /clients <group_id> or first /useproject <group_id>")
        return
    try:
        cls = session.get_clients(group_id)
    except (RuijieAPIError, RuijieAuthError) as e:
        await update.message.reply_text(f"API error: {e}")
        return
    if not cls:
        await update.message.reply_text("No connected clients.")
        return
    lines = [f"Connected clients in project/group {group_id}:"]
    for c in cls:
        label = c.get("userName") or c.get("hostname") or "unknown"
        lines.append(f"• {label} — {c.get('mac', '')} — {c.get('ip', '')}")
    await _reply_chunks(update, "\n".join(lines))


async def allclients(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await _guard(update):
        return
    session = await _require_session(update)
    if not session:
        return
    rows = await _load_groups(update, session)
    if rows is None:
        return
    lines = ["All connected clients across all projects:"]
    total = 0
    errors = 0
    for gid, name, _ in rows:
        try:
            cls = session.get_clients(gid)
        except Exception as e:
            errors += 1
            lines.append(f"\n{name} (id {gid}) — unable to read: {e}")
            continue
        if not cls:
            continue
        lines.append(f"\n{name} (id {gid})")
        for c in cls:
            total += 1
            label = c.get("userName") or c.get("hostname") or "unknown"
            lines.append(f"  • {label} — {c.get('mac', '')} — {c.get('ip', '')}")
    lines.append(f"\nTotal connected clients found: {total}")
    if errors:
        lines.append(f"Projects/groups with read errors: {errors}")
    await _reply_chunks(update, "\n".join(lines))


async def traffic(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await _guard(update):
        return
    session = await _require_session(update)
    if not session:
        return
    if not context.args:
        await update.message.reply_text("Usage: /traffic <device_serial>")
        return
    serial = context.args[0]
    try:
        data = session.get_device_traffic(serial)
    except (RuijieAPIError, RuijieAuthError) as e:
        await update.message.reply_text(f"API error: {e}")
        return
    await _reply_chunks(update, f"Traffic for {serial}:\n{data}")


async def reboot(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await _guard(update):
        return
    if not context.args:
        await update.message.reply_text("Usage: /reboot <device_serial>")
        return
    serial = context.args[0]
    keyboard = InlineKeyboardMarkup(
        [[
            InlineKeyboardButton("✅ Confirm reboot", callback_data=f"reboot:{serial}"),
            InlineKeyboardButton("❌ Cancel", callback_data="cancel"),
        ]]
    )
    await update.message.reply_text(f"Reboot Ruijie/Reyee device {serial}?", reply_markup=keyboard)


async def on_button(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    if not _authorized(update):
        await query.edit_message_text("Not authorized.")
        return
    if query.data == "cancel":
        await query.edit_message_text("Cancelled.")
        return
    if query.data.startswith("reboot:"):
        serial = query.data.split(":", 1)[1]
        session = SESSIONS.get(update.effective_user.id)
        if not session:
            await query.edit_message_text("Not logged in.")
            return
        try:
            session.reboot_device(serial)
            await query.edit_message_text(f"Reboot command sent to {serial} ✅")
        except (RuijieAPIError, RuijieAuthError) as e:
            await query.edit_message_text(f"API error: {e}")


async def adddevice(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await _guard(update):
        return
    session = await _require_session(update)
    if not session:
        return
    if len(context.args) < 2:
        await update.message.reply_text("Usage: /adddevice <group_id> <serial> [mac]")
        return
    try:
        group_id = int(context.args[0])
    except ValueError:
        await update.message.reply_text("group_id must be a number.")
        return
    serial = context.args[1]
    mac = context.args[2] if len(context.args) > 2 else None

    # Validate target belongs to this account before a write operation.
    rows = await _load_groups(update, session)
    if rows is None:
        return
    if group_id not in {gid for gid, _, _ in rows}:
        await update.message.reply_text("That target project/group ID is not in your Cloud account.")
        return

    try:
        session.add_device(group_id, serial, mac)
        await update.message.reply_text(f"Equipment {serial} added to project/group {group_id} ✅")
    except (RuijieAPIError, RuijieAuthError) as e:
        await update.message.reply_text(f"API error: {e}")


async def rename(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await _guard(update):
        return
    session = await _require_session(update)
    if not session:
        return
    if len(context.args) < 3:
        await update.message.reply_text("Usage: /rename <group_id> <mac> <new_name>")
        return
    try:
        group_id = int(context.args[0])
    except ValueError:
        await update.message.reply_text("group_id must be a number.")
        return
    mac = context.args[1]
    new_name = " ".join(context.args[2:])
    try:
        session.rename_client(group_id, mac, new_name)
        await update.message.reply_text(f"Renamed {mac} to '{new_name}' ✅")
    except (RuijieAPIError, RuijieAuthError) as e:
        await update.message.reply_text(f"API error: {e}")


async def setpass(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await _guard(update):
        return
    session = await _require_session(update)
    if not session:
        return
    try:
        await update.message.delete()
    except Exception:
        pass
    if len(context.args) < 3:
        await context.bot.send_message(update.effective_chat.id, "Usage: /setpass <group_id> <mac> <new_password>")
        return
    try:
        group_id = int(context.args[0])
    except ValueError:
        await context.bot.send_message(update.effective_chat.id, "group_id must be a number.")
        return
    mac = context.args[1]
    new_password = context.args[2]
    try:
        session.set_client_password(group_id, mac, new_password)
        await context.bot.send_message(update.effective_chat.id, f"Password updated for {mac} ✅")
    except (RuijieAPIError, RuijieAuthError) as e:
        await context.bot.send_message(update.effective_chat.id, f"API error: {e}")


async def newproject_pending(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await _guard(update):
        return
    await update.message.reply_text(
        "New-project creation is not enabled yet. Ruijie support has been asked for the official "
        "V2.0.3 create Project/Project Group/Sub-project endpoint and request schema. It will be "
        "enabled after that is confirmed so the bot never guesses a write API on your network."
    )


def main():
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

    app.add_handler(CommandHandler("traffic", traffic))
    app.add_handler(CommandHandler("reboot", reboot))
    app.add_handler(CommandHandler("adddevice", adddevice))
    app.add_handler(CommandHandler("rename", rename))
    app.add_handler(CommandHandler("setpass", setpass))

    # Kept as a visible placeholder until the documented Ruijie write endpoint is confirmed.
    app.add_handler(CommandHandler("newproject", newproject_pending))
    app.add_handler(CommandHandler("newgroup", newproject_pending))

    app.add_handler(CallbackQueryHandler(on_button))
    log.info("Ruijie/Reyee account-wide bot starting...")
    app.run_polling()


if __name__ == "__main__":
    main()
