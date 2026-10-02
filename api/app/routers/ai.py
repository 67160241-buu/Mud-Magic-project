"""AI design suggestions.

Turns a free-text idea ("แจกันลายดอกไม้มินิมอล") into concrete, buildable
mug configs that the Three.js front end can render directly.

Design notes:
- The OpenAI key lives ONLY here, server side. The browser never sees it;
  it calls this endpoint instead. Putting the key in front-end JS would
  expose it to anyone who opens devtools.
- The model's output is NEVER trusted as-is. An LLM will happily invent
  a shape called "hexagonal-swirl" that the geometry code can't build, so
  every field is validated against the same enums the renderer supports
  and anything invalid falls back to a safe default.
- If no key is configured, or OpenAI errors/times out, the endpoint returns
  503 with a clear reason and the front end falls back to its offline
  keyword generator. The feature degrades instead of breaking the page.
"""

from __future__ import annotations

import json
import time
from collections import defaultdict
from typing import Any

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field

from app.config import settings

router = APIRouter(prefix="/ai", tags=["AI"])

# --- What the renderer can actually build -----------------------------
# These must stay in sync with web/js/mug-model.js and web/js/wave.js.
SHAPES = ["classic", "round", "tall", "wide"]
HANDLES = ["minimal", "loop", "organic"]
SURFACES = ["smooth", "matte", "rough"]
PATTERNS = ["none", "flutes", "reeds", "facets", "rings", "twist", "wobble"]
GLAZES = {
    "terracotta": "#A65D45",
    "sage": "#7C8872",
    "cream": "#F3E9DD",
    "espresso": "#3B2A20",
    "blush": "#E3A896",
    "charcoal": "#2B2B2B",
    "ivory": "#FBF6EF",
    "denim": "#4C5A66",
}
SKILL_LEVELS = ["beginner", "intermediate", "advanced"]


class SuggestRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=500)
    skill_level: str | None = Field(default=None)
    count: int = Field(default=4, ge=1, le=6)


class DesignConfig(BaseModel):
    shape: str
    handle: str
    surface: str
    color: str
    glaze: str
    pattern: str
    pattern_count: int
    pattern_depth: float
    pattern_twist: float


class Design(BaseModel):
    name: str
    rationale: str
    config: DesignConfig


class SuggestResponse(BaseModel):
    designs: list[Design]
    source: str  # "openai" — the front end uses "offline" for its fallback


SYSTEM_PROMPT = """You are a ceramics design assistant for a 3D pottery web app.

The app can only render mugs from this fixed parameter set. You MUST choose
values from these lists exactly — never invent new ones:

shape: classic | round | tall | wide
handle: minimal | loop | organic
surface: smooth | matte | rough
glaze: terracotta | sage | cream | espresso | blush | charcoal | ivory | denim
pattern: none | flutes | reeds | facets | rings | twist | wobble
  - none   = smooth walls
  - flutes = vertical carved grooves
  - reeds  = vertical raised ribs
  - facets = angular flat panels
  - rings  = horizontal throwing rings
  - twist  = spiralling ribs
  - wobble = irregular wavy walls
pattern_count: integer 3-24 (how many grooves/ribs/rings; ignored if pattern is none)
pattern_depth: number 0.005-0.09 (how pronounced; ignored if pattern is none)
pattern_twist: number 0-1.2 (spiral amount; 0 for straight)

Difficulty guidance, if a skill level is given:
- beginner: prefer classic/wide shape, minimal/loop handle, rough/matte
  surface, pattern none/rings/reeds, shallow depth (<=0.03), twist 0.
- intermediate: any shape except very tall, any handle except organic,
  moderate patterns.
- advanced: anything, including organic handles, tall shapes, twist.

Reply with ONLY a JSON object, no prose, in exactly this form:
{"designs":[{"name":"...","rationale":"...","config":{"shape":"...","handle":"...","surface":"...","glaze":"...","pattern":"...","pattern_count":12,"pattern_depth":0.03,"pattern_twist":0}}]}

"name" is a short evocative title. "rationale" is ONE short sentence saying
why this suits the request (and the skill level, if given). Write both in
the SAME LANGUAGE as the user's prompt — if the prompt is Thai, reply in Thai.
Make the designs meaningfully different from each other, not minor variations."""


def _pick(value: Any, allowed: list[str], default: str) -> str:
    """Whitelist a model-supplied string; fall back if it invented something."""
    if isinstance(value, str) and value.strip().lower() in allowed:
        return value.strip().lower()
    return default


def _clamp(value: Any, low: float, high: float, default: float) -> float:
    try:
        return max(low, min(high, float(value)))
    except (TypeError, ValueError):
        return default


def _validate_design(raw: dict, index: int) -> Design:
    cfg = raw.get("config") or {}
    glaze = _pick(cfg.get("glaze"), list(GLAZES), "terracotta")
    pattern = _pick(cfg.get("pattern"), PATTERNS, "none")
    return Design(
        name=str(raw.get("name") or f"Design {index + 1}")[:80],
        rationale=str(raw.get("rationale") or "")[:300],
        config=DesignConfig(
            shape=_pick(cfg.get("shape"), SHAPES, "classic"),
            handle=_pick(cfg.get("handle"), HANDLES, "loop"),
            surface=_pick(cfg.get("surface"), SURFACES, "matte"),
            glaze=glaze,
            color=GLAZES[glaze],
            pattern=pattern,
            pattern_count=int(_clamp(cfg.get("pattern_count"), 3, 24, 12)),
            pattern_depth=round(_clamp(cfg.get("pattern_depth"), 0.005, 0.09, 0.03), 4),
            pattern_twist=round(_clamp(cfg.get("pattern_twist"), 0, 1.2, 0), 3),
        ),
    )


# --- Crude per-IP rate limit ------------------------------------------
# This endpoint spends real money per call, and it allows anonymous access
# so the design journey works logged-out. Without a limit, one script could
# run up the bill. In-memory only, so it resets on restart and isn't shared
# across replicas — fine for a course project, not for production.
_HITS: dict[str, list[float]] = defaultdict(list)
_WINDOW_SECONDS = 60
_MAX_PER_WINDOW = 10


def _rate_limit(request: Request) -> None:
    client = request.client.host if request.client else "unknown"
    now = time.time()
    hits = [t for t in _HITS[client] if now - t < _WINDOW_SECONDS]
    if len(hits) >= _MAX_PER_WINDOW:
        hits_left = int(_WINDOW_SECONDS - (now - hits[0]))
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Too many AI requests. Try again in {hits_left}s.",
        )
    hits.append(now)
    _HITS[client] = hits


@router.get("/status")
def ai_status():
    """Lets the front end decide whether to show the AI option at all."""
    return {"enabled": bool(settings.openai_api_key), "model": settings.openai_model}


@router.post("/suggest-designs", response_model=SuggestResponse)
def suggest_designs(payload: SuggestRequest, request: Request):
    if not settings.openai_api_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="OPENAI_API_KEY is not configured on the server.",
        )
    _rate_limit(request)

    try:
        from openai import OpenAI
    except ImportError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="openai package is not installed on the server.",
        )

    skill = payload.skill_level if payload.skill_level in SKILL_LEVELS else None
    user_msg = f"Idea: {payload.prompt}\nNumber of designs: {payload.count}"
    if skill:
        user_msg += f"\nSkill level: {skill}"

    client = OpenAI(api_key=settings.openai_api_key, timeout=settings.openai_timeout_seconds)
    try:
        completion = client.chat.completions.create(
            model=settings.openai_model,
            response_format={"type": "json_object"},
            temperature=0.9,  # variety matters more than precision here
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_msg},
            ],
        )
        content = completion.choices[0].message.content or "{}"
        data = json.loads(content)
    except json.JSONDecodeError:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="The AI returned malformed JSON.",
        )
    except Exception as exc:  # network error, auth error, quota, timeout
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"AI request failed: {type(exc).__name__}",
        )

    raw_designs = data.get("designs")
    if not isinstance(raw_designs, list) or not raw_designs:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="The AI returned no usable designs.",
        )

    designs = [_validate_design(d, i) for i, d in enumerate(raw_designs[: payload.count]) if isinstance(d, dict)]
    if not designs:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="The AI returned no usable designs.",
        )
    return SuggestResponse(designs=designs, source="openai")
