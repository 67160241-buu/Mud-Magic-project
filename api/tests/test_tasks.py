from tests.conftest import register_and_login


def create_project(client, user, name="Task Project"):
    return client.post("/projects", json={"name": name}, headers=user["headers"]).json()


def test_create_task(client):
    owner = register_and_login(client, "taskowner")
    project = create_project(client, owner)

    resp = client.post(
        f"/projects/{project['id']}/tasks",
        json={"title": "Write tests", "priority": "high"},
        headers=owner["headers"],
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["title"] == "Write tests"
    assert body["status"] == "todo"
    assert body["priority"] == "high"


def test_non_member_cannot_create_task(client):
    owner = register_and_login(client, "taskowner2")
    outsider = register_and_login(client, "taskoutsider")
    project = create_project(client, owner)

    resp = client.post(
        f"/projects/{project['id']}/tasks",
        json={"title": "Sneaky task"},
        headers=outsider["headers"],
    )
    assert resp.status_code == 403


def test_assignee_must_be_project_member(client):
    owner = register_and_login(client, "taskowner3")
    stranger = register_and_login(client, "notamember")
    project = create_project(client, owner)

    resp = client.post(
        f"/projects/{project['id']}/tasks",
        json={"title": "Assign to stranger", "assignee_id": stranger["id"]},
        headers=owner["headers"],
    )
    assert resp.status_code == 400


def test_list_tasks_with_status_filter(client):
    owner = register_and_login(client, "taskowner4")
    project = create_project(client, owner)

    t1 = client.post(f"/projects/{project['id']}/tasks", json={"title": "A"}, headers=owner["headers"]).json()
    client.post(f"/projects/{project['id']}/tasks", json={"title": "B"}, headers=owner["headers"])
    client.patch(f"/tasks/{t1['id']}/status", json={"status": "done"}, headers=owner["headers"])

    resp = client.get(f"/projects/{project['id']}/tasks?status=done", headers=owner["headers"])
    body = resp.json()
    assert body["total"] == 1
    assert body["items"][0]["title"] == "A"


def test_update_task_status(client):
    owner = register_and_login(client, "taskowner5")
    project = create_project(client, owner)
    task = client.post(f"/projects/{project['id']}/tasks", json={"title": "Ship it"}, headers=owner["headers"]).json()

    resp = client.patch(f"/tasks/{task['id']}/status", json={"status": "in_progress"}, headers=owner["headers"])
    assert resp.status_code == 200
    assert resp.json()["status"] == "in_progress"


def test_update_task_fields(client):
    owner = register_and_login(client, "taskowner6")
    project = create_project(client, owner)
    task = client.post(f"/projects/{project['id']}/tasks", json={"title": "Old title"}, headers=owner["headers"]).json()

    resp = client.put(
        f"/tasks/{task['id']}",
        json={"title": "New title", "priority": "low"},
        headers=owner["headers"],
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["title"] == "New title"
    assert body["priority"] == "low"


def test_non_member_cannot_view_task(client):
    owner = register_and_login(client, "taskowner7")
    outsider = register_and_login(client, "taskoutsider2")
    project = create_project(client, owner)
    task = client.post(f"/projects/{project['id']}/tasks", json={"title": "Private"}, headers=owner["headers"]).json()

    resp = client.get(f"/tasks/{task['id']}", headers=outsider["headers"])
    assert resp.status_code == 403


def test_delete_task(client):
    owner = register_and_login(client, "taskowner8")
    project = create_project(client, owner)
    task = client.post(f"/projects/{project['id']}/tasks", json={"title": "Temp"}, headers=owner["headers"]).json()

    resp = client.delete(f"/tasks/{task['id']}", headers=owner["headers"])
    assert resp.status_code == 204

    check = client.get(f"/tasks/{task['id']}", headers=owner["headers"])
    assert check.status_code == 404


def test_project_member_can_view_and_update_task(client):
    owner = register_and_login(client, "taskowner9")
    member = register_and_login(client, "taskmember")
    project = create_project(client, owner)

    client.post(
        f"/projects/{project['id']}/members",
        json={"user_id": member["id"], "role": "member"},
        headers=owner["headers"],
    )
    task = client.post(f"/projects/{project['id']}/tasks", json={"title": "Shared"}, headers=owner["headers"]).json()

    resp = client.patch(f"/tasks/{task['id']}/status", json={"status": "done"}, headers=member["headers"])
    assert resp.status_code == 200
