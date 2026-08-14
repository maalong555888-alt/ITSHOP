import json
import unittest
from urllib.parse import parse_qs

import httpx

from ruijie_client import RuijieSession


class RuijieClientTests(unittest.TestCase):
    def make_session(self):
        calls = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            path = request.url.path
            query = parse_qs(request.url.query.decode() if isinstance(request.url.query, bytes) else str(request.url.query))

            if path == "/service/api/oauth20/client/access_token":
                body = json.loads(request.content.decode())
                self.assertEqual(body, {"appid": "test-app", "secret": "test-secret"})
                self.assertIn("token", query)
                return httpx.Response(200, json={"code": 0, "accessToken": "mock-token"})

            self.assertEqual(query.get("access_token"), ["mock-token"])

            if path == "/service/api/group/single/tree":
                self.assertEqual(query.get("depth"), ["BUILDING"])
                return httpx.Response(
                    200,
                    json={
                        "code": 0,
                        "groups": [
                            {
                                "groupId": 1,
                                "name": "Root",
                                "type": "LOCATION",
                                "subGroups": [
                                    {
                                        "groupId": 10,
                                        "name": "Project A",
                                        "type": "BUILDING",
                                        "subGroups": [],
                                    }
                                ],
                            }
                        ],
                    },
                )

            if path == "/service/api/maint/devices":
                self.assertEqual(query.get("group_id"), ["10"])
                self.assertIn(query.get("common_type", [""])[0], {"AP", "Switch", "Gateway"})
                return httpx.Response(
                    200,
                    json={
                        "code": 0,
                        "totalCount": 1,
                        "deviceList": [
                            {
                                "serialNumber": f"SN-{query['common_type'][0]}",
                                "onlineStatus": "ON",
                                "groupId": 10,
                            }
                        ],
                    },
                )

            if path == "/logbizagent/logbiz/api/sta/sta_users":
                body = json.loads(request.content.decode())
                self.assertEqual(body["groupId"], 10)
                self.assertEqual(body["staType"], "currentUser")
                return httpx.Response(
                    200,
                    json={
                        "code": 0,
                        "count": 1,
                        "list": [{"userName": "Phone", "mac": "00:11:22:33:44:55"}],
                    },
                )

            return httpx.Response(404, json={"code": 404, "msg": "not found"})

        session = RuijieSession("test-app", "test-secret")
        session._client.close()
        session._client = httpx.Client(
            base_url="https://cloud-as.ruijienetworks.com",
            transport=httpx.MockTransport(handler),
        )
        return session, calls

    def test_auth_groups_devices_and_clients(self):
        session, calls = self.make_session()
        try:
            self.assertEqual(session.authenticate(), "mock-token")
            groups = session.get_groups("BUILDING")
            self.assertEqual(groups["groups"][0]["groupId"], 1)

            devices = session.get_devices(10)
            self.assertEqual(len(devices), 3)
            self.assertEqual(
                {d["serialNumber"] for d in devices},
                {"SN-AP", "SN-Switch", "SN-Gateway"},
            )

            clients = session.get_current_clients(10)
            self.assertEqual(len(clients), 1)
            self.assertEqual(clients[0]["userName"], "Phone")

            paths = [request.url.path for request in calls]
            self.assertIn("/service/api/oauth20/client/access_token", paths)
            self.assertIn("/service/api/group/single/tree", paths)
            self.assertEqual(paths.count("/service/api/maint/devices"), 3)
            self.assertIn("/logbizagent/logbiz/api/sta/sta_users", paths)
        finally:
            session.close()


if __name__ == "__main__":
    unittest.main()
