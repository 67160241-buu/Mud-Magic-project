// wave.js — periodic waveform + motif + power math used to modulate the
// pot's radius per ring (height) and per side (angle).
//
// Ported from PotterDraw by Chris Korda (GPL-2.0-or-later), specifically
// CPotGraphics::GetWave / ApplyMotif / ApplyPower in PotGraphics.cpp.
// Source: http://potterdraw.sourceforge.net/
// Because this is a derivative of GPL-2.0 code, this file — and any build
// that links it — carries the GPL-2.0-or-later terms. See LICENSE-POTTERDRAW.
//
// The original is C++/DirectX desktop code; this is a hand port of just the
// scalar math to plain JS. No PotterDraw binaries or DirectX code are used.

/** Wrap to [0,1). PotterDraw's Wrap1(). */
function wrap1(x) {
  return x - Math.floor(x);
}
const sq = (x) => x * x;
const TAU = Math.PI * 2;

export const WAVEFORMS = [
  "sine",
  "triangle",
  "rampUp",
  "rampDown",
  "square",
  "pulse",
  "roundedPulse",
  "circularPulse",
  "triangularPulse",
  "rampPulse",
  "sineCubed",
  "flame",
  "semicircle",
];

/**
 * Bipolar waveform in roughly [-1,1].
 * @param {string} waveform one of WAVEFORMS
 * @param {number} phase cycles (not radians); 1.0 == one full cycle
 * @param {number} pulseWidth 0..1, pulse waveforms only
 * @param {number} slew 0..1, pulse edge softness
 */
export function getWave(waveform, phase, pulseWidth = 0.5, slew = 0.5) {
  switch (waveform) {
    case "sine":
      return Math.sin(phase * TAU);

    case "triangle": {
      const r = wrap1(phase + 0.25) * 4;
      return r < 2 ? r - 1 : 3 - r;
    }

    case "rampUp":
      return wrap1(phase) * 2 - 1;

    case "rampDown":
      return 1 - wrap1(phase) * 2;

    case "square":
      return wrap1(phase) < 0.5 ? 1 : -1;

    case "pulse": {
      const r = wrap1(phase);
      const a = (pulseWidth / 2) * slew;
      if (r < a) return (r / a) * 2 - 1;
      if (r < pulseWidth - a) return 1;
      if (r < pulseWidth) return 1 - ((r - (pulseWidth - a)) / a) * 2;
      return -1;
    }

    case "roundedPulse": {
      const r = wrap1(phase);
      const a = (pulseWidth / 2) * slew;
      if (r < a) return Math.cos((r / a + 1) * Math.PI);
      if (r < pulseWidth - a) return 1;
      if (r < pulseWidth) return Math.cos(((r - (pulseWidth - a)) / a) * Math.PI);
      return -1;
    }

    case "circularPulse": {
      const r = wrap1(phase);
      const a = (pulseWidth / 2) * slew;
      if (r < a) return Math.sqrt(1 - sq(1 - r / a)) * 2 - 1;
      if (r < pulseWidth - a) return 1;
      if (r < pulseWidth) return Math.sqrt(1 - sq((r - (pulseWidth - a)) / a)) * 2 - 1;
      return -1;
    }

    case "triangularPulse": {
      const r = wrap1(phase);
      if (r < pulseWidth) {
        let t;
        if (r < pulseWidth * slew) t = r / (pulseWidth * slew);
        else t = (r - pulseWidth) / (pulseWidth * (slew - 1));
        return t * 2 - 1;
      }
      return -1;
    }

    case "rampPulse": {
      const r = wrap1(phase);
      const a = (pulseWidth / 2) * slew;
      if (r < a) return r / a;
      if (r < pulseWidth - a) return 1 - ((r - a) / (pulseWidth - a * 2)) * 2;
      if (r < pulseWidth) return (r - (pulseWidth - a)) / a - 1;
      return 0;
    }

    case "sineCubed":
      return Math.pow(Math.sin(phase * TAU), 3);

    case "flame": {
      const r = wrap1(phase + 0.25);
      const s = Math.sin(r * TAU);
      if (r < 0.25) return s - 1;
      if (r < 0.5) return 1 - s;
      if (r < 0.75) return s + 1;
      return -1 - s;
    }

    case "semicircle": {
      let r = wrap1(phase);
      let sign;
      if (r < 0.5) {
        sign = 1;
      } else {
        r -= 0.5;
        sign = -1;
      }
      return Math.sqrt(1 - sq(r * 4 - 1)) * sign;
    }

    default:
      return 0;
  }
}

export const MOTIFS = ["none", "invert", "reeds", "flutes", "partedReeds", "partedFlutes"];

/**
 * Reshapes a bipolar wave into a decorative motif. "reeds" = raised ribs
 * (all outward), "flutes" = carved grooves (all inward), "parted" variants
 * keep only one polarity so the untouched half stays perfectly round.
 */
export function applyMotif(motif, r) {
  switch (motif) {
    case "invert":
      return -r;
    case "reeds":
      return Math.abs(r);
    case "flutes":
      return -Math.abs(r);
    case "partedReeds":
      return Math.max(r, 0);
    case "partedFlutes":
      return Math.min(r, 0);
    default:
      return r;
  }
}

/**
 * Exponential/logarithmic shaping of the wave, which sharpens peaks or
 * flattens them. PotterDraw's ApplyPower, bipolar branch only (the
 * unipolar branch isn't used by the modulations exposed in the UI here).
 */
export function applyPower(power, r) {
  if (!power || power === 1) return r;
  const sign = r < 0 ? -1 : 1;
  const mag = Math.abs(r);
  if (power > 0) {
    const scale = power - 1;
    if (!scale) return r;
    return sign * ((Math.pow(power, mag) - 1) / scale);
  }
  // negative power == logarithmic
  const p = -power;
  const scale = p - 1;
  if (!scale) return r;
  return sign * (Math.log(mag * scale + 1) / Math.log(p));
}

export const OPERATIONS = ["add", "subtract", "multiply", "divide", "exponentiate"];

/** Combine a modulation amount `r` into a base radius. */
export function applyOperation(operation, radius, r) {
  switch (operation) {
    case "subtract":
      return radius - r;
    case "multiply":
      return r >= 0 ? radius * (r + 1) : radius / (1 - r);
    case "divide":
      return r >= 0 ? radius / (r + 1) : radius * (1 - r);
    case "exponentiate":
      return radius * Math.pow(2, r);
    default:
      return radius + r;
  }
}

export const DEFAULT_MODULATION = {
  // scallops: radius varies around the circumference (vertical ribs/flutes)
  scallops: 0, // 0 == off; otherwise cycles around the pot
  scallopWaveform: "sine",
  scallopMotif: "none",
  scallopDepth: 0.04,
  scallopPhase: 0,
  scallopPower: 1,
  scallopOperation: "add",
  scallopPulseWidth: 0.5,
  scallopSlew: 0.5,

  // ripples: radius varies with height (horizontal throwing rings)
  ripples: 0, // 0 == off; otherwise cycles up the height
  rippleWaveform: "sine",
  rippleMotif: "none",
  rippleDepth: 0.02,
  ripplePhase: 0,
  ripplePower: 1,
  rippleOperation: "add",
  ripplePulseWidth: 0.5,
  rippleSlew: 0.5,

  // ruffles: scallop count/phase itself drifts with height, so ribs wander
  // — this is what gives PotterDraw's wavy-rim, twisted-flute look.
  ruffles: 0, // 0 == off
  ruffleWaveform: "sine",
  ruffleMotif: "none",
  ruffleDepth: 0.35,
  rufflePhase: 0,
  rufflePulseWidth: 0.5,
  ruffleSlew: 0.5,
};

/** True when the modulation settings would actually change the silhouette. */
export function hasModulation(mod) {
  if (!mod) return false;
  const scallop = mod.scallops > 0 && mod.scallopDepth !== 0;
  const ripple = mod.ripples > 0 && mod.rippleDepth !== 0;
  return scallop || ripple;
}

/**
 * Radius multiplier/offset for one vertex of the revolve.
 * @param {number} radius base profile radius at this ring
 * @param {number} ring normalised height 0..1 (bottom -> top)
 * @param {number} side normalised angle 0..1 around the pot
 */
export function modulateRadius(radius, ring, side, mod) {
  let out = radius;

  if (mod.ripples > 0 && mod.rippleDepth !== 0) {
    let r = getWave(mod.rippleWaveform, ring * mod.ripples + mod.ripplePhase, mod.ripplePulseWidth, mod.rippleSlew);
    r = applyMotif(mod.rippleMotif, r);
    r = applyPower(mod.ripplePower, r);
    out = applyOperation(mod.rippleOperation, out, r * mod.rippleDepth);
  }

  if (mod.scallops > 0 && mod.scallopDepth !== 0) {
    // Ruffle drifts the scallop phase as we climb, twisting the ribs.
    let phase = side * mod.scallops + mod.scallopPhase;
    if (mod.ruffles > 0 && mod.ruffleDepth !== 0) {
      let ruf = getWave(mod.ruffleWaveform, ring * mod.ruffles + mod.rufflePhase, mod.rufflePulseWidth, mod.ruffleSlew);
      ruf = applyMotif(mod.ruffleMotif, ruf);
      phase += ruf * mod.ruffleDepth;
    }
    // +0.25 emulates cosine, matching PotterDraw's scallop convention so a
    // rib (not a valley) sits at phase 0.
    let r = getWave(mod.scallopWaveform, phase + 0.25, mod.scallopPulseWidth, mod.scallopSlew);
    r = applyMotif(mod.scallopMotif, r);
    r = applyPower(mod.scallopPower, r);
    out = applyOperation(mod.scallopOperation, out, r * mod.scallopDepth);
  }

  return Math.max(out, 0.0005); // never let radius cross the axis
}
