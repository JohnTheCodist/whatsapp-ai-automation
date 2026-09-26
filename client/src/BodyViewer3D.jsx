/**
 * The 3D body on the patient record.
 *
 * LOADED ONLY WHEN IT IS LOOKED AT. three.js and this component are a lazy
 * chunk (see PatientSummary.jsx), and the model itself is a 2.2MB file
 * fetched on demand and left to the browser cache. Nothing about this screen
 * costs anything to a member of staff who never opens a patient record — the
 * same rule the website builder follows in App.jsx.
 *
 * WHAT IT SHOWS. A reference body, male or female, in three layers the
 * pharmacist can switch: the body surface, the skeleton, the organs. Where
 * the pharmacy has something recorded against a region, that region carries
 * a marker; choosing it opens the section of the record that holds it.
 *
 * WHAT IT IS NOT. It is not this patient. It is a reference body from the
 * Human Reference Atlas (CC BY 4.0, see public/models/ATTRIBUTION.md), and
 * the panel says so on its face. An anatomical drawing beside somebody's
 * name is read as a picture OF them, and it must never be mistaken for a
 * finding, a measurement or a scan.
 *
 * WHEN IT CANNOT RUN. No WebGL, a refused context, a model that will not
 * load: the caller is told and falls back to the drawn figure
 * (AnatomicalAvatar.jsx). A pharmacy on a machine without a GPU still gets a
 * body with the same markers on it.
 */

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { BODY_LAYERS, DEFAULT_LAYERS, regionOfHeight, regionCaption, toggleLayer } from './bodyLayers.js';

const MODEL = { male: '/models/body-male.glb', female: '/models/body-female.glb' };

/** The marker colour: amber, the app's queued-work colour. Never red. */
const MARK = 0xd98324;

export default function BodyViewer3D({ sex = null, markers = [], onSelect, onFail }) {
  const mount = useRef(null);
  const [layers, setLayers] = useState(DEFAULT_LAYERS);
  const [hovered, setHovered] = useState(null);
  const [loading, setLoading] = useState(true);
  const scene = useRef(null);

  // ---- set the scene up once -------------------------------------------
  useEffect(() => {
    const host = mount.current;
    if (!host) return undefined;

    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      onFail?.('This browser cannot draw 3D.');
      return undefined;
    }
    const width = host.clientWidth || 360;
    const tall = host.clientHeight || 460;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, tall);
    renderer.setClearAlpha(0);
    // Filmic tone mapping and a correct colour space: without them the lit
    // side of a pale body clips to flat white and the whole figure reads as
    // plastic. This is the single biggest difference between "a 3D model on
    // a page" and something that looks made.
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(renderer.domElement);

    const world = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, width / tall, 0.05, 20);

    /**
     * THREE-POINT LIGHTING, the way a figure is photographed rather than the
     * way a scene is lit. A warm key high on the left models the form, a cool
     * fill on the right keeps the shadow side readable instead of black, and
     * a rim from behind separates the silhouette from the stage — which is
     * what stops a pale body disappearing into a pale panel.
     */
    world.add(new THREE.HemisphereLight(0xffffff, 0xc8c2bb, 1.15));
    const key = new THREE.DirectionalLight(0xfff3e4, 2.4);
    key.position.set(-1.8, 2.6, 2.2);
    world.add(key);
    const fill = new THREE.DirectionalLight(0xdfe9ff, 0.85);
    fill.position.set(2.2, 0.8, 1.4);
    world.add(fill);
    const rim = new THREE.DirectionalLight(0xffffff, 1.6);
    rim.position.set(0.6, 1.8, -2.6);
    world.add(rim);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = false;
    controls.minDistance = 1.1;
    controls.maxDistance = 5;
    // Never let the camera go under the floor or over the top: both put the
    // figure at an angle nobody means to look at a person from.
    controls.minPolarAngle = 0.35;
    controls.maxPolarAngle = Math.PI - 0.45;
    controls.target.set(0, 0.95, 0);
    /**
     * It turns slowly on its own until touched, then stops for good. The
     * drift is what says "this can be turned" without a label asking to be
     * read; stopping on the first drag is what stops it being a toy that
     * moves while someone is trying to point at a shoulder.
     */
    controls.autoRotate = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    controls.autoRotateSpeed = 0.55;
    const stopDrift = () => { controls.autoRotate = false; };
    controls.addEventListener('start', stopDrift);

    const root = new THREE.Group();
    world.add(root);

    /**
     * A contact shadow: a soft dark ellipse on the floor under the figure.
     * Drawn, not cast — a real shadow map costs a second render pass every
     * frame for something nobody examines. Without it the body floats, and a
     * floating body is the thing that makes a 3D panel look unfinished.
     */
    const shadowCanvas = document.createElement('canvas');
    shadowCanvas.width = 128;
    shadowCanvas.height = 128;
    const ctx = shadowCanvas.getContext('2d');
    const blob = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
    blob.addColorStop(0, 'rgba(20,18,16,0.42)');
    blob.addColorStop(0.55, 'rgba(20,18,16,0.14)');
    blob.addColorStop(1, 'rgba(20,18,16,0)');
    ctx.fillStyle = blob;
    ctx.fillRect(0, 0, 128, 128);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(1.5, 1.5),
      new THREE.MeshBasicMaterial({
        map: new THREE.CanvasTexture(shadowCanvas), transparent: true, depthWrite: false,
      }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = 0.002;
    ground.renderOrder = -1;
    world.add(ground);

    scene.current = {
      renderer, world, camera, controls, root, ground, height: 1.8, meshes: [], markerMeshes: [],
    };

    let alive = true;
    let frame = 0;
    const clock = new THREE.Clock();
    const tick = () => {
      if (!alive) return;
      frame = requestAnimationFrame(tick);
      controls.update();
      // The markers breathe, so a recorded region is findable on a body the
      // user is turning. Stopped entirely under reduced motion.
      const t = clock.getElapsedTime();
      if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        for (const m of scene.current.markerMeshes) {
          const s = 1 + Math.sin(t * 2.2) * 0.14;
          m.scale.setScalar(s);
        }
      }
      renderer.render(world, camera);
    };
    tick();

    const resize = () => {
      const w = host.clientWidth || width;
      const h = host.clientHeight || tall;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      // A narrower column needs the camera further back, or the shoulders
      // leave the frame the moment the window is resized.
      scene.current?.refit?.();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.removeEventListener('start', stopDrift);
      controls.dispose();
      // Give the GPU its memory back: a pharmacist opening twenty records in
      // a shift would otherwise leak twenty bodies.
      world.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
      });
      renderer.dispose();
      host.removeChild(renderer.domElement);
      scene.current = null;
    };
  }, [onFail]);

  // ---- load the body ----------------------------------------------------
  useEffect(() => {
    const s = scene.current;
    if (!s) return undefined;
    let cancelled = false;
    setLoading(true);

    (async () => {
      try {
        // The loader is imported here rather than at the top so that a
        // browser with no WebGL never downloads it at all.
        const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
        const url = MODEL[sex] || MODEL.male;
        const gltf = await new GLTFLoader().loadAsync(url);
        if (cancelled || !scene.current) return;

        s.root.clear();
        s.meshes = [];
        const box = new THREE.Box3();
        gltf.scene.traverse((node) => {
          if (!node.isMesh) return;
          const { layer, region } = node.userData || {};
          const spec = BODY_LAYERS.find((l) => l.id === layer) || BODY_LAYERS[0];
          const translucent = spec.opacity < 1;
          node.material = new THREE.MeshPhysicalMaterial({
            color: new THREE.Color(spec.colour),
            roughness: translucent ? 0.42 : 0.55,
            metalness: 0,
            // A thin sheen on the surface, so the body catches the key light
            // along its edges the way skin does rather than reading matte.
            clearcoat: translucent ? 0.5 : 0.15,
            clearcoatRoughness: 0.55,
            // Organs look wet, bone looks dry. One number, and it is the
            // difference between "anatomy" and "grey shapes".
            sheen: translucent ? 0 : 0.4,
            sheenColor: new THREE.Color(0xff9a8a),
            transparent: translucent,
            opacity: spec.opacity,
            // The surface is see-through, so its back faces have to be drawn
            // or the body reads as a hollow shell.
            side: translucent ? THREE.DoubleSide : THREE.FrontSide,
            depthWrite: !translucent,
          });
          node.userData.layer = layer;
          node.userData.region = region;
          s.meshes.push(node);
          box.expandByObject(node);
        });
        s.root.add(gltf.scene);
        s.height = Math.max(0.5, box.max.y - box.min.y);

        /**
         * FRAMED AT AN ANGLE, NOT FLAT ON. A figure photographed dead-front
         * is a passport photo: it reads as a diagram and gives the eye no
         * depth to work with. Turned about 22° and viewed from slightly
         * above, the shoulders and hips overlap and the body reads as a
         * solid. The camera is placed in orbit terms — azimuth, elevation,
         * distance — so the framing holds for a 1.66m body and a 1.82m one.
         */
        /**
         * The distance is FITTED, not guessed, and re-fitted whenever the
         * column changes width. The panel is a tall narrow column, so the
         * limiting dimension is the body height on a wide one and the body
         * width on a narrow one; a fixed distance put the shoulders past
         * both edges. Both are solved and the further wins, with a tenth of
         * headroom so the figure is framed rather than wedged in.
         */
        const azimuth = 0.38;
        const elevation = 0.12;
        const span = Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
        const refit = () => {
          const vFov = (s.camera.fov * Math.PI) / 180;
          const hFov = 2 * Math.atan(Math.tan(vFov / 2) * s.camera.aspect);
          const distance = Math.max(
            (s.height / 2) / Math.tan(vFov / 2),
            (span / 2) / Math.tan(hFov / 2),
          ) * 1.12;
          s.controls.target.set(0, s.height * 0.50, 0);
          s.camera.position.set(
            Math.sin(azimuth) * Math.cos(elevation) * distance,
            s.height * 0.50 + Math.sin(elevation) * distance,
            Math.cos(azimuth) * Math.cos(elevation) * distance,
          );
          // Zooming is bounded by the body, not by numbers picked in
          // advance: close enough to read one organ, far enough to see the
          // whole person.
          s.controls.minDistance = distance * 0.35;
          s.controls.maxDistance = distance * 1.6;
          s.controls.update();
        };
        s.refit = refit;
        refit();
        // The contact shadow scales with the figure: a 1.66m body casts a
        // smaller pool than a 1.82m one.
        if (s.ground) s.ground.scale.setScalar(s.height * 0.42);
        setLoading(false);
      } catch {
        if (!cancelled) onFail?.('The 3D body could not be loaded.');
      }
    })();

    return () => { cancelled = true; };
  }, [sex, onFail]);

  // ---- layers ------------------------------------------------------------
  useEffect(() => {
    const s = scene.current;
    if (!s) return;
    for (const mesh of s.meshes) mesh.visible = layers.includes(mesh.userData.layer);
  }, [layers, loading]);

  // ---- markers -----------------------------------------------------------
  useEffect(() => {
    const s = scene.current;
    if (!s || loading) return;
    for (const m of s.markerMeshes) {
      m.parent?.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    }
    s.markerMeshes = [];

    for (const mark of markers) {
      // A marker sits at the centre of the region it belongs to, taken from
      // the geometry rather than from a hand-written table of positions that
      // would be wrong the moment the model changed.
      const of = s.meshes.filter((mesh) => mesh.userData.region === mark.region);
      const box = new THREE.Box3();
      for (const mesh of of) box.expandByObject(mesh);
      if (box.isEmpty()) continue;
      const at = box.getCenter(new THREE.Vector3());
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(0.035, 20, 16),
        new THREE.MeshBasicMaterial({ color: MARK, transparent: true, opacity: 0.92, depthTest: false }),
      );
      dot.position.copy(at);
      dot.position.z = Math.max(at.z, 0.12);      // in front of the body
      dot.renderOrder = 10;
      dot.userData.marker = mark;
      s.root.add(dot);
      s.markerMeshes.push(dot);
    }
  }, [markers, loading]);

  // ---- pointing at the body ----------------------------------------------
  function pick(event) {
    const s = scene.current;
    if (!s) return null;
    const rect = s.renderer.domElement.getBoundingClientRect();
    const point = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(point, s.camera);
    const hits = ray.intersectObjects([...s.markerMeshes, ...s.meshes.filter((m) => m.visible)], false);
    if (!hits.length) return null;
    const hit = hits[0];
    if (hit.object.userData.marker) return hit.object.userData.marker.region;
    // A region from WHERE the body was hit, not from which mesh: the body
    // surface is one mesh, so the mesh alone cannot say head from knee.
    return regionOfHeight(hit.point.y / s.height, hit.point.x);
  }

  const caption = regionCaption(hovered, markers);

  return (
    <div className="ui-body3d">
      <div
        ref={mount}
        className="ui-body3d-stage"
        /* The visible credit line was removed at the owner's request. CC BY
           4.0 still requires attribution, and "this is not your patient" is
           still worth being able to find, so both moved onto the panel
           itself — its accessible name and its tooltip.
           public/models/ATTRIBUTION.md ships with the app and carries the
           full credit and every adaptation. */
        role="img"
        aria-label="Reference body, not this patient. Human Reference Atlas (HuBMAP), CC BY 4.0."
        title="Reference body, not this patient · Human Reference Atlas (HuBMAP), CC BY 4.0"
        onPointerMove={(e) => setHovered(pick(e))}
        onPointerLeave={() => setHovered(null)}
        onClick={(e) => {
          const region = pick(e);
          const mark = markers.find((m) => m.region === region);
          if (mark?.tab) onSelect?.(mark.tab, region);
        }}
      />

      {loading && <p className="ui-body3d-loading">Loading the body…</p>}

      <div className="ui-body3d-layers" role="group" aria-label="Body layers">
        {BODY_LAYERS.map((l) => {
          const on = layers.includes(l.id);
          return (
            <button
              key={l.id}
              type="button"
              aria-pressed={on}
              onClick={() => setLayers((active) => toggleLayer(active, l.id))}
              className={`ui-body3d-layer ${on ? 'is-on' : ''}`}
            >
              {l.label}
            </button>
          );
        })}
      </div>

      {/* The caption appears only while a part of the body is being pointed
          at. The standing instruction it used to carry ("Drag to turn…") is
          gone at the owner's request: a body that drifts and a cursor that
          becomes a grab handle already say it, and a permanent line of
          instruction under a panel is read once and then becomes furniture. */}
      {caption && (
        <p className="ui-body3d-caption" aria-live="polite">{caption}</p>
      )}
    </div>
  );
}
