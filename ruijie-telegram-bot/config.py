import os
from dotenv import load_dotenv

load_dotenv()

TELEGRAM_BOT_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
ALLOWED_USER_IDS = {
    int(uid.strip())
    for uid in os.environ.get("ALLOWED_USER_IDS", "").split(",")
    if uid.strip()
}
RUIJIE_BASE_URL = os.environ.get(
    "RUIJIE_BASE_URL", "https://cloud-as.ruijienetworks.com"
).rstrip("/")

# Optional server-side Ruijie credentials. Keep these only in your hosting
# provider's secret/environment settings, never in GitHub source code.
RUIJIE_APP_ID = os.environ.get("RUIJIE_APP_ID", "").strip()
RUIJIE_APP_SECRET = os.environ.get("RUIJIE_APP_SECRET", "").strip()
