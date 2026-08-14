import os

from dotenv import load_dotenv

load_dotenv()

TELEGRAM_BOT_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]

# Comma-separated Telegram numeric user IDs allowed to use the bot.
# Get your own ID by messaging @userinfobot on Telegram.
ALLOWED_USER_IDS = {
    int(uid.strip())
    for uid in os.environ.get("ALLOWED_USER_IDS", "").split(",")
    if uid.strip()
}

# https://cloud-as.ruijienetworks.com for Asia accounts (matches your
# screenshot's dashboard URL), https://cloud-us.ruijienetworks.com for US.
RUIJIE_BASE_URL = os.environ.get("RUIJIE_BASE_URL", "https://cloud-as.ruijienetworks.com")
