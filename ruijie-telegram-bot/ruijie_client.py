"""Ruijie / Reyee Cloud API client.

This client intentionally uses only endpoints documented in the Ruijie Cloud API
manual/support material. Unsupported write operations are not implemented.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Iterable

import httpx

ACCESS_TOKEN_MAGIC = "d63dss0a81e4415a889ac5b78fsc904a"
SUPPORTED_COMMON_TYPES = ("AP", "Switch", "Gateway")


class RuijieAPIError(Exception):
    def __init__(self, code: int | str, message: str, *, path: str | None = None):
        self.code = code
        self.message = message
        self.path = path
        suffix = f" ({path})" if path else ""
        super().__init__(f"Ruijie API error {code}: {message}{suffix}")


class RuijieAuthError(Exception):
    pass


@dataclass
class RuijieSession:
    appid: str
    secret: str
    base_url: str = "https://cloud-as.ruijienetworks.com"
    timeout_seconds: float = 30.0

    _access_token: str | None = field(default=None, init=False, repr=False)
    _expires_at: float = field(default=0.0, init=False, repr=False)

    def __post_init__(self) -> None:
        self.base_url = self.base_url.rstrip("/")
        self._client = httpx.Client(
            base_url=self.base_url,
            timeout=self.timeout_seconds,
            headers={"Accept": "application/json"},
        )

    def authenticate(self) -> str:
        """Get an API access token using App ID + Secret."""
        try:
            resp = self._client.post(
                "/service/api/oauth20/client/access_token",
                params={"token": ACCESS_TOKEN_MAGIC},
                json={"appid": self.appid, "secret": self.secret},
            )
        except httpx.HTTPError as exc:
            raise RuijieAuthError(f"Could not connect to Ruijie Cloud: {exc}") from exc

        data = self._json_response(resp, auth=True)
        if resp.status_code >= 400:
            raise RuijieAuthError(
                self._message_from_data(data) or f"HTTP {resp.status_code}"
            )

        code = data.get("code")
        if code not in (0, "0", None):
            raise RuijieAuthError(self._message_from_data(data) or f"API code {code}")

        token = data.get("accessToken") or data.get("access_token")
        if not isinstance(token, str) or not token.strip():
            raise RuijieAuthError("Authentication response did not include accessToken")

        self._access_token = token.strip()
        self._expires_at = time.time() + 50 * 60
        return self._access_token

    def refresh_token(self) -> str:
        if not self._access_token:
            return self.authenticate()
        try:
            resp = self._client.get(
                "/service/api/token/refresh",
                params={
                    "appid": self.appid,
                    "secret": self.secret,
                    "access_token": self._access_token,
                },
            )
        except httpx.HTTPError:
            return self.authenticate()

        try:
            data = self._json_response(resp, auth=True)
        except RuijieAuthError:
            return self.authenticate()

        if resp.status_code >= 400 or data.get("code") not in (0, "0", None):
            return self.authenticate()

        token = data.get("accessToken") or self._access_token
        if not isinstance(token, str) or not token:
            return self.authenticate()
        self._access_token = token
        self._expires_at = time.time() + 50 * 60
        return token

    def _ensure_token(self) -> str:
        if not self._access_token:
            return self.authenticate()
        if time.time() >= self._expires_at:
            return self.refresh_token()
        return self._access_token

    @staticmethod
    def _message_from_data(data: dict[str, Any]) -> str:
        value = data.get("msg") or data.get("message") or data.get("error")
        return str(value) if value is not None else ""

    @staticmethod
    def _json_response(resp: httpx.Response, *, auth: bool = False) -> dict[str, Any]:
        try:
            data = resp.json()
        except ValueError as exc:
            content_type = resp.headers.get("content-type", "")
            detail = "non-JSON response"
            if "text/html" in content_type.lower():
                detail = "HTML response (wrong endpoint/region or Cloud gateway error)"
            if auth:
                raise RuijieAuthError(f"Ruijie Cloud returned HTTP {resp.status_code}: {detail}") from exc
            raise RuijieAPIError(resp.status_code, detail, path=resp.request.url.path) from exc
        if not isinstance(data, dict):
            if auth:
                raise RuijieAuthError("Ruijie Cloud returned an unexpected response format")
            raise RuijieAPIError(
                resp.status_code,
                "Unexpected response format",
                path=resp.request.url.path,
            )
        return data

    @staticmethod
    def _is_token_expired(data: dict[str, Any]) -> bool:
        code = data.get("code")
        if code in (4, "4"):
            return True
        msg = str(data.get("msg") or "").lower()
        return "token" in msg and ("expire" in msg or "invalid" in msg)

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json_body: Any | None = None,
        retry_token: bool = True,
    ) -> dict[str, Any]:
        query = dict(params or {})
        query["access_token"] = self._ensure_token()
        try:
            resp = self._client.request(method, path, params=query, json=json_body)
        except httpx.HTTPError as exc:
            raise RuijieAPIError("NETWORK", str(exc), path=path) from exc

        data = self._json_response(resp)
        if retry_token and self._is_token_expired(data):
            self.authenticate()
            return self._request(
                method,
                path,
                params=params,
                json_body=json_body,
                retry_token=False,
            )

        if resp.status_code >= 400:
            raise RuijieAPIError(
                resp.status_code,
                self._message_from_data(data) or f"HTTP {resp.status_code}",
                path=path,
            )

        code = data.get("code")
        if code not in (0, "0", None):
            raise RuijieAPIError(
                code,
                self._message_from_data(data) or "Request failed",
                path=path,
            )
        return data

    def _get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        return self._request("GET", path, params=params)

    def _post(
        self,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json_body: Any | None = None,
    ) -> dict[str, Any]:
        return self._request("POST", path, params=params, json_body=json_body)

    def get_groups(self, depth: str = "BUILDING") -> dict[str, Any]:
        depth = depth.upper()
        if depth not in {"LOCATION", "BUILDING", "DEVICE"}:
            raise ValueError("depth must be LOCATION, BUILDING, or DEVICE")
        return self._get("/service/api/group/single/tree", {"depth": depth})

    @staticmethod
    def _extract_list(data: dict[str, Any], keys: Iterable[str]) -> list[dict[str, Any]]:
        for key in keys:
            value = data.get(key)
            if isinstance(value, list):
                return [x for x in value if isinstance(x, dict)]
            if isinstance(value, dict):
                for nested_key in ("list", "items", "records", "deviceList", "data"):
                    nested = value.get(nested_key)
                    if isinstance(nested, list):
                        return [x for x in nested if isinstance(x, dict)]
        return []

    def get_devices(
        self,
        group_id: int,
        *,
        common_types: Iterable[str] = SUPPORTED_COMMON_TYPES,
        per_page: int = 100,
        max_pages: int = 100,
    ) -> list[dict[str, Any]]:
        """Get AP/Switch/Gateway devices for one Ruijie network group."""
        group_id = int(group_id)
        per_page = max(1, min(int(per_page), 1000))
        devices: list[dict[str, Any]] = []
        seen: set[str] = set()

        for common_type in common_types:
            page = 0
            type_count = 0
            while page < max_pages:
                data = self._get(
                    "/service/api/maint/devices",
                    {
                        "common_type": common_type,
                        "group_id": group_id,
                        "page": page * per_page,
                        "per_page": per_page,
                    },
                )
                rows = self._extract_list(data, ("deviceList", "list", "data"))
                for row in rows:
                    sn = str(row.get("serialNumber") or row.get("sn") or "")
                    key = sn or repr(sorted(row.items()))
                    if key not in seen:
                        seen.add(key)
                        devices.append(row)
                        type_count += 1

                total = data.get("totalCount")
                if not rows:
                    break
                if isinstance(total, int) and type_count >= total:
                    break
                if len(rows) < per_page:
                    break
                page += 1
        return devices

    def get_device(self, serial_number: str) -> dict[str, Any]:
        return self._get(f"/service/api/device/{serial_number}")

    def get_device_flow_last_24h(self, serial_number: str) -> dict[str, Any]:
        now_ms = int(time.time() * 1000)
        start_ms = now_ms - 24 * 60 * 60 * 1000
        return self._post(
            "/logbizagent/logbiz/api/flow/show/hour",
            json_body={"sn": serial_number, "startDate": start_ms, "endDate": now_ms},
        )

    def get_device_performance(self, serial_number: str) -> dict[str, Any]:
        return self._get(
            "/logbizagent/logbiz/api/sys/current_performance",
            {"sn": serial_number},
        )

    def get_gateway_ports(self, serial_number: str) -> dict[str, Any]:
        return self._get(f"/service/api/gateway/intf/info/{serial_number}")

    def get_switch_ports(self, serial_number: str, *, page_size: int = 100) -> dict[str, Any]:
        return self._get(
            f"/service/api/conf/switch/device/{serial_number}/ports",
            {"page_size": page_size, "page_index": 0},
        )

    def get_switch_poe_info(self, serial_number: str) -> dict[str, Any]:
        return self._get(f"/service/api/conf/switch/device/{serial_number}/poe/info")

    def get_switch_poe_power(self, serial_number: str) -> dict[str, Any]:
        return self._get(f"/service/api/conf/switch/device/{serial_number}/poe/pwr")

    def get_current_clients(
        self,
        group_id: int,
        *,
        page_size: int = 100,
        max_pages: int = 100,
    ) -> list[dict[str, Any]]:
        group_id = int(group_id)
        page_size = max(1, min(int(page_size), 1000))
        result: list[dict[str, Any]] = []
        page_index = 0
        while page_index < max_pages * page_size:
            data = self._post(
                "/logbizagent/logbiz/api/sta/sta_users",
                json_body={
                    "groupId": group_id,
                    "pageSize": page_size,
                    "pageIndex": page_index,
                    "staType": "currentUser",
                },
            )
            rows = self._extract_list(data, ("list", "data", "records"))
            result.extend(rows)
            count = data.get("count")
            if not rows:
                break
            if isinstance(count, int) and len(result) >= count:
                break
            if len(rows) < page_size:
                break
            page_index += page_size
        return result

    def close(self) -> None:
        self._client.close()
