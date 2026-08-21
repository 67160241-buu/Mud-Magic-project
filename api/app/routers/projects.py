import math

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app import models, schemas
from app.database import get_db
from app.deps import get_current_user, require_project_admin, require_project_member

router = APIRouter(tags=["Projects"])


@router.post("/projects", response_model=schemas.ProjectOut, status_code=status.HTTP_201_CREATED)
def create_project(
    payload: schemas.ProjectCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    project = models.Project(name=payload.name, description=payload.description, owner_id=current_user.id)
    db.add(project)
    db.flush()  # get project.id before inserting the membership row

    db.add(models.ProjectMember(project_id=project.id, user_id=current_user.id, role=models.ProjectRole.owner))
    db.commit()
    db.refresh(project)
    return project


@router.get("/projects", response_model=schemas.Page[schemas.ProjectOut])
def list_projects(
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    query = db.query(models.Project)
    if not current_user.is_admin:
        query = (
            query.join(models.ProjectMember, models.ProjectMember.project_id == models.Project.id)
            .filter(models.ProjectMember.user_id == current_user.id)
        )

    total = query.count()
    items = query.order_by(models.Project.created_at.desc()).offset((page - 1) * limit).limit(limit).all()
    pages = math.ceil(total / limit) if total else 0
    return schemas.Page(items=items, total=total, page=page, limit=limit, pages=pages)


@router.get("/projects/{project_id}", response_model=schemas.ProjectOut)
def get_project(project: models.Project = Depends(require_project_member)):
    return project


@router.put("/projects/{project_id}", response_model=schemas.ProjectOut)
def update_project(
    payload: schemas.ProjectUpdate,
    project: models.Project = Depends(require_project_admin),
    db: Session = Depends(get_db),
):
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(project, field, value)
    db.add(project)
    db.commit()
    db.refresh(project)
    return project


@router.delete("/projects/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(project: models.Project = Depends(require_project_admin), db: Session = Depends(get_db)):
    db.delete(project)
    db.commit()
    return None


# ------------------------------------------------------------- Members ----

@router.get("/projects/{project_id}/members", response_model=list[schemas.ProjectMemberOut])
def list_members(
    project: models.Project = Depends(require_project_member),
    db: Session = Depends(get_db),
):
    return db.query(models.ProjectMember).filter_by(project_id=project.id).all()


@router.post(
    "/projects/{project_id}/members",
    response_model=schemas.ProjectMemberOut,
    status_code=status.HTTP_201_CREATED,
)
def add_member(
    payload: schemas.ProjectMemberAdd,
    project: models.Project = Depends(require_project_admin),
    db: Session = Depends(get_db),
):
    user = db.get(models.User, payload.user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")

    existing = db.query(models.ProjectMember).filter_by(project_id=project.id, user_id=user.id).first()
    if existing:
        raise HTTPException(status.HTTP_409_CONFLICT, "User is already a member of this project")

    member = models.ProjectMember(project_id=project.id, user_id=user.id, role=payload.role)
    db.add(member)
    db.commit()
    db.refresh(member)
    return member


@router.put("/projects/{project_id}/members/{user_id}", response_model=schemas.ProjectMemberOut)
def update_member_role(
    user_id: str,
    payload: schemas.ProjectMemberRoleUpdate,
    project: models.Project = Depends(require_project_admin),
    db: Session = Depends(get_db),
):
    member = db.query(models.ProjectMember).filter_by(project_id=project.id, user_id=user_id).first()
    if member is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "This user is not a member of the project")
    if member.role == models.ProjectRole.owner and payload.role != models.ProjectRole.owner:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Transfer ownership separately before changing this role")

    member.role = payload.role
    db.add(member)
    db.commit()
    db.refresh(member)
    return member


@router.delete("/projects/{project_id}/members/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_member(
    user_id: str,
    project: models.Project = Depends(require_project_admin),
    db: Session = Depends(get_db),
):
    member = db.query(models.ProjectMember).filter_by(project_id=project.id, user_id=user_id).first()
    if member is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "This user is not a member of the project")
    if member.role == models.ProjectRole.owner:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Cannot remove the project owner — transfer ownership first")

    db.delete(member)
    db.commit()
    return None
