// skill-fit.js — ease a design down until it fits a skill level.
import { SKILLS, assess, normalizeConfig } from "./vessels.js";

/**
 * Strip difficulty from a design — one change at a time, most decorative first —
 * until it fits `skillId`. The vessel type is never changed, so what the person
 * asked for stays what they get. Returns `{config, changed, fits}`.
 */
export function simplifyForSkill(base, skillId) {
  const tier = SKILLS.find((s) => s.id === skillId) || SKILLS[1];
  const c = normalizeConfig(base);
  const steps = [
    (x) => { x.lab.helixFreq = 0; x.lab.bends = 0; },
    (x) => { x.lab.polySides = 0; },
    (x) => { x.modulation = null; },
    (x) => { x.lab.nodes = null; x.lab.twist = 0; x.lab.aspect = 1; },
    (x) => { x.neck = "clean"; },
    (x) => { x.texture = "thrown"; },
    (x) => { if (x.handle === "ear") x.handle = "loop"; },
    (x) => { if (x.surface === "smooth") x.surface = "matte"; },
    (x) => { x.foot = "flat"; },
    (x) => { if (x.vessel !== "mug" && x.vessel !== "pitcher") x.handle = "none"; },
    (x) => { x.surface = "rough"; },
    (x) => { x.handle = "none"; },
  ];
  let changed = false;
  for (const step of steps) {
    if (assess(c, skillId).d5 <= tier.max) break;
    const before = JSON.stringify(c);
    step(c);
    if (JSON.stringify(c) !== before) changed = true;
  }
  const out = normalizeConfig(c);
  return { config: out, changed, fits: assess(out, skillId).d5 <= tier.max };
}
