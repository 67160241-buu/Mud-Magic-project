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
import logging
import time
from collections import defaultdict
from typing import Any

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field

from app.config import settings

router = APIRouter(prefix="/ai", tags=["AI"])
log = logging.getLogger("uvicorn.error")

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
        # GPT-5 and o-series reasoning models only accept the default
        # temperature, so the variety boost is sent to older models only.
        extra = {}
        if not settings.openai_model.startswith(("gpt-5", "o")):
            extra["temperature"] = 0.9  # variety matters more than precision here
        completion = client.chat.completions.create(
            model=settings.openai_model,
            response_format={"type": "json_object"},
            **extra,
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
        # OpenAI's own message says why (bad key, no credit, unknown model);
        # it goes to `docker compose logs api`, never to the browser.
        log.warning("OpenAI call failed: %s: %s", type(exc).__name__, exc)
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


# --- Studio command box -------------------------------------------------
# "ทำคอให้สูงขึ้น" → a small patch on the Studio's vessel config. Same rule as
# above: the model only proposes; every field is whitelisted and clamped here,
# and the browser clamps again with normalizeConfig().
# These must stay in sync with web/js/vessels.js.
VESSEL_RANGES = {
    "vase": {"height": (12, 45), "belly": (8, 30), "wall": (0.4, 1.5)},
    "bowl": {"height": (5, 16), "belly": (10, 32), "wall": (0.4, 1.5)},
    "pitcher": {"height": (12, 30), "belly": (9, 20), "wall": (0.4, 1.2)},
    "plate": {"height": (2, 5), "belly": (18, 36), "wall": (0.5, 1.2)},
    "mug": {"height": (7, 16), "belly": (6, 12), "wall": (0.4, 1.0)},
    "sculpture": {"height": (12, 45), "belly": (8, 26), "wall": (0.5, 1.5)},
}
STUDIO_ENUMS = {
    "neck": ["clean", "asym", "fluted", "flared"],
    "foot": ["flat", "trimmed", "pedestal"],
    "handle": ["none", "ear", "loop", "lug"],
    "clay": ["sand", "cream", "terra", "charcoal"],
    "texture": ["thrown", "pinch"],
    "surface": SURFACES,
}
COLOR_PATTERNS = ["none", "stripes", "rings", "petals"]
OUTLINES = ["round", "heart", "star", "flower", "cloud", "clover", "teardrop", "leaf", "squircle"]
LAB_RANGES = {
    "twist": (-3, 3), "aspect": (0.4, 2), "polySides": (0, 24), "polyRound": (-1, 1),
    "polyBulge": (0, 0.95), "bends": (0, 12), "bendDepth": (0, 0.5), "bendPoles": (0, 12),
    "helixFreq": (0, 6), "helixAmp": (0, 1), "colorCycles": (1, 24), "colorSharp": (0, 1),
}


def _hex(value: Any) -> str | None:
    if isinstance(value, str):
        v = value.strip()
        if v.lower() in GLAZES:
            return GLAZES[v.lower()]
        if v == "raw" or (len(v) == 7 and v[0] == "#" and all(c in "0123456789abcdefABCDEF" for c in v[1:])):
            return v
    return None


class EditRequest(BaseModel):
    command: str = Field(min_length=1, max_length=300)
    config: dict[str, Any]
    profile: list[list[float]] | None = None  # current outer wall [[r, y], ...]


class EditResponse(BaseModel):
    patch: dict[str, Any]
    pattern: str | None = None
    message: str


FIELDS_DOC = """Editable fields (use these exact names and values):
vessel: vase | bowl | pitcher | plate | mug | sculpture  (only if the user asks for a different kind of pot)
height, belly (widest diameter), wall (thickness): centimetres. Allowed ranges per vessel:
  vase h12-45 b8-30 w0.4-1.5 | bowl h5-16 b10-32 | pitcher h12-30 b9-20 | plate h2-5 b18-36 | mug h7-16 b6-12 | sculpture h12-45 b8-26
neck: clean | asym (wonky lip) | fluted | flared
foot: flat | trimmed | pedestal
handle: none | ear | loop | lug
clay: sand | cream | terra | charcoal
texture: thrown (wheel) | pinch (hand-built)
surface: smooth (glossy) | matte | rough
color: "#RRGGBB" glaze colour, or "raw" for unglazed
pattern: none | flutes | reeds | facets | rings | twist | wobble  (carved surface pattern)
lab (advanced shaping, include only keys you change):
  outline round|heart|star|flower|cloud|clover|teardrop|leaf|squircle: the cross-section seen from
    above (squircle = rounded square). Use it whenever the idea names such a shape,
    and feel free to use it for playful or unusual pieces,
  twist -3..3 (turns of spiral), aspect 0.4..2 (oval squash), polySides 0 or 3..24 (polygon cross-section),
  polyRound -1..1, polyBulge 0..0.95, bends 0..12 (wavy lean), bendDepth 0..0.5,
  helixFreq 0..6, helixAmp 0..1, colorPattern none|stripes|rings|petals,
  accent "#RRGGBB" (second colour for colorPattern), colorCycles 1..24, colorSharp 0..1
profile: the outer wall silhouette as [r, y] points from base (y=0) to rim (y=1);
  r is radius relative to the widest point (widest = 1.0). Use it for neck, shoulder,
  belly, waist or rim shape changes ("taller neck", "narrower top", "rounder belly").
  Return the FULL new list, 4-12 points, y strictly increasing from 0 to 1. For plates
  and bowls r should only grow from base to rim (no inward steps), or the piece
  looks like a ring stacked on a disc. Start from the
  current profile and move only the points that matter.

"""

EDIT_PROMPT = """You edit a pottery design in a 3D studio. The user gives a command
(often in Thai) and the current design. Change ONLY what the command asks for.

""" + FIELDS_DOC + """"Bigger/smaller" steps are about 15-25% unless the user gives numbers.

Reply with ONLY JSON: {"changes": {...only changed fields...}, "message": "..."}
"message" is one short friendly sentence in the user's language saying what you changed.
If the command cannot be done with these fields, return {"changes": {}, "message": "<explain briefly>"}."""


def _validate_edit(raw: dict, current: dict) -> EditResponse:
    ch = raw.get("changes") if isinstance(raw.get("changes"), dict) else {}
    patch: dict[str, Any] = {}

    vessel = ch.get("vessel")
    if vessel in VESSEL_RANGES and vessel != current.get("vessel"):
        patch["vessel"] = vessel
    target = patch.get("vessel") or (current.get("vessel") if current.get("vessel") in VESSEL_RANGES else "vase")
    for key, (low, high) in VESSEL_RANGES[target].items():
        if key in ch:
            value = _clamp(ch[key], low, high, None)
            if value is not None:
                patch[key] = round(value, 2)

    for key, allowed in STUDIO_ENUMS.items():
        if isinstance(ch.get(key), str) and ch[key].strip().lower() in allowed:
            patch[key] = ch[key].strip().lower()
    color = _hex(ch.get("color"))
    if color:
        patch["color"] = color

    lab: dict[str, Any] = {}
    lab_in = ch.get("lab") if isinstance(ch.get("lab"), dict) else {}
    for key, (low, high) in LAB_RANGES.items():
        if key in lab_in:
            value = _clamp(lab_in[key], low, high, None)
            if value is not None:
                lab[key] = round(value) if key in ("polySides", "bends", "bendPoles") else round(value, 3)
    if lab_in.get("outline") in OUTLINES:
        lab["outline"] = lab_in["outline"]
    if lab_in.get("colorPattern") in COLOR_PATTERNS:
        lab["colorPattern"] = lab_in["colorPattern"]
    accent = _hex(lab_in.get("accent"))
    if accent and accent != "raw":
        lab["accent"] = accent

    profile = ch.get("profile")
    if isinstance(profile, list) and 2 <= len(profile) <= 16:
        points = []
        for p in profile:
            if isinstance(p, (list, tuple)) and len(p) == 2:
                r, y = _clamp(p[0], 0.02, 3, None), _clamp(p[1], 0, 1, None)
                if r is not None and y is not None:
                    points.append([round(r, 3), round(y, 3)])
        points.sort(key=lambda p: p[1])
        if len(points) >= 2:
            lab["nodes"] = points
    if lab:
        patch["lab"] = lab

    pattern = ch.get("pattern") if ch.get("pattern") in PATTERNS else None
    message = str(raw.get("message") or "")[:200]
    return EditResponse(patch=patch, pattern=pattern, message=message)


@router.post("/edit-design", response_model=EditResponse)
def edit_design(payload: EditRequest, request: Request):
    if not settings.openai_api_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="OPENAI_API_KEY is not configured on the server.",
        )
    _rate_limit(request)
    from openai import OpenAI

    current = {k: v for k, v in payload.config.items() if k != "modulation"}
    user_msg = json.dumps(
        {"command": payload.command, "current": current, "profile": payload.profile},
        ensure_ascii=False,
    )
    client = OpenAI(api_key=settings.openai_api_key, timeout=settings.openai_timeout_seconds)
    try:
        completion = client.chat.completions.create(
            model=settings.openai_model,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": EDIT_PROMPT},
                {"role": "user", "content": user_msg},
            ],
        )
        data = json.loads(completion.choices[0].message.content or "{}")
    except json.JSONDecodeError:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="The AI returned malformed JSON.")
    except Exception as exc:  # network error, auth error, quota, timeout
        # OpenAI's own message says why (bad key, no credit, unknown model);
        # it goes to `docker compose logs api`, never to the browser.
        log.warning("OpenAI call failed: %s: %s", type(exc).__name__, exc)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"AI request failed: {type(exc).__name__}")
    if not isinstance(data, dict):
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="The AI returned no usable changes.")
    return _validate_edit(data, payload.config)


# --- Whole-vessel suggestions ----------------------------------------------
# The older /suggest-designs only knows mug colours and patterns, so the shape
# came from the offline keyword matcher. This one lets the model pick the
# vessel, proportions and silhouette too, validated by _validate_edit().
class VesselSuggestRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=500)
    skill_level: str | None = None
    count: int = Field(default=4, ge=1, le=12)  # the Create page asks for a pool of 8
    vessel: str | None = None  # the studio's current vessel, used if the prompt names none


class VesselDesign(BaseModel):
    name: str
    rationale: str
    patch: dict[str, Any]
    pattern: str | None = None


class VesselSuggestResponse(BaseModel):
    designs: list[VesselDesign]
    source: str


VESSEL_PROMPT = """You design handmade ceramics for a 3D pottery web app. Turn the user's
idea (often Thai) into distinct designs the app can build from these fields:

""" + FIELDS_DOC + """
Always set vessel, height, belly, neck, foot, handle, clay, texture, surface, color
and a profile for every design, so each one has its own silhouette. Use lab and
pattern when they help express the idea (e.g. heart/star/flower/cloud/leaf/teardrop ideas -> lab.outline; a hexagon -> polySides; an oval or squashed form -> aspect; a twisted vase -> twist).
Shapes the app cannot make exactly (animals, letters, faces) should be
approximated with the closest form, and the rationale should say so honestly.

Skill level, if given: beginner -> simple profiles, no lab effects, wall >= 0.6,
handle none or loop; intermediate -> moderate; advanced -> anything.

Reply with ONLY JSON:
{"designs":[{"name":"...","rationale":"...","changes":{...fields...}}]}
"name" is a short evocative title, "rationale" one short sentence, both in the
SAME language as the user's idea. Make the designs clearly different from each other."""


@router.post("/suggest-vessels", response_model=VesselSuggestResponse)
def suggest_vessels(payload: VesselSuggestRequest, request: Request):
    if not settings.openai_api_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="OPENAI_API_KEY is not configured on the server.",
        )
    _rate_limit(request)
    from openai import OpenAI

    count = min(payload.count, 6)  # more than 6 gets slow; the page pads the rest
    user_msg = f"Idea: {payload.prompt}\nNumber of designs: {count}"
    if payload.skill_level in SKILL_LEVELS:
        user_msg += f"\nSkill level: {payload.skill_level}"
    if payload.vessel in VESSEL_RANGES:
        user_msg += f"\nIf the idea names no vessel type, use: {payload.vessel}"
    client = OpenAI(api_key=settings.openai_api_key, timeout=settings.openai_timeout_seconds)
    try:
        completion = client.chat.completions.create(
            model=settings.openai_model,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": VESSEL_PROMPT},
                {"role": "user", "content": user_msg},
            ],
        )
        data = json.loads(completion.choices[0].message.content or "{}")
    except json.JSONDecodeError:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="The AI returned malformed JSON.")
    except Exception as exc:  # network error, auth error, quota, timeout
        log.warning("OpenAI call failed: %s: %s", type(exc).__name__, exc)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"AI request failed: {type(exc).__name__}")

    raw = data.get("designs") if isinstance(data, dict) else None
    designs = []
    for i, d in enumerate(raw[:count] if isinstance(raw, list) else []):
        if not isinstance(d, dict):
            continue
        fallback_vessel = payload.vessel if payload.vessel in VESSEL_RANGES else "vase"
        edit = _validate_edit(d, {"vessel": "__none__"} if (d.get("changes") or {}).get("vessel") else {"vessel": fallback_vessel})
        if "vessel" not in edit.patch:
            edit.patch["vessel"] = fallback_vessel
        designs.append(VesselDesign(
            name=str(d.get("name") or f"Design {i + 1}")[:80],
            rationale=str(d.get("rationale") or "")[:300],
            patch=edit.patch,
            pattern=edit.pattern,
        ))
    if not designs:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="The AI returned no usable designs.")
    return VesselSuggestResponse(designs=designs, source="openai")


# --- Idea helper (Create page, step 1) --------------------------------------
class IdeaRequest(BaseModel):
    prompt: str = Field(default="", max_length=500)
    vessel: str | None = None


class IdeaResponse(BaseModel):
    idea: str


IDEA_PROMPT = """You help people describe a handmade ceramic piece for a pottery design app.
Write ONE idea in Thai, 1-2 short sentences (max ~140 characters), naming the
vessel type (แจกัน ชาม เหยือก จาน แก้วมัค or ประติมากรรม), its shape, a colour,
and a surface or texture. Shapes the app can make well include tall, squat,
flared, wonky lips, pedestals, twists, ovals, polygons and top-view outlines
like หัวใจ ดาว ดอกไม้ ก้อนเมฆ ใบโคลเวอร์ หยดน้ำ ใบไม้ เหลี่ยมมน.
If the user gave an idea, keep everything they asked for and make it more
specific. If they gave none, invent a fresh, charming idea (vary it each time).
Reply with ONLY JSON: {"idea": "..."}"""


@router.post("/idea", response_model=IdeaResponse)
def idea(payload: IdeaRequest, request: Request):
    if not settings.openai_api_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="OPENAI_API_KEY is not configured on the server.",
        )
    _rate_limit(request)
    from openai import OpenAI

    user_msg = f"User idea: {payload.prompt.strip() or '(none - surprise me)'}"
    if payload.vessel in VESSEL_RANGES:
        user_msg += f"\nVessel type to use: {payload.vessel}"
    user_msg += f"\nRandom seed: {time.time_ns() % 10000}"
    client = OpenAI(api_key=settings.openai_api_key, timeout=settings.openai_timeout_seconds)
    try:
        completion = client.chat.completions.create(
            model=settings.openai_model,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": IDEA_PROMPT},
                {"role": "user", "content": user_msg},
            ],
        )
        data = json.loads(completion.choices[0].message.content or "{}")
    except Exception as exc:  # network error, auth error, quota, timeout, bad JSON
        log.warning("OpenAI call failed: %s: %s", type(exc).__name__, exc)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"AI request failed: {type(exc).__name__}")
    text = str(data.get("idea") or "").strip() if isinstance(data, dict) else ""
    if not text:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="The AI returned no idea.")
    return IdeaResponse(idea=text[:300])
