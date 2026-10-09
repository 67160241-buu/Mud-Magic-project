"""Copy Mud Magic users and saved designs from Postgres into Firebase.

- users    -> Firebase Authentication, keeping the same id (uid), email,
              username (as displayName) and bcrypt password hash, so everyone
              signs in with the password they already have.
- projects -> Firestore `designs` (the website saves designs as projects).
Project members, tasks, refresh tokens and the is_admin flag are not copied:
the website doesn't use them.

Safe to run more than once: users that already exist in Firebase are reported
as errors and skipped, and designs are written with their Postgres id.

Run from the repo root while the database is up (`docker compose up -d db`):

  docker compose run --rm --no-deps -v ./api/scripts:/app/scripts \
    -v ./firebase-service-account.json:/app/sa.json:ro \
    -e GOOGLE_APPLICATION_CREDENTIALS=/app/sa.json --entrypoint sh api \
    -c "pip install -q firebase-admin && python scripts/migrate_to_firebase.py"

Add --dry-run after the script name to only print what would be copied.
"""

import os
import sys

import firebase_admin
import psycopg2
from firebase_admin import auth, credentials, firestore

DRY_RUN = "--dry-run" in sys.argv


def pg_dsn() -> str:
    # The API's SQLAlchemy URL, minus the driver suffix psycopg2 doesn't accept.
    url = os.environ["DATABASE_URL"]
    return url.replace("postgresql+psycopg2://", "postgresql://", 1)


def main() -> None:
    conn = psycopg2.connect(pg_dsn())
    cur = conn.cursor()
    cur.execute("SELECT id, email, username, hashed_password, is_active FROM users ORDER BY created_at")
    users = cur.fetchall()
    cur.execute("SELECT id, owner_id, name, description, created_at, updated_at FROM projects ORDER BY created_at")
    projects = cur.fetchall()
    conn.close()
    print(f"Postgres: {len(users)} users, {len(projects)} designs")

    if DRY_RUN:
        for uid, email, username, *_ in users:
            print(f"  user {email} ({username}) -> uid {uid}")
        for pid, owner, name, *_ in projects:
            print(f"  design {name!r} owner {owner} -> designs/{pid}")
        return

    firebase_admin.initialize_app(credentials.ApplicationDefault())

    records = [
        auth.ImportUserRecord(
            uid=str(uid),
            email=email.lower(),
            display_name=username,
            password_hash=hashed.encode("utf-8"),
            disabled=not is_active,
        )
        for uid, email, username, hashed, is_active in users
    ]
    imported = 0
    for i in range(0, len(records), 1000):  # Firebase accepts 1000 per call
        result = auth.import_users(records[i : i + 1000], hash_alg=auth.UserImportHash.bcrypt())
        imported += result.success_count
        for err in result.errors:
            print(f"  user {records[i + err.index].email}: {err.reason}")
    print(f"Firebase Auth: imported {imported} of {len(records)} users")

    db = firestore.client()
    batch = db.batch()
    for n, (pid, owner, name, description, created, updated) in enumerate(projects, 1):
        batch.set(
            db.collection("designs").document(str(pid)),
            {
                "ownerId": str(owner),
                "name": name,
                "description": description or "",
                "createdAt": created,
                "updatedAt": updated or created,
            },
        )
        if n % 400 == 0:  # stay under Firestore's 500 writes per batch
            batch.commit()
            batch = db.batch()
    batch.commit()
    print(f"Firestore: wrote {len(projects)} designs")


if __name__ == "__main__":
    main()
