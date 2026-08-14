"""
Ruijie Cloud REST API client.

Read-only endpoints in this file are based on Ruijie Cloud API documentation
and Ruijie support guidance. Write endpoints that still need confirmation are
kept separate and should not be used until validated against the user's Cloud
account/API version.
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
        self.base_url = self.base_url.rstrip("/")
        self._client = httpx.Client(base_url=self.base_url, timeout=30)

    def _candidate_cloud_urls(self) -> list[str]:
        """Try the configured Cloud first, then the other known Ruijie Cloud host.

        This is only used when the configured host returns HTTP 404 for the
        documented OAuth endpoint. It does not retry invalid credentials.
        """
        urls = [self.base_url]
        asia = "https://cloud-as.ruijienetworks.com"
        global_cloud = "https://cloud.ruijienetworks.com"
        if self.base_url == asia:
            urls.append(global_cloud)
        elif self.base_url == global_cloud:
            urls.append(asia)
        return urls

    def _switch_cloud(self, base_url: str) -> None:
        base_url = base_url.rstrip("/")
        if base_url == self.base_url:
            return
        try:
            self._client.close()
        except Exception:
            pass
        self.base_url = base_url
        self._client = httpx.Client(base_url=self.base_url, timeout=30)

    def authenticate(self) -> str:
        last_404: str | None = None

        for cloud_url in self._candidate_cloud_urls():
            if cloud_url != self.base_url:
                self._switch_cloud(cloud_url)

            try:
                resp = self._client.post(
                    "/service/api/oauth20/client/access_token",
                    params={"token": _ACCESS_TOKEN_MAGIC},
                    json={"appid": self.appid, "secret": self.secret},
                )
            except httpx.HTTPError as exc:
                raise RuijieAuthError(f"Cloud connection failed: {exc}") from exc

            if resp.status_code == 404:
                last_404 = self.base_url
                continue

            try:
                data = resp.json()
            except ValueError as exc:
                raise RuijieAuthError(
                    f"Cloud returned HTTP {resp.status_code} with a non-JSON response"
                ) from exc

            if resp.status_code >= 400:
                raise RuijieAuthError(
                    data.get("msg") or f"Cloud returned HTTP {resp.status_code}"
                )

            if data.get("code") != 0:
                raise RuijieAuthError(data.get("msg", "authentication failed"))

            token = data.get("accessToken")
            if not token:
                raise RuijieAuthError("authentication succeeded but no access token was returned")

            self._access_token = token
            # Ruijie documentation describes a one-hour token. Refresh a little
            # early so normal Telegram commands do not race token expiry.
            self._expires_at = time.time() + 50 * 60
            return self._access_token

        if last_404:
            raise RuijieAuthError(
                "Ruijie OAuth endpoint returned HTTP 404 on the known Cloud hosts. "
                "The API region/endpoint must be confirmed by Ruijie support."
            )
        raise RuijieAuthError("authentication failed")

    def _ensure_token(self) -> str:
        if not self._access_token or time.time() >= self._expires_at:
            self.authenticate()
        return self._access_token

    def _get(self, path: str, params: dict[str, Any] | None = None) -> dict:
        params = dict(params or {})
        params["access_token"] = self._ensure_token()
        resp = self._client.get(path, params=params)
        return self._unwrap(resp)

    def _post(
        self,
        path: str,
        params: dict[str, Any] | None = None,
        json_body: dict[str, Any] | None = None,
    ) -> dict:
        params = dict(params or {})
        params["access_token"] = self._ensure_token()
        resp = self._client.post(path, params=params, json=json_body or {})
        return self._unwrap(resp)

    @staticmethod
    def _unwrap(resp: httpx.Response) -> dict:
        if resp.status_code == 404:
            raise RuijieAPIError(404, f"API endpoint not found: {resp.request.url.path}")
        try:
            resp.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise RuijieAPIError(resp.status_code, f"HTTP {resp.status_code}") from exc

        try:
            data = resp.json()
        except ValueError as exc:
            raise RuijieAPIError(resp.status_code, "Cloud returned a non-JSON response") from exc

        if data.get("code") not in (0, None):
            raise RuijieAPIError(data.get("code"), data.get("msg", "unknown error"))
        return data

    @staticmethod
    def _extract_list(data: dict, keys: tuple[str, ...]) -> list[dict]:
        for key in keys:
            value = data.get(key)
            if isinstance(value, list):
                return [item for item in value if isinstance(item, dict)]
            if isinstance(value, dict):
                for nested_key in ("list", "items", "records", "devices", "clients"):
                    nested = value.get(nested_key)
                    if isinstance(nested, list):
                        return [item for item in nested if isinstance(item, dict)]
        return []

    def get_groups(self, depth: str = "DEVICE") -> dict:
        return self._get("/service/api/group/single/tree", {"depth": depth})

    def get_all_devices(self) -> list[dict]:
        """Return equipment visible to the API account across Cloud projects.

        Ruijie support publishes /service/api/maint/devices as the device-list
        API. The response shape has changed across Cloud/API versions, so the
        parser accepts the common list wrappers without changing the payload.
        """
        data = self._get("/service/api/maint/devices")
        return self._extract_list(data, ("devices", "list", "items", "records", "data"))

    @staticmethod
    def _device_group_id(device: dict) -> int | None:
        for key in ("groupId", "group_id", "networkGroupId", "networkId"):
            value = device.get(key)
            if value is not None:
                try:
                    return int(value)
                except (TypeError, ValueError):
                    pass
        group = device.get("group")
        if isinstance(group, dict):
            for key in ("groupId", "id"):
                value = group.get(key)
                if value is not None:
                    try:
                        return int(value)
                    except (TypeError, ValueError):
                        pass
        return None

    def get_devices(self, group_id: int) -> list[dict]:
        # Prefer Ruijie's published account-wide device-list API and filter by
        # network group when the payload contains a group identifier.
        try:
            devices = self.get_all_devices()
            tagged = [(d, self._device_group_id(d)) for d in devices]
            if any(gid is not None for _, gid in tagged):
                return [d for d, gid in tagged if gid == int(group_id)]
        except RuijieAPIError as exc:
            # Some Cloud/API versions may not expose this route to every app.
            # Fall back to the older project-scoped endpoint only for 404.
            if exc.code != 404:
                raise

        data = self._get("/service/api/device/list", {"groupId": group_id})
        return self._extract_list(data, ("devices", "list", "items", "records", "data"))

    def get_clients(self, group_id: int) -> list[dict]:
        data = self._get("/service/api/client/list", {"groupId": group_id})
        return self._extract_list(data, ("clients", "list", "items", "records", "data"))

    def get_device_traffic(self, serial_number: str) -> dict:
        return self._get("/service/api/device/traffic", {"sn": serial_number})

    # The following write endpoints remain disabled from any automatic use
    # until Ruijie confirms their exact V2.0.3 request schemas for this account.
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
