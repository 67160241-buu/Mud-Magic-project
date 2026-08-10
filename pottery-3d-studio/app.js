/* =========================================================
   CONSTANTS
   ========================================================= */
const N_POINTS = 16;          // จำนวนจุดควบคุมของ profile (ฐาน..ปาก)
const MAX_RADIUS = 1.3;       // หน่วยโลก 3D
const MIN_RADIUS = 0.05;
const BASE_HEIGHT = 2.6;      // หน่วยโลก 3D ที่ heightRatio = 1

const PATTERN_NAMES = {
  floral:'ลายดอกไม้', geometric:'ลายเรขาคณิต', wave:'ลายคลื่น',
  dots:'ลายจุด', minimal_line:'เส้นมินิมอล', glaze_drip:'เคลือบหยดไหล',
};
const PATTERN_ORDER = ['minimal_line','dots','wave','geometric','floral','glaze_drip'];

// รูปทรงเริ่มต้น (ก้อนดินตั้งต้น) — เป็นทรงแจกันอ่อนๆ ให้จับต้องสร้างต่อได้ทันที
const DEFAULT_PROFILE = [0.30,0.27,0.30,0.40,0.50,0.58,0.63,0.62,0.56,0.48,0.40,0.34,0.30,0.27,0.26,0.29];

const PRESETS = {
  blank:   { label:'ก้อนดินเปล่า', emoji:'⚪', profile:[0.32,0.32,0.32,0.32,0.32,0.32,0.32,0.32,0.32,0.32,0.32,0.32,0.32,0.32,0.32,0.32], heightRatio:1, pattern:'minimal_line' },
  vase:    { label:'แจกัน', emoji:'🏺', profile:[0.24,0.20,0.34,0.50,0.62,0.68,0.65,0.58,0.50,0.42,0.36,0.32,0.29,0.27,0.26,0.28], heightRatio:1.15, pattern:'wave' },
  bowl:    { label:'ชาม', emoji:'🥣', profile:[0.10,0.16,0.26,0.36,0.45,0.52,0.58,0.62,0.65,0.68,0.70,0.72,0.73,0.74,0.75,0.76], heightRatio:0.5, pattern:'dots' },
  jar:     { label:'โถมีฝา', emoji:'🍶', profile:[0.16,0.14,0.30,0.50,0.66,0.74,0.78,0.76,0.66,0.50,0.34,0.22,0.16,0.14,0.15,0.19], heightRatio:1.1, pattern:'geometric' },
  cup:     { label:'แก้ว/มัค', emoji:'☕', profile:[0.30,0.30,0.31,0.31,0.32,0.32,0.33,0.33,0.34,0.34,0.35,0.35,0.36,0.37,0.38,0.40], heightRatio:0.85, pattern:'minimal_line' },
  plate:   { label:'จาน', emoji:'🍽️', profile:[0.20,0.55,0.75,0.85,0.90,0.92,0.93,0.93,0.93,0.92,0.90,0.88,0.85,0.78,0.60,0.35], heightRatio:0.18, pattern:'floral' },
  planter: { label:'กระถางต้นไม้', emoji:'🪴', profile:[0.32,0.34,0.38,0.44,0.50,0.55,0.60,0.64,0.68,0.71,0.74,0.76,0.78,0.79,0.80,0.80], heightRatio:0.95, pattern:'geometric' },
};

const DEFAULT_COLORS = { primary:'#C9AD8C', accent:'#54634F' };

/* =========================================================
   STATE
   ========================================================= */
const state = {
  controlPoints: DEFAULT_PROFILE.map(v => v * MAX_RADIUS),
  heightRatio: 1,
  density: 1,
  pattern: 'wave',
  primary: DEFAULT_COLORS.primary,
  accent: DEFAULT_COLORS.accent,
  idea: '',
  aiLoading: false,
  aiError: '',
  aiWhy: '',
};

const historyStack = [];
function pushHistory(){
  historyStack.push({
    controlPoints: state.controlPoints.slice(),
    heightRatio: state.heightRatio,
  });
  if(historyStack.length > 30) historyStack.shift();
  updateUndoButton();
}
function undo(){
  if(historyStack.length === 0) return;
  const prev = historyStack.pop();
  state.controlPoints = prev.controlPoints;
  state.heightRatio = prev.heightRatio;
  syncHeightSlider();
  rebuildAll();
  updateUndoButton();
}
function updateUndoButton(){
  const btn = document.getElementById('undoBtn');
  if(btn) btn.disabled = historyStack.length === 0;
}

/* =========================================================
   GEOMETRY (three.js LatheGeometry — ปั้นด้วยการหมุนรอบแกนจริง)
   ========================================================= */
function buildLatheProfilePoints(controlPoints, heightRatio){
  const H = BASE_HEIGHT * heightRatio;
  const n = controlPoints.length;
  const pts = [];
  for(let i=0;i<n;i++){
    const y = (i/(n-1)) * H; // index 0 = ฐาน (y=0), index n-1 = ปาก (y=H)
    const r = Math.max(MIN_RADIUS, controlPoints[i]);
    pts.push(new THREE.Vector2(r, y));
  }
  return pts;
}
function buildLatheGeometry(controlPoints, heightRatio){
  return new THREE.LatheGeometry(buildLatheProfilePoints(controlPoints, heightRatio), 56);
}

/* =========================================================
   PATTERN TEXTURE (Canvas 2D → CanvasTexture)
   ========================================================= */
function drawPatternOnCanvas(ctx, size, patternType, primary, accent, density){
  ctx.fillStyle = primary;
  ctx.fillRect(0,0,size,size);
  const tile = Math.max(16, 40/(density||1));
  ctx.strokeStyle = accent; ctx.fillStyle = accent;
  for(let y=0; y<size+tile; y+=tile){
    for(let x=0; x<size+tile; x+=tile){
      ctx.save();
      ctx.translate(x,y);
      switch(patternType){
        case 'dots':
          ctx.beginPath(); ctx.arc(tile/2, tile/2, tile*0.11, 0, Math.PI*2); ctx.fill();
          break;
        case 'geometric':
          ctx.save(); ctx.translate(tile/2,tile/2); ctx.rotate(Math.PI/4);
          ctx.lineWidth = Math.max(1, tile*0.05); ctx.strokeRect(-tile*0.22,-tile*0.22, tile*0.44, tile*0.44);
          ctx.restore();
          break;
        case 'wave':
          ctx.lineWidth = Math.max(1, tile*0.06);
          ctx.beginPath();
          ctx.moveTo(0, tile*0.5);
          ctx.quadraticCurveTo(tile*0.25, tile*0.18, tile*0.5, tile*0.5);
          ctx.quadraticCurveTo(tile*0.75, tile*0.82, tile, tile*0.5);
          ctx.stroke();
          break;
        case 'floral':
          ctx.globalAlpha = 0.9;
          [[tile*0.5,tile*0.3],[tile*0.5,tile*0.7],[tile*0.3,tile*0.5],[tile*0.7,tile*0.5]].forEach(([ex,ey])=>{
            ctx.beginPath(); ctx.ellipse(ex,ey, tile*0.09, tile*0.16, Math.atan2(ey-tile*0.5, ex-tile*0.5)+Math.PI/2, 0, Math.PI*2); ctx.fill();
          });
          ctx.beginPath(); ctx.arc(tile*0.5, tile*0.5, tile*0.07, 0, Math.PI*2); ctx.fill();
          ctx.globalAlpha = 1;
          break;
        case 'glaze_drip':
          ctx.lineWidth = Math.max(1, tile*0.07); ctx.globalAlpha = 0.85;
          ctx.beginPath(); ctx.moveTo(tile*0.25,0); ctx.bezierCurveTo(tile*0.18,tile*0.5, tile*0.32,tile*0.6, tile*0.25,tile); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(tile*0.68,0); ctx.bezierCurveTo(tile*0.6,tile*0.4, tile*0.76,tile*0.55, tile*0.68,tile); ctx.stroke();
          ctx.globalAlpha = 1;
          break;
        case 'minimal_line':
        default:
          ctx.lineWidth = Math.max(1, tile*0.04); ctx.globalAlpha = 0.75;
          ctx.beginPath(); ctx.moveTo(0, tile*0.5); ctx.lineTo(tile, tile*0.5); ctx.stroke();
          ctx.globalAlpha = 1;
          break;
      }
      ctx.restore();
    }
  }
}
function makePatternTexture(patternType, primary, accent, density){
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  drawPatternOnCanvas(ctx, size, patternType, primary, accent, density);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping; texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(3, 4);
  texture.needsUpdate = true;
  return texture;
}

function clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }

/* =========================================================
   3D SCENE — สร้างชิ้นงาน, กล้อง, แสง, แท่นหมุน
   ========================================================= */
let scene3d = null; // { renderer, scene, camera, piece, body, mat, ... }

function makePieceGroup(){
  const group = new THREE.Group();
  const bodyGeo = buildLatheGeometry(state.controlPoints, state.heightRatio);
  const tex = makePatternTexture(state.pattern, state.primary, state.accent, state.density);
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness:0.55, metalness:0.06, side: THREE.DoubleSide });
  const body = new THREE.Mesh(bodyGeo, mat);
  group.add(body);
  return { group, body, mat };
}

function disposeScene3d(){
  if(!scene3d) return;
  if(scene3d.animId) cancelAnimationFrame(scene3d.animId);
  const dom = scene3d.renderer.domElement;
  if(scene3d._listeners){
    const L = scene3d._listeners;
    dom.removeEventListener('pointerdown', L.onDown);
    dom.removeEventListener('pointermove', L.onMove);
    dom.removeEventListener('pointerup', L.onUp);
    dom.removeEventListener('pointerleave', L.onUp);
    dom.removeEventListener('wheel', L.onWheel);
  }
  if(scene3d.onResize) window.removeEventListener('resize', scene3d.onResize);
  scene3d.scene.traverse(obj=>{
    if(obj.geometry) obj.geometry.dispose();
    if(obj.material){ if(obj.material.map) obj.material.map.dispose(); obj.material.dispose(); }
  });
  scene3d.renderer.dispose();
  if(dom.parentNode) dom.parentNode.removeChild(dom);
  scene3d = null;
}

function screenPosOfWorldPoint(worldVec, camera, rect){
  const p = worldVec.clone().project(camera);
  return {
    x: rect.left + (p.x*0.5+0.5)*rect.width,
    y: rect.top + (-p.y*0.5+0.5)*rect.height,
  };
}

function initScene3d(containerId){
  if(typeof THREE === 'undefined') return null;
  const container = document.getElementById(containerId);
  if(!container) return null;
  const w = container.clientWidth || 600, h = container.clientHeight || 500;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, w/h, 0.1, 100);
  const renderer = new THREE.WebGLRenderer({ antialias:true, alpha:true, preserveDrawingBuffer:true });
  renderer.setSize(w,h);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio||1, 2));
  container.appendChild(renderer.domElement);

  scene.add(new THREE.AmbientLight(0xffffff, 0.65));
  const key = new THREE.DirectionalLight(0xfff3e0, 0.9); key.position.set(3,5,4); scene.add(key);
  const fillL = new THREE.DirectionalLight(0xdfe8ff, 0.35); fillL.position.set(-4,2,-3); scene.add(fillL);

  const pedestal = new THREE.Mesh(
    new THREE.CylinderGeometry(1.6, 1.7, 0.22, 48),
    new THREE.MeshStandardMaterial({ color:0xC9AD8C, roughness:0.85 })
  );
  pedestal.position.y = -0.11;
  scene.add(pedestal);

  const { group: piece, body, mat } = makePieceGroup();
  scene.add(piece);

  const inst = {
    renderer, scene, camera, piece, body, mat, container,
    theta: 0.6, phi: 1.15, radius: 4.6,
    dragging:false, lastX:0, lastY:0, animId:null,
    sculpt: { active:false },
    raycaster: new THREE.Raycaster(),
  };

  inst.updateCamera = function(){
    const targetY = (BASE_HEIGHT*state.heightRatio)/2;
    const x = inst.radius*Math.sin(inst.phi)*Math.sin(inst.theta);
    const y = inst.radius*Math.cos(inst.phi) + targetY*0.5;
    const z = inst.radius*Math.sin(inst.phi)*Math.cos(inst.theta);
    camera.position.set(x,y,z);
    camera.lookAt(0, targetY*0.5, 0);
  };
  inst.updateCamera();

  const dom = renderer.domElement;

  function ndcFromEvent(e){
    const rect = dom.getBoundingClientRect();
    return new THREE.Vector2(
      ((e.clientX-rect.left)/rect.width)*2-1,
      -((e.clientY-rect.top)/rect.height)*2+1
    );
  }

  const onDown = (e)=>{
    const ndc = ndcFromEvent(e);
    inst.raycaster.setFromCamera(ndc, camera);
    const hits = inst.raycaster.intersectObject(inst.body, false);
    if(hits.length > 0){
      pushHistory();
      const hitWorld = hits[0].point.clone();
      const local = inst.piece.worldToLocal(hitWorld.clone());
      const H = BASE_HEIGHT * state.heightRatio;
      const n = state.controlPoints.length;
      let grabIndex = Math.round((local.y/H) * (n-1));
      grabIndex = clamp(grabIndex, 0, n-1);

      const axisWorld = inst.piece.localToWorld(new THREE.Vector3(0, local.y, 0));
      const rect = dom.getBoundingClientRect();
      const axisScreen = screenPosOfWorldPoint(axisWorld, camera, rect);
      const dx0 = e.clientX - axisScreen.x, dy0 = e.clientY - axisScreen.y;
      const startDist = Math.max(6, Math.hypot(dx0, dy0));

      inst.sculpt = {
        active:true,
        grabIndex,
        axisScreen,
        startDist,
        startRadii: state.controlPoints.slice(),
      };
      container.classList.add('sculpting');
      try{ dom.setPointerCapture(e.pointerId); }catch(err){}
      return;
    }
    // ไม่โดนชิ้นงาน -> หมุนกล้องแทน
    inst.dragging = true; inst.lastX = e.clientX; inst.lastY = e.clientY;
    container.classList.add('dragging');
    try{ dom.setPointerCapture(e.pointerId); }catch(err){}
  };

  const onMove = (e)=>{
    if(inst.sculpt.active){
      const dx = e.clientX - inst.sculpt.axisScreen.x;
      const dy = e.clientY - inst.sculpt.axisScreen.y;
      const dist = Math.max(4, Math.hypot(dx,dy));
      const ratio = dist / inst.sculpt.startDist;
      const n = state.controlPoints.length;
      const idx = inst.sculpt.grabIndex;
      const sigma = 1.35;
      const startVal = inst.sculpt.startRadii[idx];
      const targetVal = clamp(startVal * ratio, MIN_RADIUS, MAX_RADIUS*1.15);
      for(let j=0;j<n;j++){
        const influence = Math.exp(-((j-idx)**2)/(2*sigma*sigma));
        const base = inst.sculpt.startRadii[j];
        const newVal = base + (targetVal - startVal) * influence;
        state.controlPoints[j] = clamp(newVal, MIN_RADIUS, MAX_RADIUS*1.15);
      }
      rebuildGeometryOnly(inst);
      updateDifficultyReadout();
      return;
    }
    if(inst.dragging){
      const dx = e.clientX-inst.lastX, dy = e.clientY-inst.lastY;
      inst.theta -= dx*0.008;
      inst.phi = clamp(inst.phi - dy*0.008, 0.35, Math.PI-0.35);
      inst.lastX = e.clientX; inst.lastY = e.clientY;
      inst.updateCamera();
    }
  };

  const onUp = ()=>{
    if(inst.sculpt.active){
      inst.sculpt.active = false;
      container.classList.remove('sculpting');
    }
    if(inst.dragging){
      inst.dragging = false;
      container.classList.remove('dragging');
    }
  };

  const onWheel = (e)=>{
    e.preventDefault();
    inst.radius = clamp(inst.radius*(1+e.deltaY*0.0012), 2.6, 8);
    inst.updateCamera();
  };

  dom.addEventListener('pointerdown', onDown);
  dom.addEventListener('pointermove', onMove);
  dom.addEventListener('pointerup', onUp);
  dom.addEventListener('pointerleave', onUp);
  dom.addEventListener('wheel', onWheel, { passive:false });
  inst._listeners = { onDown, onMove, onUp, onWheel };

  inst.onResize = function(){
    const cw = container.clientWidth, ch = container.clientHeight;
    if(!cw||!ch) return;
    camera.aspect = cw/ch; camera.updateProjectionMatrix();
    renderer.setSize(cw,ch);
  };
  window.addEventListener('resize', inst.onResize);

  let autoRotate = true;
  inst.setAutoRotate = (v)=>{ autoRotate = v; };
  inst.getAutoRotate = ()=> autoRotate;

  (function animate(){
    inst.animId = requestAnimationFrame(animate);
    if(!inst.dragging && !inst.sculpt.active && autoRotate){ inst.theta += 0.0016; inst.updateCamera(); }
    renderer.render(scene, camera);
  })();

  return inst;
}

function rebuildGeometryOnly(inst){
  inst.body.geometry.dispose();
  inst.body.geometry = buildLatheGeometry(state.controlPoints, state.heightRatio);
}
function rebuildTextureOnly(inst){
  if(inst.mat.map) inst.mat.map.dispose();
  inst.mat.map = makePatternTexture(state.pattern, state.primary, state.accent, state.density);
  inst.mat.needsUpdate = true;
}
function rebuildAll(){
  if(!scene3d) return;
  rebuildGeometryOnly(scene3d);
  rebuildTextureOnly(scene3d);
  scene3d.updateCamera();
  updateDifficultyReadout();
}

/* =========================================================
   DIFFICULTY READOUT (ให้ข้อมูลอย่างเดียว ไม่บล็อกอะไร)
   ========================================================= */
function estimateDifficulty(){
  const cp = state.controlPoints;
  let roughness = 0;
  for(let i=1;i<cp.length;i++){
    roughness += Math.abs(cp[i]-cp[i-1]) / MAX_RADIUS;
  }
  roughness /= (cp.length-1);
  const sizeFactor = Math.abs(state.heightRatio - 1);
  const minR = Math.min(...cp) / MAX_RADIUS;
  const thinWallFactor = minR < 0.15 ? (0.15-minR)*3 : 0;
  const raw = 1 + roughness*10 + sizeFactor*1.6 + thinWallFactor*4;
  return clamp(Math.round(raw), 1, 5);
}
function difficultyStars(n){ return '●'.repeat(n) + '○'.repeat(5-n); }
function updateDifficultyReadout(){
  const el = document.getElementById('diffReadout');
  if(!el) return;
  const d = estimateDifficulty();
  el.innerHTML = `ความยากโดยประมาณ <span class="stars">${difficultyStars(d)}</span> ${d}/5`;
}

/* =========================================================
   PRESETS / RESET / SMOOTH
   ========================================================= */
function applyPreset(key){
  const p = PRESETS[key];
  if(!p) return;
  pushHistory();
  state.controlPoints = p.profile.map(v => v*MAX_RADIUS);
  state.heightRatio = p.heightRatio;
  state.pattern = p.pattern;
  syncHeightSlider();
  syncPatternButtons();
  rebuildAll();
}
function resetToBlank(){ applyPreset('blank'); }

function smoothProfile(){
  pushHistory();
  const cp = state.controlPoints;
  const n = cp.length;
  const smoothed = cp.map((v,i)=>{
    const prev = cp[Math.max(0,i-1)];
    const next = cp[Math.min(n-1,i+1)];
    return (prev + v*2 + next) / 4;
  });
  state.controlPoints = smoothed;
  rebuildAll();
}

/* =========================================================
   AI: ให้ Claude ช่วยขึ้นทรงเริ่มต้นจากไอเดีย
   ========================================================= */
async function requestAiShape(){
  const idea = state.idea.trim();
  if(!idea){
    setAiStatus('พิมพ์ไอเดียสั้นๆ ก่อน เช่น "แจกันคอคอดลายคลื่น"', true);
    return;
  }
  state.aiLoading = true;
  setAiButtonLoading(true);
  setAiStatus('AI กำลังขึ้นทรงเริ่มต้นให้...', false);

  const system = `คุณเป็นผู้ช่วยออกแบบเซรามิก ตอบกลับเป็น JSON object เดียวเท่านั้น ห้ามมีข้อความอื่นนอกเหนือจาก JSON ห้ามใช้ markdown code block
สร้างโครงร่างภาชนะเซรามิกจากไอเดียของผู้ใช้ โดย object ต้องมี field ดังนี้เท่านั้น:
- control_points: array ตัวเลข 16 ตัว แต่ละตัวอยู่ระหว่าง 0.05 ถึง 1.0 แทนรัศมีสัมพัทธ์ของภาชนะที่ความสูงนั้นๆ
  index 0 คือฐาน (ล่างสุด), index 15 คือปากภาชนะ (บนสุด) ให้ไล่ค่าอย่างมีความหมายตามรูปทรงที่อธิบาย (เช่นคอคอดต้องมีค่าที่ลดลงตรงกลางบนแล้วอาจผายออกที่ปาก)
- height_ratio: ตัวเลข 0.5 ถึง 1.8 (สัดส่วนความสูง)
- pattern_type: ต้องเป็นค่าใดค่าหนึ่งจาก ["floral","geometric","wave","dots","minimal_line","glaze_drip"] เท่านั้น
- primary_color: hex color สีหลักที่เข้ากับธีม
- accent_color: hex color สีลวดลาย ที่ตัดกับสีหลักพอเห็นชัด
- why_th: คำอธิบายสั้นๆ ภาษาไทย 1 ประโยค ว่าโครงร่างนี้ตีความไอเดียของผู้ใช้อย่างไร`;

  try{
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 600,
        system: system,
        messages: [{ role:"user", content: `ไอเดีย: "${idea}"` }]
      })
    });
    const data = await response.json();
    const textBlock = (data.content||[]).find(b=>b.type==='text');
    if(!textBlock) throw new Error('no text');
    let clean = textBlock.text.trim().replace(/^```json/,'').replace(/^```/,'').replace(/```$/,'').trim();
    const parsed = JSON.parse(clean);

    let cps = Array.isArray(parsed.control_points) ? parsed.control_points : null;
    if(!cps || cps.length !== N_POINTS || cps.some(v=>typeof v !== 'number' || isNaN(v))){
      throw new Error('invalid control_points');
    }
    cps = cps.map(v => clamp(v, 0.05, 1.0));

    const heightRatio = clamp(Number(parsed.height_ratio) || 1, 0.5, 1.8);
    const pattern = PATTERN_NAMES[parsed.pattern_type] ? parsed.pattern_type : 'minimal_line';
    const primary = /^#[0-9a-fA-F]{6}$/.test(parsed.primary_color) ? parsed.primary_color : DEFAULT_COLORS.primary;
    const accent = /^#[0-9a-fA-F]{6}$/.test(parsed.accent_color) ? parsed.accent_color : DEFAULT_COLORS.accent;

    pushHistory();
    state.controlPoints = cps.map(v => v*MAX_RADIUS);
    state.heightRatio = heightRatio;
    state.pattern = pattern;
    state.primary = primary;
    state.accent = accent;
    state.aiWhy = parsed.why_th || '';

    syncHeightSlider();
    syncPatternButtons();
    syncColorInputs();
    rebuildAll();
    setAiStatus(state.aiWhy ? `✓ ${state.aiWhy} — ปั้นต่อได้เลยโดยลากที่ผนังชิ้นงาน` : '✓ ขึ้นทรงเริ่มต้นแล้ว ปั้นต่อได้เลย', false);
  }catch(e){
    setAiStatus('AI ขึ้นทรงไม่สำเร็จ ลองใหม่อีกครั้ง หรือปั้นจากก้อนดินเปล่าแทน', true);
  }
  state.aiLoading = false;
  setAiButtonLoading(false);
}
function setAiStatus(text, isError){
  const el = document.getElementById('aiStatus');
  if(!el) return;
  el.textContent = text;
  el.className = 'ai-status' + (isError ? ' error' : '');
}
function setAiButtonLoading(loading){
  const btn = document.getElementById('aiBtn');
  if(!btn) return;
  btn.disabled = loading;
  btn.innerHTML = loading ? '<span class="spin">⟳</span> กำลังขึ้นทรง...' : 'ให้ AI ช่วยขึ้นทรงเริ่มต้น';
}

/* =========================================================
   DOWNLOAD (คู่มือ .txt + ภาพ 3D .png)
   ========================================================= */
function computeStats(){
  const cp = state.controlPoints;
  const maxR = Math.max(...cp);
  const minR = Math.min(...cp);
  const H = BASE_HEIGHT * state.heightRatio;
  return { maxR, minR, H };
}
function downloadGuide(){
  const stats = computeStats();
  const d = estimateDifficulty();
  let content = `ปั้นดิน.AI — คู่มือแบบร่างเซรามิก (ปั้นด้วยมือใน 3D)\n`;
  content += `================================\n\n`;
  content += `ลวดลาย: ${PATTERN_NAMES[state.pattern] || state.pattern}\n`;
  content += `สีหลัก: ${state.primary}   สีลวดลาย: ${state.accent}\n`;
  content += `ความสูงสัมพัทธ์: ${state.heightRatio.toFixed(2)}x\n`;
  content += `จุดกว้างที่สุด: ${(stats.maxR).toFixed(2)} หน่วย   จุดแคบที่สุด: ${(stats.minR).toFixed(2)} หน่วย\n`;
  content += `ความยากโดยประมาณ: ${d}/5\n`;
  if(state.aiWhy) content += `แนวคิดจาก AI: ${state.aiWhy}\n`;
  content += `\nขั้นตอนการปั้น (ทั่วไป):\n`;
  const steps = [
    'เตรียมดินและนวดไล่ฟองอากาศ',
    'ตั้งฐานบนแป้นหมุนให้อยู่กึ่งกลาง',
    'ดึงผนังขึ้นเป็นทรงกระบอกก่อน',
    'ค่อยๆ ปรับความกว้าง-แคบของผนังตามรูปทรงที่ปั้นไว้ในเว็บ (ใช้ภาพหน้าจอที่ดาวน์โหลดเป็นแนวทาง)',
    'เก็บผิวให้เรียบเนียนด้วยฟองน้ำหรือไม้เกลี่ย',
    'ตกแต่งลวดลายตอนดินยังหมาด',
    'ปล่อยให้แห้งสนิท 3-5 วัน',
    'เผาดิบที่ ~900°C',
    'เคลือบและเผาเคลือบที่ ~1200°C',
  ];
  if(d >= 4) steps.push('เทคนิคขั้นสูง: ควบคุมความหนาผนังให้สม่ำเสมอตลอดชิ้นงาน เพื่อลดความเสี่ยงแตกร้าวตอนเผา (โครงร่างนี้มีจุดแคบ/หนาต่างกันมาก)');
  steps.forEach((s,i)=>{ content += `${i+1}. ${s}\n`; });
  content += `\n(ไฟล์นี้สร้างจากต้นแบบสาธิต โปรดปรึกษาครูปั้นหรือสตูดิโอก่อนลงมือจริง)\n`;

  const blob = new Blob([content], {type:'text/plain;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'pandin-guide.txt';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
function downloadImage(){
  if(!scene3d) return;
  scene3d.renderer.render(scene3d.scene, scene3d.camera);
  const dataUrl = scene3d.renderer.domElement.toDataURL('image/png');
  const a = document.createElement('a');
  a.href = dataUrl; a.download = 'pandin-3d-view.png';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

/* =========================================================
   UI SYNC HELPERS
   ========================================================= */
function syncHeightSlider(){
  const el = document.getElementById('heightSlider');
  const label = document.getElementById('heightLabel');
  if(el) el.value = state.heightRatio;
  if(label) label.textContent = state.heightRatio.toFixed(2) + 'x';
}
function syncPatternButtons(){
  document.querySelectorAll('.pattern-btn').forEach(btn=>{
    btn.classList.toggle('active', btn.dataset.pattern === state.pattern);
  });
}
function syncColorInputs(){
  const p = document.getElementById('primaryColor');
  const a = document.getElementById('accentColor');
  if(p) p.value = state.primary;
  if(a) a.value = state.accent;
}

/* =========================================================
   EVENT WIRING
   ========================================================= */
function onHeightInput(v){
  state.heightRatio = parseFloat(v);
  const label = document.getElementById('heightLabel');
  if(label) label.textContent = state.heightRatio.toFixed(2) + 'x';
  rebuildAll();
}
function onDensityInput(v){
  state.density = parseFloat(v);
  const label = document.getElementById('densityLabel');
  if(label) label.textContent = state.density.toFixed(2) + 'x';
  if(scene3d) rebuildTextureOnly(scene3d);
}
function onColorInput(key, v){
  state[key] = v;
  if(scene3d) rebuildTextureOnly(scene3d);
}
function onPatternClick(key){
  pushHistory();
  state.pattern = key;
  syncPatternButtons();
  if(scene3d) rebuildTextureOnly(scene3d);
}
function onIdeaInput(v){ state.idea = v; }
function toggleAutoRotate(e){
  if(!scene3d) return;
  const next = !scene3d.getAutoRotate();
  scene3d.setAutoRotate(next);
  e.target.textContent = next ? '⏸' : '▶';
  e.target.title = next ? 'หยุดหมุนอัตโนมัติ' : 'หมุนอัตโนมัติ';
}

/* =========================================================
   INIT
   ========================================================= */
function init(){
  updateUndoButton();
  updateDifficultyReadout();
  scene3d = initScene3d('three-container');
  window.addEventListener('beforeunload', disposeScene3d);
}
document.addEventListener('DOMContentLoaded', init);

/* =========================================================
   AUTH — เชื่อมกับ project-api (Docker Compose, รันแยกที่ localhost:8000)
   ต้องรัน `docker compose up -d` ในโปรเจกต์ project-api ก่อน ถึงจะ login ได้จริง
   token เก็บไว้ใน memory เท่านั้น (ตัวแปร JS) — รีเฟรชหน้าแล้วต้อง login ใหม่
   ========================================================= */
const auth = {
  apiBase: 'http://localhost:8000',
  token: null,
  username: null,
};

function setApiBase(v){ auth.apiBase = v.trim().replace(/\/+$/,''); }

function switchAuthTab(which){
  const isLogin = which === 'login';
  document.getElementById('tabLogin').classList.toggle('active', isLogin);
  document.getElementById('tabRegister').classList.toggle('active', !isLogin);
  document.getElementById('loginForm').style.display = isLogin ? 'block' : 'none';
  document.getElementById('registerForm').style.display = isLogin ? 'none' : 'block';
  setAuthStatus('', null);
}

function setAuthStatus(text, kind){
  const el = document.getElementById('authStatus');
  if(!el) return;
  el.textContent = text;
  el.className = 'auth-status' + (kind ? ' ' + kind : '');
}

async function apiFetch(path, opts={}){
  const res = await fetch(auth.apiBase + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(auth.token ? { 'Authorization': 'Bearer ' + auth.token } : {}),
      ...(opts.headers || {}),
    },
  });
  let data = null;
  try{ data = await res.json(); }catch(e){ /* no body (เช่น 204) */ }
  if(!res.ok){
    const detail = (data && data.detail) ? data.detail : `เกิดข้อผิดพลาด (${res.status})`;
    throw new Error(detail);
  }
  return data;
}

async function doRegister(){
  const username = document.getElementById('regUsername').value.trim();
  const email = document.getElementById('regEmail').value.trim();
  const password = document.getElementById('regPassword').value;
  if(!username || !email || !password){
    setAuthStatus('กรอกข้อมูลให้ครบก่อน', 'error'); return;
  }
  setAuthStatus('กำลังสมัครสมาชิก...', null);
  try{
    await apiFetch('/register', { method:'POST', body: JSON.stringify({ username, email, password }) });
    setAuthStatus('สมัครสำเร็จ! กำลังเข้าสู่ระบบให้อัตโนมัติ...', 'success');
    await loginWithCredentials(username, password);
  }catch(e){
    setAuthStatus(explainAuthError(e.message), 'error');
  }
}

async function doLogin(){
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  if(!username || !password){ setAuthStatus('กรอก username และ password ก่อน', 'error'); return; }
  await loginWithCredentials(username, password);
}

async function loginWithCredentials(username, password){
  setAuthStatus('กำลังเข้าสู่ระบบ...', null);
  try{
    const tokenRes = await apiFetch('/login', { method:'POST', body: JSON.stringify({ username, password }) });
    auth.token = tokenRes.access_token;
    const me = await apiFetch('/me');
    auth.username = me.username;
    showLoggedIn();
  }catch(e){
    setAuthStatus(explainAuthError(e.message), 'error');
  }
}

async function doLogout(){
  try{ await apiFetch('/logout', { method:'POST' }); }catch(e){ /* เพิกเฉยได้ ถึง logout ฝั่ง client ต่อ */ }
  auth.token = null;
  auth.username = null;
  showLoggedOut();
}

function showLoggedIn(){
  document.getElementById('authLoggedOut').style.display = 'none';
  document.getElementById('authLoggedIn').style.display = 'block';
  document.getElementById('authUsername').textContent = auth.username;
  setAuthStatus('', null);
}
function showLoggedOut(){
  document.getElementById('authLoggedOut').style.display = 'block';
  document.getElementById('authLoggedIn').style.display = 'none';
}

function explainAuthError(msg){
  const m = (msg || '').toLowerCase();
  if(m.includes('fetch') || m.includes('network') || m.includes('load failed')){
    return 'เชื่อมต่อ API ไม่ได้ — ตรวจสอบว่ารัน docker compose up -d ในโปรเจกต์ project-api แล้ว และ API URL ด้านล่างถูกต้อง';
  }
  return msg || 'เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ';
}
