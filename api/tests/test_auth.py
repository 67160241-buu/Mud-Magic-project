from tests.conftest import register_and_login


def test_register_returns_user_without_password(client):
    resp = client.post(
        "/register",
        json={"username": "alice", "email": "alice@example.com", "password": "secret123"},
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["username"] == "alice"
    assert "password" not in body
    assert "hashed_password" not in body


def test_register_duplicate_username_conflicts(client):
    client.post("/register", json={"username": "bob", "email": "bob@example.com", "password": "secret123"})
    resp = client.post("/register", json={"username": "bob", "email": "other@example.com", "password": "secret123"})
    assert resp.status_code == 409


def test_register_duplicate_email_conflicts(client):
    client.post("/register", json={"username": "carl", "email": "dup@example.com", "password": "secret123"})
    resp = client.post("/register", json={"username": "carl2", "email": "dup@example.com", "password": "secret123"})
    assert resp.status_code == 409


def test_register_rejects_short_password(client):
    resp = client.post("/register", json={"username": "shortpw", "email": "s@example.com", "password": "123"})
    assert resp.status_code == 422


def test_login_success_returns_token_pair(client):
    client.post("/register", json={"username": "dana", "email": "dana@example.com", "password": "secret123"})
    resp = client.post("/login", json={"username": "dana", "password": "secret123"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["access_token"]
    assert body["refresh_token"]
    assert body["token_type"] == "bearer"


def test_login_wrong_password_rejected(client):
    client.post("/register", json={"username": "erin", "email": "erin@example.com", "password": "secret123"})
    resp = client.post("/login", json={"username": "erin", "password": "wrong"})
    assert resp.status_code == 401


def test_login_unknown_user_rejected(client):
    resp = client.post("/login", json={"username": "doesnotexist", "password": "whatever"})
    assert resp.status_code == 401


def test_me_requires_bearer_token(client):
    resp = client.get("/me")
    assert resp.status_code == 401


def test_me_returns_current_user(client):
    user = register_and_login(client, "frank")
    resp = client.get("/me", headers=user["headers"])
    assert resp.status_code == 200
    assert resp.json()["username"] == "frank"


def test_refresh_rotates_token_and_blocks_reuse(client):
    user = register_and_login(client, "grace")
    old_refresh = user["refresh_token"]

    resp = client.post("/refresh", json={"refresh_token": old_refresh})
    assert resp.status_code == 200
    new_tokens = resp.json()
    assert new_tokens["refresh_token"] != old_refresh

    # Old refresh token must now be rejected (rotate-on-use).
    reuse_resp = client.post("/refresh", json={"refresh_token": old_refresh})
    assert reuse_resp.status_code == 401

    # The newly issued refresh token must still work.
    resp2 = client.post("/refresh", json={"refresh_token": new_tokens["refresh_token"]})
    assert resp2.status_code == 200


def test_logout_revokes_refresh_token(client):
    user = register_and_login(client, "heidi")
    resp = client.post("/logout", json={"refresh_token": user["refresh_token"]})
    assert resp.status_code == 204

    resp2 = client.post("/refresh", json={"refresh_token": user["refresh_token"]})
    assert resp2.status_code == 401


def test_change_password_then_login_with_new_password(client):
    user = register_and_login(client, "ivan")
    resp = client.post(
        "/change-password",
        json={"old_password": "secret123", "new_password": "newpassword456"},
        headers=user["headers"],
    )
    assert resp.status_code == 204

    old_login = client.post("/login", json={"username": "ivan", "password": "secret123"})
    assert old_login.status_code == 401

    new_login = client.post("/login", json={"username": "ivan", "password": "newpassword456"})
    assert new_login.status_code == 200


def test_change_password_revokes_existing_refresh_tokens(client):
    user = register_and_login(client, "judy")
    client.post(
        "/change-password",
        json={"old_password": "secret123", "new_password": "newpassword456"},
        headers=user["headers"],
    )
    resp = client.post("/refresh", json={"refresh_token": user["refresh_token"]})
    assert resp.status_code == 401


def test_change_password_wrong_old_password_rejected(client):
    user = register_and_login(client, "kevin")
    resp = client.post(
        "/change-password",
        json={"old_password": "wrongpass", "new_password": "newpassword456"},
        headers=user["headers"],
    )
    assert resp.status_code == 400
