# Ruijie / Reyee Cloud Telegram Bot

Private Telegram control/monitoring for a Ruijie/Reyee Cloud account using the documented Ruijie Cloud API.

## Supported commands

- `/start` / `/help` — status and command help
- `/login <appid> <secret>` — authenticate in a private Telegram chat
- `/logout` — clear the temporary API session
- `/projects` / `/allprojects` — list the project/group tree
- `/useproject <group_id>` — select a default project
- `/devices [group_id]` — list APs, switches and gateways in a project
- `/alldevices` — scan devices across projects, with caching to reduce API use
- `/clients [group_id]` — current connected clients in a project
- `/allclients` — current clients across projects, with caching
- `/device <serial>` / `/status <serial>` — device details/status
- `/traffic <serial>` — last 24-hour traffic/flow summary
- `/performance <serial>` — CPU, memory and flash utilization when the device/API supports it
- `/ports <serial>` — gateway/switch port information
- `/poe <serial>` — switch PoE information when supported

## Unsupported write commands

Ruijie Support confirmed that operations absent from the current official API manual are not supported by the public API. Therefore the bot intentionally blocks guessed write operations such as `/reboot`, `/adddevice`, `/rename`, `/setpass`, `/createproject`, `/moveproject`, and `/movedevice`. The bot sends no network change when one of these commands is used.

## Private environment variables

Required:

- `TELEGRAM_BOT_TOKEN` — BotFather token
- `ALLOWED_USER_IDS` — comma-separated numeric Telegram IDs allowed to use the bot
- `RUIJIE_BASE_URL` — defaults to `https://cloud-as.ruijienetworks.com`

Optional but recommended for always-on hosting:

- `RUIJIE_APP_ID`
- `RUIJIE_APP_SECRET`

If App ID and Secret are stored in the hosting provider's private secret store, the bot can authenticate again after a process restart. Do not put real credentials in source files or commit a real `.env` file.

## Ruijie API behavior

The implementation uses documented App ID/Secret OAuth authentication, token refresh, project/group tree access, project-scoped AP/Switch/Gateway device listing with paging, current-client records, device details, 24-hour flow, performance, ports and PoE endpoints. API errors and unexpected HTML responses are converted into short Telegram error messages instead of dumping an HTML page into chat.

Because Ruijie API access has a daily request limit, `/alldevices` and `/allclients` cache results. Avoid repeatedly forcing account-wide scans when the account contains many projects.

## Run

```bash
pip install -r requirements.txt
python bot.py
```

The included Dockerfile and Procfile can be used on a container/worker hosting provider.

## Security

The process refuses to start if `ALLOWED_USER_IDS` is empty. `/login` is restricted to a private Telegram chat and the command message is deleted after its arguments are read. No Ruijie App ID, Secret, Telegram token or user password should ever be committed to GitHub.
