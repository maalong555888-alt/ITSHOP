"""
Ruijie Cloud REST API client.

Confirmed against Ruijie's official "Ruijie Cloud API Document" (auth +
group listing) and the open-source `pyruijie` library (device/client
listing). Endpoints marked VERIFY are best-guess based on Ruijie's REST
conventions but are NOT confirmed from public docs — see README for how
to confirm them from your own account in 2 minutes using browser DevTools.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

import httpx

_ACCESS_TOKEN_MAGIC = "d63dss0a81e4415a889ac5b78fsc904a"


class RuijieAPIError(Exception):
    def __init__(self, code: int, message: str):
        self.code = code
        self.message = message
        super().__init__(f"Ruijie API error {code}: {message}")


class RuijieAuthError(Exception):
    pass


@dataclass
class RuijieSession:
    appid: str
    secret: str
    base_url: str = "https://cloud-as.ruijienetworks.com"

    _access_token: str | None = field(default=None, init=False)
    _expires_at: float = field(default=0.0, init=False)

    def __post_init__(self):
        self._client = httpx.Client(base_url=self.base_url, timeout=30)

    def authenticate(self) -> str:
        resp = self._client.post(
            "/service/api/oauth20/client/access_token",
            params={"token": _ACCESS_TOKEN_MAGIC},
            json={"appid": self.appid, "secret": self.secret},
        )
        data = resp.json()
        if data.get("code") != 0:
            raise RuijieAuthError(data.get("msg", "authentication failed"))
        self._access_token = data["accessToken"]
        self._expires_at = time.time() + 50 * 60
        return self._access_token

    def _ensure_token(self) -> str:
        if not self._access_token or time.time() >= self._expires_at:
            self.authenticate()
        return self._access_token

    def _get(self, path: str, params: dict[str, Any] | None = None) -> dict:
        params = dict(params or {})
        params["access_token"] = self._ensure_token()
        resp = self._client.get(path, params=params)
        return self._unwrap(resp)

    def _post(self, path: str, params: dict[str, Any] | None = None,
              json_body: dict[str, Any] | None = None) -> dict:
        params = dict(params or {})
        params["access_token"] = self._ensure_token()
        resp = self._client.post(path, params=params, json=json_body or {})
        return self._unwrap(resp)

    @staticmethod
    def _unwrap(resp: httpx.Response) -> dict:
        resp.raise_for_status()
        data = resp.json()
        if data.get("code") not in (0, None):
            raise RuijieAPIError(data.get("code"), data.get("msg", "unknown error"))
        return data

    def get_groups(self, depth: str = "DEVICE") -> dict:
        return self._get("/service/api/group/single/tree", {"depth": depth})

    def get_devices(self, group_id: int) -> list[dict]:
        data = self._get("/service/api/device/list", {"groupId": group_id})
        return data.get("devices", data.get("list", []))

    def get_clients(self, group_id: int) -> list[dict]:
        data = self._get("/service/api/client/list", {"groupId": group_id})
        return data.get("clients", data.get("list", []))

    def get_device_traffic(self, serial_number: str) -> dict:
        return self._get("/service/api/device/traffic", {"sn": serial_number})

    def reboot_device(self, serial_number: str) -> dict:
        return self._post("/service/api/device/reboot", json_body={"sn": serial_number})

    def add_device(self, group_id: int, serial_number: str, mac: str | None = None) -> dict:
        body = {"groupId": group_id, "sn": serial_number}
        if mac:
            body["mac"] = mac
        return self._post("/service/api/device/add", json_body=body)

    def rename_client(self, group_id: int, mac: str, new_name: str) -> dict:
        return self._post(
            "/service/api/client/rename",
            json_body={"groupId": group_id, "mac": mac, "userName": new_name},
        )

    def set_client_password(self, group_id: int, mac: str, new_password: str) -> dict:
        return self._post(
            "/service/api/client/password",
            json_body={"groupId": group_id, "mac": mac, "password": new_password},
        )

    def close(self):
        self._client.close()
