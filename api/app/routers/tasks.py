import math

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app import models, schemas
from app.database import get_db
from app.deps import get_current_user, require_project_member

router = APIRouter(tags=["Tasks"])


@router.post(
    "/projects/{project_id}/tasks",
    response_model=schemas.TaskOut,
    status_code=status.HTTP_201_CREATED,
)
def create_task(
    payload: schemas.TaskCreate,
    project: models.Project = Depends(require_project_member),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    if payload.assignee_id:
        is_member = (
            db.query(models.ProjectMember)
            .filter_by(project_id=project.id, user_id=payload.assignee_id)
            .first()
        )
        if not is_member:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Assignee must be a member of this project")

    task = models.Task(
        project_id=project.id,
        title=payload.title,
        description=payload.description,
        priority=payload.priority,
        assignee_id=payload.assignee_id,
        due_date=payload.due_date,
        created_by=current_user.id,
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    return task


@router.get("/projects/{project_id}/tasks", response_model=schemas.Page[schemas.TaskOut])
def list_tasks(
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    task_status: models.TaskStatus | None = Query(None, alias="status"),
    assignee_id: str | None = Query(None),
    project: models.Project = Depends(require_project_member),
    db: Session = Depends(get_db),
):
    query = db.query(models.Task).filter_by(project_id=project.id)
    if task_status:
        query = query.filter(models.Task.status == task_status)
    if assignee_id:
        query = query.filter(models.Task.assignee_id == assignee_id)

    total = query.count()
    items = query.order_by(models.Task.created_at.desc()).offset((page - 1) * limit).limit(limit).all()
    pages = math.ceil(total / limit) if total else 0
    return schemas.Page(items=items, total=total, page=page, limit=limit, pages=pages)


def _get_task_with_access(task_id: str, db: Session, current_user: models.User) -> models.Task:
    task = db.get(models.Task, task_id)
    if task is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Task not found")
    if current_user.is_admin:
        return task
    is_member = (
        db.query(models.ProjectMember)
        .filter_by(project_id=task.project_id, user_id=current_user.id)
        .first()
    )
    if is_member is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You are not a member of this task's project")
    return task


@router.get("/tasks/{task_id}", response_model=schemas.TaskOut)
def get_task(task_id: str, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return _get_task_with_access(task_id, db, current_user)


@router.put("/tasks/{task_id}", response_model=schemas.TaskOut)
def update_task(
    task_id: str,
    payload: schemas.TaskUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    task = _get_task_with_access(task_id, db, current_user)

    data = payload.model_dump(exclude_unset=True)
    if "assignee_id" in data and data["assignee_id"]:
        is_member = (
            db.query(models.ProjectMember)
            .filter_by(project_id=task.project_id, user_id=data["assignee_id"])
            .first()
        )
        if not is_member:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Assignee must be a member of this project")

    for field, value in data.items():
        setattr(task, field, value)
    db.add(task)
    db.commit()
    db.refresh(task)
    return task


@router.patch("/tasks/{task_id}/status", response_model=schemas.TaskOut)
def update_task_status(
    task_id: str,
    payload: schemas.TaskStatusUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    task = _get_task_with_access(task_id, db, current_user)
    task.status = payload.status
    db.add(task)
    db.commit()
    db.refresh(task)
    return task


@router.delete("/tasks/{task_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_task(task_id: str, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    task = _get_task_with_access(task_id, db, current_user)
    db.delete(task)
    db.commit()
    return None
