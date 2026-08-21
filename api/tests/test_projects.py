from tests.conftest import register_and_login


def create_project(client, user, name="Test Project"):
    resp = client.post("/projects", json={"name": name}, headers=user["headers"])
    assert resp.status_code == 201
    return resp.json()


def test_create_project_makes_creator_owner(client):
    user = register_and_login(client, "owner1")
    project = create_project(client, user)

    members = client.get(f"/projects/{project['id']}/members", headers=user["headers"]).json()
    assert len(members) == 1
    assert members[0]["user_id"] == user["id"]
    assert members[0]["role"] == "owner"


def test_list_projects_only_shows_own_memberships(client):
    userA = register_and_login(client, "projA")
    userB = register_and_login(client, "projB")
    create_project(client, userA, "Alpha")

    respA = client.get("/projects", headers=userA["headers"]).json()
    respB = client.get("/projects", headers=userB["headers"]).json()
    assert respA["total"] == 1
    assert respB["total"] == 0


def test_non_member_cannot_view_project(client):
    owner = register_and_login(client, "projowner")
    outsider = register_and_login(client, "outsider")
    project = create_project(client, owner)

    resp = client.get(f"/projects/{project['id']}", headers=outsider["headers"])
    assert resp.status_code == 403


def test_non_admin_member_cannot_update_project(client):
    owner = register_and_login(client, "adminowner")
    member = register_and_login(client, "plainmember")
    project = create_project(client, owner)

    client.post(
        f"/projects/{project['id']}/members",
        json={"user_id": member["id"], "role": "member"},
        headers=owner["headers"],
    )
    resp = client.put(
        f"/projects/{project['id']}",
        json={"name": "Renamed"},
        headers=member["headers"],
    )
    assert resp.status_code == 403


def test_owner_can_update_project(client):
    owner = register_and_login(client, "updater_owner")
    project = create_project(client, owner)

    resp = client.put(f"/projects/{project['id']}", json={"name": "Renamed"}, headers=owner["headers"])
    assert resp.status_code == 200
    assert resp.json()["name"] == "Renamed"


def test_add_member_prevents_duplicates(client):
    owner = register_and_login(client, "dupowner")
    member = register_and_login(client, "dupmember")
    project = create_project(client, owner)

    first = client.post(
        f"/projects/{project['id']}/members",
        json={"user_id": member["id"], "role": "member"},
        headers=owner["headers"],
    )
    assert first.status_code == 201

    second = client.post(
        f"/projects/{project['id']}/members",
        json={"user_id": member["id"], "role": "admin"},
        headers=owner["headers"],
    )
    assert second.status_code == 409


def test_member_can_be_promoted_to_admin(client):
    owner = register_and_login(client, "promoteowner")
    member = register_and_login(client, "promotable")
    project = create_project(client, owner)

    client.post(
        f"/projects/{project['id']}/members",
        json={"user_id": member["id"], "role": "member"},
        headers=owner["headers"],
    )
    resp = client.put(
        f"/projects/{project['id']}/members/{member['id']}",
        json={"role": "admin"},
        headers=owner["headers"],
    )
    assert resp.status_code == 200
    assert resp.json()["role"] == "admin"

    # Now-admin member should be able to update the project.
    update_resp = client.put(
        f"/projects/{project['id']}",
        json={"name": "Updated by new admin"},
        headers=member["headers"],
    )
    assert update_resp.status_code == 200


def test_cannot_remove_project_owner(client):
    owner = register_and_login(client, "unremovable_owner")
    project = create_project(client, owner)

    resp = client.delete(f"/projects/{project['id']}/members/{owner['id']}", headers=owner["headers"])
    assert resp.status_code == 400


def test_remove_member(client):
    owner = register_and_login(client, "removerowner")
    member = register_and_login(client, "removable")
    project = create_project(client, owner)

    client.post(
        f"/projects/{project['id']}/members",
        json={"user_id": member["id"], "role": "member"},
        headers=owner["headers"],
    )
    resp = client.delete(f"/projects/{project['id']}/members/{member['id']}", headers=owner["headers"])
    assert resp.status_code == 204

    members = client.get(f"/projects/{project['id']}/members", headers=owner["headers"]).json()
    assert len(members) == 1


def test_delete_project(client):
    owner = register_and_login(client, "deleterowner")
    project = create_project(client, owner)

    resp = client.delete(f"/projects/{project['id']}", headers=owner["headers"])
    assert resp.status_code == 204

    check = client.get(f"/projects/{project['id']}", headers=owner["headers"])
    assert check.status_code == 404
