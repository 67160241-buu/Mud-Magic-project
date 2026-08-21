from tests.conftest import register_and_login


def test_check_username_available(client):
    resp = client.get("/check-username/freshname")
    assert resp.status_code == 200
    assert resp.json() == {"username": "freshname", "available": True}


def test_check_username_taken(client):
    register_and_login(client, "taken_name")
    resp = client.get("/check-username/taken_name")
    assert resp.json()["available"] is False


def test_get_user_by_id(client):
    user = register_and_login(client, "lookup_target")
    resp = client.get(f"/users/{user['id']}", headers=user["headers"])
    assert resp.status_code == 200
    assert resp.json()["username"] == "lookup_target"


def test_get_user_not_found(client):
    user = register_and_login(client, "requester")
    resp = client.get("/users/00000000-0000-0000-0000-000000000000", headers=user["headers"])
    assert resp.status_code == 404


def test_list_users_paginated(client):
    for i in range(3):
        register_and_login(client, f"paged{i}")
    admin = register_and_login(client, "pageviewer")

    resp = client.get("/users?page=1&limit=2", headers=admin["headers"])
    body = resp.json()
    assert resp.status_code == 200
    assert body["limit"] == 2
    assert body["total"] == 4  # 3 paged users + pageviewer
    assert len(body["items"]) == 2
    assert body["pages"] == 2


def test_list_users_search_filters_by_username(client):
    register_and_login(client, "zebra_user")
    admin = register_and_login(client, "searcher")

    resp = client.get("/users?search=zebra", headers=admin["headers"])
    body = resp.json()
    assert body["total"] == 1
    assert body["items"][0]["username"] == "zebra_user"


def test_update_own_profile(client):
    user = register_and_login(client, "selfeditor")
    resp = client.put(f"/users/{user['id']}", json={"full_name": "New Name"}, headers=user["headers"])
    assert resp.status_code == 200
    assert resp.json()["full_name"] == "New Name"


def test_cannot_update_other_users_profile(client):
    victim = register_and_login(client, "victim")
    attacker = register_and_login(client, "attacker")

    resp = client.put(
        f"/users/{victim['id']}",
        json={"full_name": "Hacked"},
        headers=attacker["headers"],
    )
    assert resp.status_code == 403


def test_non_admin_cannot_set_is_active(client):
    user = register_and_login(client, "selfactivator")
    resp = client.put(f"/users/{user['id']}", json={"is_active": False}, headers=user["headers"])
    assert resp.status_code == 403


def test_update_user_email_conflict(client):
    register_and_login(client, "emailowner")
    user = register_and_login(client, "emailwanter")
    resp = client.put(
        f"/users/{user['id']}",
        json={"email": "emailowner@example.com"},
        headers=user["headers"],
    )
    assert resp.status_code == 409


def test_delete_own_account(client):
    user = register_and_login(client, "selfdeleter")
    resp = client.delete(f"/users/{user['id']}", headers=user["headers"])
    assert resp.status_code == 204

    check = client.get("/check-username/selfdeleter")
    assert check.json()["available"] is True


def test_cannot_delete_other_users_account(client):
    victim = register_and_login(client, "delete_victim")
    attacker = register_and_login(client, "delete_attacker")

    resp = client.delete(f"/users/{victim['id']}", headers=attacker["headers"])
    assert resp.status_code == 403
