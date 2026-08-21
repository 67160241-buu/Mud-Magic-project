from fastapi import Depends, HTTPException, Path, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app import models
from app.database import get_db
from app.security import decode_token

bearer_scheme = HTTPBearer(auto_error=False)


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> models.User:
    if credentials is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing bearer token")
    try:
        payload = decode_token(credentials.credentials)
    except ValueError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired token") from exc
    if payload.get("type") != "access":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not an access token")

    user = db.get(models.User, payload.get("sub"))
    if user is None or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "User not found or inactive")
    return user


def require_admin(current_user: models.User = Depends(get_current_user)) -> models.User:
    if not current_user.is_admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Admin privileges required")
    return current_user


def get_project_or_404(project_id: str = Path(...), db: Session = Depends(get_db)) -> models.Project:
    project = db.get(models.Project, project_id)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
    return project


def get_membership(
    project: models.Project = Depends(get_project_or_404),
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> models.ProjectMember | None:
    return (
        db.query(models.ProjectMember)
        .filter_by(project_id=project.id, user_id=current_user.id)
        .first()
    )


def require_project_member(
    project: models.Project = Depends(get_project_or_404),
    current_user: models.User = Depends(get_current_user),
    membership: models.ProjectMember | None = Depends(get_membership),
) -> models.Project:
    if membership is None and not current_user.is_admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You are not a member of this project")
    return project


def require_project_admin(
    project: models.Project = Depends(get_project_or_404),
    current_user: models.User = Depends(get_current_user),
    membership: models.ProjectMember | None = Depends(get_membership),
) -> models.Project:
    is_owner_or_admin = membership is not None and membership.role in (
        models.ProjectRole.owner,
        models.ProjectRole.admin,
    )
    if not is_owner_or_admin and not current_user.is_admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Project admin/owner privileges required")
    return project
