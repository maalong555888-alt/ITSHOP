# Ruijie Cloud Telegram Bot

A private Telegram bot for controlling a Ruijie/Reyee Cloud account.

## Commands

- `/start` — bot status and help
- `/login <appid> <secret>` — authenticate to Ruijie Cloud
- `/projects` — list projects/sites
- `/devices <group_id>` — list APs, switches and gateways
- `/clients <group_id>` — list connected clients
- `/traffic <serial>` — device traffic information
- `/reboot <serial>` — reboot with confirmation
- `/adddevice <group_id> <serial> [mac]` — add a device
- `/rename <group_id> <mac> <name>` — rename a client
- `/setpass <group_id> <mac> <password>` — change a client portal password
- `/logout` — clear the in-memory Ruijie session

## Required private environment variables

`TELEGRAM_BOT_TOKEN` must contain the BotFather token. `ALLOWED_USER_IDS` must contain the Telegram numeric user ID(s) allowed to control the bot. `RUIJIE_BASE_URL` defaults to the Ruijie Asia cloud endpoint.

Never commit a real `.env` file. The included `.gitignore` blocks it.

## Run

Install `requirements.txt`, set the environment variables, then run `python bot.py`. The included Dockerfile and Procfile are provided for worker/container hosting.

## Ruijie API note

The authentication, project listing, device listing and client listing flows are the parts intended to match known Ruijie Cloud API behavior. Some write/traffic endpoints in `ruijie_client.py` still require verification against the exact API endpoints enabled for your Ruijie Cloud account before they should be relied upon for production network administration.

## Security

This bot can perform administrative network operations. Keep the Telegram token, Ruijie AppID/Secret and allowed Telegram user IDs in private host environment variables. `/login` and `/setpass` attempt to delete the Telegram command message after reading it, and Ruijie credentials are stored only in process memory.
