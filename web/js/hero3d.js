// hero3d.js — small, self-contained live 3D preview for the landing page
// hero. Proves the "real 3D model" claim on the very first screen instead
// of a static render.
import * as THREE from "three";
import { buildMugGroup } from "./mug-model.js";

function initHero3D() {
  const container = document.getElementById("hero-3d");
  if (!container) return;

  const scene = new THREE.Scene();
  scene.background = null;

  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50);
  camera.position.set(0, 0.85, 3.1);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  const key = new THREE.DirectionalLight(0xfff4ea, 2.4);
  key.position.set(2.5, 3.5, 2.5);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffe9dd, 0.9);
  fill.position.set(-3, 1, -2);
  scene.add(fill);
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));

  let mug = buildMugGroup({ shape: "classic", handle: "loop", surface: "matte", color: "#A65D45" });
  mug.position.y = -0.55;
  mug.rotation.y = 0.6;
  scene.add(mug);

  function resize() {
    const { clientWidth, clientHeight } = container;
    if (!clientWidth || !clientHeight) return;
    camera.aspect = clientWidth / clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(clientWidth, clientHeight);
  }
  new ResizeObserver(resize).observe(container);
  resize();

  let paused = false;
  const io = new IntersectionObserver(
    (entries) => entries.forEach((e) => (paused = !e.isIntersecting)),
    { threshold: 0.05 }
  );
  io.observe(container);

  function animate() {
    requestAnimationFrame(animate);
    if (!paused) {
      mug.rotation.y += 0.0035;
      renderer.render(scene, camera);
    }
  }
  animate();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initHero3D);
} else {
  initHero3D();
}
