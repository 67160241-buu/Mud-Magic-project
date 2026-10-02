// profile-editor.js — the side-profile curve editor (PotterDraw's spline bar).
//
// Drag a node to reshape the pot, click empty space to add a node, double-click
// (or right-click, or press Delete with a node selected) to remove one. The
// silhouette is mirrored about the centre axis so it reads like the finished
// pot. The vertical axis is height 0 (base) .. 1 (rim); the horizontal axis is
// radius, where 1.0 is the widest point of the pot (= the belly slider).
import { sampleProfileRaw, profileMax } from "./pot-mesh.js";

const COLORS = {
  bg: "#fcf2eb",
  grid: "rgba(134,115,109,0.18)",
  axis: "rgba(134,115,109,0.45)",
  fill: "rgba(166,93,69,0.13)",
  line: "#88452f",
  node: "#ffffff",
  nodeStroke: "#88452f",
  nodeSel: "#88452f",
  ghost: "rgba(134,115,109,0.55)",
};

const R_MAX = 1.15; // radius shown at the canvas edge
const HIT = 11; // px pick radius
const MIN_NODES = 3;

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{onChange?:(nodes:number[][])=>void, onCommit?:(nodes:number[][])=>void}} handlers
 */
export function createProfileEditor(canvas, handlers = {}) {
  const ctx = canvas.getContext("2d");
  let nodes = [];
  let selected = -1;
  let drag = -1;
  let max = 1; // radius normaliser held steady while dragging
  let dpr = 1;
  let W = 0;
  let H = 0;
  const PAD_X = 16;
  const PAD_Y = 16;

  const toPx = (r, y) => [W / 2 + (r / R_MAX) * (W / 2 - PAD_X), H - PAD_Y - y * (H - PAD_Y * 2)];
  const fromPx = (px, py) => [
    Math.max(0.05, Math.min(1, ((px - W / 2) / (W / 2 - PAD_X)) * R_MAX)),
    Math.max(0, Math.min(1, (H - PAD_Y - py) / (H - PAD_Y * 2))),
  ];

  function resize() {
    const rect = canvas.getBoundingClientRect();
    W = Math.max(120, Math.round(rect.width));
    H = Math.max(120, Math.round(rect.height));
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function emit(kind) {
    const out = nodes.map((p) => [p[0], p[1]]);
    if (kind === "commit") handlers.onCommit?.(out);
    else handlers.onChange?.(out);
  }

  /** Divide radii so the widest point is exactly 1 again. */
  function renormalise() {
    const m = profileMax(nodes);
    if (m > 1e-6 && Math.abs(m - 1) > 1e-3) nodes = nodes.map((p) => [p[0] / m, p[1]]);
    max = 1;
  }

  function sorted() {
    // keep node order by height without losing track of the selection
    const sel = selected >= 0 ? nodes[selected] : null;
    nodes.sort((a, b) => a[1] - b[1]);
    selected = sel ? nodes.indexOf(sel) : -1;
  }

  function curvePoints() {
    const n = 96;
    const raw = sampleProfileRaw(nodes, n);
    const m = Math.max(...raw);
    const out = [];
    for (let i = 0; i < n; i++) out.push([raw[i] / m, i / (n - 1)]);
    return out;
  }

  function draw() {
    if (!W) return;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W, H);

    // horizontal guides every 25% of height
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const [, y] = toPx(0, i / 4);
      ctx.beginPath();
      ctx.moveTo(PAD_X / 2, Math.round(y) + 0.5);
      ctx.lineTo(W - PAD_X / 2, Math.round(y) + 0.5);
      ctx.stroke();
    }
    // centre axis
    ctx.strokeStyle = COLORS.axis;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(W / 2, PAD_Y / 2);
    ctx.lineTo(W / 2, H - PAD_Y / 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // silhouette
    const pts = curvePoints();
    ctx.beginPath();
    pts.forEach(([r, y], i) => {
      const [x, py] = toPx(r, y);
      i ? ctx.lineTo(x, py) : ctx.moveTo(x, py);
    });
    for (let i = pts.length - 1; i >= 0; i--) {
      const [x, py] = toPx(-pts[i][0], pts[i][1]);
      ctx.lineTo(x, py);
    }
    ctx.closePath();
    ctx.fillStyle = COLORS.fill;
    ctx.fill();

    ctx.lineWidth = 2;
    ctx.strokeStyle = COLORS.line;
    ctx.lineJoin = "round";
    ctx.beginPath();
    pts.forEach(([r, y], i) => {
      const [x, py] = toPx(r, y);
      i ? ctx.lineTo(x, py) : ctx.moveTo(x, py);
    });
    ctx.stroke();
    ctx.strokeStyle = COLORS.ghost;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    pts.forEach(([r, y], i) => {
      const [x, py] = toPx(-r, y);
      i ? ctx.lineTo(x, py) : ctx.moveTo(x, py);
    });
    ctx.stroke();

    // nodes (normalised so they sit on the drawn curve)
    nodes.forEach((p, i) => {
      const [x, y] = toPx(p[0] / max, p[1]);
      ctx.beginPath();
      ctx.arc(x, y, i === selected ? 6.5 : 5, 0, Math.PI * 2);
      ctx.fillStyle = i === selected ? COLORS.nodeSel : COLORS.node;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = COLORS.nodeStroke;
      ctx.stroke();
    });

    ctx.fillStyle = "rgba(84,67,62,0.7)";
    ctx.font = "11px 'Noto Sans Thai', 'DM Sans', sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("ปากภาชนะ", 8, 12);
    ctx.fillText("ก้นภาชนะ", 8, H - 5);
  }

  function pickNode(px, py) {
    let best = -1;
    let bestD = HIT * HIT;
    nodes.forEach((p, i) => {
      const [x, y] = toPx(p[0] / max, p[1]);
      const d = (x - px) ** 2 + (y - py) ** 2;
      if (d <= bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  function local(e) {
    const rect = canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  function removeNode(i) {
    if (i < 0 || nodes.length <= MIN_NODES) return false;
    nodes.splice(i, 1);
    selected = -1;
    renormalise();
    draw();
    emit("commit");
    return true;
  }

  function onDown(e) {
    if (e.button === 2) return;
    const [px, py] = local(e);
    const hit = pickNode(px, py);
    max = profileMax(nodes);
    if (hit >= 0) {
      selected = hit;
      drag = hit;
    } else {
      const [r, y] = fromPx(px, py);
      nodes.push([r * max, y]);
      sorted();
      selected = nodes.findIndex((p) => p[0] === r * max && p[1] === y);
      drag = selected;
      emit("change");
    }
    canvas.setPointerCapture?.(e.pointerId);
    draw();
    e.preventDefault();
  }

  function onMove(e) {
    if (drag < 0) {
      const [px, py] = local(e);
      canvas.style.cursor = pickNode(px, py) >= 0 ? "grab" : "crosshair";
      return;
    }
    canvas.style.cursor = "grabbing";
    const [px, py] = local(e);
    const [r, y] = fromPx(px, py);
    const node = nodes[drag];
    node[0] = r * max;
    const isFirst = drag === 0;
    const isLast = drag === nodes.length - 1;
    if (isFirst) node[1] = 0;
    else if (isLast) node[1] = 1;
    else {
      const lo = nodes[drag - 1][1] + 0.02;
      const hi = nodes[drag + 1][1] - 0.02;
      node[1] = Math.max(lo, Math.min(hi, y));
    }
    draw();
    emit("change");
  }

  function onUp(e) {
    if (drag < 0) return;
    drag = -1;
    canvas.releasePointerCapture?.(e.pointerId);
    renormalise();
    draw();
    emit("commit");
  }

  function onDouble(e) {
    const [px, py] = local(e);
    removeNode(pickNode(px, py));
  }

  function onContext(e) {
    const [px, py] = local(e);
    const hit = pickNode(px, py);
    if (hit >= 0) {
      e.preventDefault();
      removeNode(hit);
    }
  }

  function onKey(e) {
    if ((e.key === "Delete" || e.key === "Backspace") && selected >= 0) {
      e.preventDefault();
      removeNode(selected);
    }
  }

  canvas.tabIndex = 0;
  canvas.style.touchAction = "none";
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("dblclick", onDouble);
  canvas.addEventListener("contextmenu", onContext);
  canvas.addEventListener("keydown", onKey);
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);

  return {
    /** Replace the nodes (e.g. after switching vessel). Does not fire callbacks. */
    setNodes(next) {
      nodes = next.map((p) => [p[0], p[1]]).sort((a, b) => a[1] - b[1]);
      selected = -1;
      renormalise();
      draw();
    },
    getNodes() {
      return nodes.map((p) => [p[0], p[1]]);
    },
    deleteSelected() {
      return removeNode(selected);
    },
    hasSelection() {
      return selected >= 0;
    },
    redraw: draw,
    destroy() {
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("dblclick", onDouble);
      canvas.removeEventListener("contextmenu", onContext);
      canvas.removeEventListener("keydown", onKey);
    },
  };
}
