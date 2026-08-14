"""Webhook entry point for hosting the Ruijie Telegram bot as a web service.

Uses the same handlers as bot.py. The host supplies an HTTPS public URL through
WEBHOOK_URL or (on Render) RENDER_EXTERNAL_URL. Application.run_webhook() also
registers the Telegram webhook at startup.
"""

from __future__ import annotations

import os

from telegram import Update
from telegram.ext import Application, CommandHandler

import bot as handlers
import config


def build_application() -> Application:
    if not config.ALLOWED_USER_IDS:
        raise RuntimeError("ALLOWED_USER_IDS is empty; refusing to start an unprotected control bot")

    app = Application.builder().token(config.TELEGRAM_BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", handlers.start))
    app.add_handler(CommandHandler("help", handlers.start))
    app.add_handler(CommandHandler("login", handlers.login))
    app.add_handler(CommandHandler("logout", handlers.logout))
    app.add_handler(CommandHandler("projects", handlers.projects))
    app.add_handler(CommandHandler("allprojects", handlers.projects))
    app.add_handler(CommandHandler("useproject", handlers.useproject))
    app.add_handler(CommandHandler("devices", handlers.devices))
    app.add_handler(CommandHandler("alldevices", handlers.alldevices))
    app.add_handler(CommandHandler("clients", handlers.clients))
    app.add_handler(CommandHandler("allclients", handlers.allclients))
    app.add_handler(CommandHandler("device", handlers.device))
    app.add_handler(CommandHandler("status", handlers.device))
    app.add_handler(CommandHandler("traffic", handlers.traffic))
    app.add_handler(CommandHandler("performance", handlers.performance))
    app.add_handler(CommandHandler("ports", handlers.ports))
    app.add_handler(CommandHandler("poe", handlers.poe))

    for command in (
        "reboot",
        "adddevice",
        "rename",
        "setpass",
        "createproject",
        "moveproject",
        "movedevice",
    ):
        app.add_handler(CommandHandler(command, handlers.unsupported_write))
    return app


def main() -> None:
    external_url = (
        os.environ.get("WEBHOOK_URL", "").strip()
        or os.environ.get("RENDER_EXTERNAL_URL", "").strip()
    )
    if not external_url:
        raise RuntimeError("WEBHOOK_URL or RENDER_EXTERNAL_URL is required for webhook mode")

    path = os.environ.get("TELEGRAM_WEBHOOK_PATH", "telegram/webhook").strip("/")
    if not path:
        path = "telegram/webhook"
    secret_token = os.environ.get("TELEGRAM_WEBHOOK_SECRET", "").strip() or None
    port = int(os.environ.get("PORT", "10000"))
    webhook_url = f"{external_url.rstrip('/')}/{path}"

    app = build_application()
    app.run_webhook(
        listen="0.0.0.0",
        port=port,
        url_path=path,
        webhook_url=webhook_url,
        secret_token=secret_token,
        allowed_updates=Update.ALL_TYPES,
        drop_pending_updates=False,
    )


if __name__ == "__main__":
    main()
