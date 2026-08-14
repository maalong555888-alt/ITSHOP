"""
Telegram <-> Ruijie Cloud bridge bot.

Commands:
  /start                          intro + auth status
  /login <appid> <secret>         store Ruijie Cloud app credentials (DM only)
  /projects                       list your projects/sites (group IDs)
  /devices <group_id>             list infra devices (AP/switch/gateway) in a project
  /clients <group_id>             list connected clients in a project
  /traffic <serial>               traffic stats for one device
  /reboot <serial>                reboot a device (asks for confirmation)
  /adddevice <group_id> <serial>  register a new device to a project
  /rename <group_id> <mac> <name> rename a connected client
  /setpass <group_id> <mac> <pw>  change a client's portal password
  /logout                         wipe stored credentials

Only Telegram user IDs listed in ALLOWED_USER_IDS (config.py / .env) can use
this bot at all — this bot has full control of your network, treat it like
an admin credential.
"""

from __future__ import annotations

import logging

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


def _authorized(update: Update) -> bool:
    uid = update.effective_user.id if update.effective_user else None
    return uid in config.ALLOWED_USER_IDS


async def _guard(update: Update) -> bool:
    if not _authorized(update):
        await update.message.reply_text("Not authorized. This bot is private.")
        log.warning("Unauthorized access attempt from user_id=%s", update.effective_user.id)
        return False
    return True


def _session(update: Update) -> RuijieSession | None:
    return SESSIONS.get(update.effective_user.id)


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await _guard(update):
        return
    has_session = _session(update) is not None
    status = "logged in ✅" if has_session else "not logged in — use /login <appid> <secret>"
    await update.message.reply_text(
        "Ruijie Cloud control bot.\n"
        f"Status: {status}\n\n"
        "Commands: /projects /devices /clients /traffic /reboot "
        "/adddevice /rename /setpass /logout"
    )


async def login(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await _guard(update):
        return
    try:
        await update.message.delete()
    except Exception:
        pass
    if len(context.args) != 2:
        await context.bot.send_message(
            update.effective_chat.id,
            "Usage: /login <appid> <secret>\n(your message was deleted for safety)",
        )
        return
    appid, secret = context.args
    session = RuijieSession(appid=appid, secret=secret, base_url=config.RUIJIE_BASE_URL)
    try:
        session.authenticate()
    except RuijieAuthError as e:
        await context.bot.send_message(update.effective_chat.id, f"Login failed: {e}")
        return
    SESSIONS[update.effective_user.id] = session
    await context.bot.send_message(update.effective_chat.id, "Logged in to Ruijie Cloud ✅")


async def logout(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await _guard(update):
        return
    SESSIONS.pop(update.effective_user.id, None)
    await update.message.reply_text("Credentials cleared.")


async def _require_session(update: Update) -> RuijieSession | None:
    session = _session(update)
    if not session:
        await update.message.reply_text("Not logged in. Use /login <appid> <secret> first.")
    return session


async def projects(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await _guard(update):
        return
    session = await _require_session(update)
    if not session:
        return
    try:
        data = session.get_groups(depth="BUILDING")
    except RuijieAPIError as e:
        await update.message.reply_text(f"API error: {e}")
        return

    lines = []

    def walk(node, indent=0):
        if not node:
            return
        lines.append(f"{'  ' * indent}{node.get('name')} — id: {node.get('groupId')}")
        for child in node.get("subGroups", []) or []:
            walk(child, indent + 1)

    walk(data.get("groups"))
    await update.message.reply_text("\n".join(lines) or "No projects found.")


async def devices(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await _guard(update):
        return
    session = await _require_session(update)
    if not session:
        return
    if not context.args:
        await update.message.reply_text("Usage: /devices <group_id>  (see /projects)")
        return
    try:
        group_id = int(context.args[0])
        devs = session.get_devices(group_id)
    except RuijieAPIError as e:
        await update.message.reply_text(f"API error: {e}")
        return
    if not devs:
        await update.message.reply_text("No devices found in that project.")
        return
    lines = []
    for d in devs:
        status = "🟢 online" if d.get("online") or d.get("isOnline") else "🔴 offline"
        lines.append(
            f"{d.get('name', d.get('sn'))} [{d.get('productType', '?')}] "
            f"SN:{d.get('sn', d.get('serialNumber'))} {status}"
        )
    await update.message.reply_text("\n".join(lines))


async def clients(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await _guard(update):
        return
    session = await _require_session(update)
    if not session:
        return
    if not context.args:
        await update.message.reply_text("Usage: /clients <group_id>")
        return
    try:
        group_id = int(context.args[0])
        cls = session.get_clients(group_id)
    except RuijieAPIError as e:
        await update.message.reply_text(f"API error: {e}")
        return
    if not cls:
        await update.message.reply_text("No connected clients.")
        return
    lines = [
        f"{c.get('userName', c.get('hostname', 'unknown'))} — {c.get('mac')} "
        f"— {c.get('ip', '')}"
        for c in cls
    ]
    await update.message.reply_text("\n".join(lines))


async def traffic(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await _guard(update):
        return
    session = await _require_session(update)
    if not session:
        return
    if not context.args:
        await update.message.reply_text("Usage: /traffic <device_serial>")
        return
    try:
        data = session.get_device_traffic(context.args[0])
    except RuijieAPIError as e:
        await update.message.reply_text(f"API error: {e}")
        return
    await update.message.reply_text(f"Traffic for {context.args[0]}:\n{data}")


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
    await update.message.reply_text(f"Reboot device {serial}?", reply_markup=keyboard)


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
        except RuijieAPIError as e:
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
    group_id = int(context.args[0])
    serial = context.args[1]
    mac = context.args[2] if len(context.args) > 2 else None
    try:
        session.add_device(group_id, serial, mac)
        await update.message.reply_text(f"Device {serial} added to project {group_id} ✅")
    except RuijieAPIError as e:
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
    group_id = int(context.args[0])
    mac = context.args[1]
    new_name = " ".join(context.args[2:])
    try:
        session.rename_client(group_id, mac, new_name)
        await update.message.reply_text(f"Renamed {mac} to '{new_name}' ✅")
    except RuijieAPIError as e:
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
        await context.bot.send_message(
            update.effective_chat.id, "Usage: /setpass <group_id> <mac> <new_password>"
        )
        return
    group_id = int(context.args[0])
    mac = context.args[1]
    new_password = context.args[2]
    try:
        session.set_client_password(group_id, mac, new_password)
        await context.bot.send_message(update.effective_chat.id, f"Password updated for {mac} ✅")
    except RuijieAPIError as e:
        await context.bot.send_message(update.effective_chat.id, f"API error: {e}")


def main():
    app = Application.builder().token(config.TELEGRAM_BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("help", start))
    app.add_handler(CommandHandler("login", login))
    app.add_handler(CommandHandler("logout", logout))
    app.add_handler(CommandHandler("projects", projects))
    app.add_handler(CommandHandler("devices", devices))
    app.add_handler(CommandHandler("clients", clients))
    app.add_handler(CommandHandler("traffic", traffic))
    app.add_handler(CommandHandler("reboot", reboot))
    app.add_handler(CommandHandler("adddevice", adddevice))
    app.add_handler(CommandHandler("rename", rename))
    app.add_handler(CommandHandler("setpass", setpass))
    app.add_handler(CallbackQueryHandler(on_button))
    log.info("Bot starting...")
    app.run_polling()


if __name__ == "__main__":
    main()
