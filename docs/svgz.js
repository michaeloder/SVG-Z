/**
 * svgz.js  —  SVG-Z Renderer  v1.0
 *
 * A declarative 3D vector graphics renderer extending SVG with a Z axis.
 * Renders <svgz> documents to a <canvas> element using a CPU z-buffer,
 * Weighted Blended OIT for transparency, and Temporal Super-Sampling AA.
 *
 * Public API
 * ──────────
 *   // Stateful interactive renderer (orbit, zoom, pan, AA controls)
 *   const renderer = new SVGZRenderer(canvasElement);
 *   renderer.load(svgzSource);          // parse + schedule render
 *   renderer.render(inMotion);          // draw one frame
 *
 *   // Simple one-shot render
 *   SVGZ.render(canvasElement, svgzSource, { aaMode: 'tsaa' });
 *
 *   // Auto-discover and render all <svgz> tags in the document
 *   SVGZ.init();                        // call after DOMContentLoaded
 *
 * SVG-Z Elements
 * ──────────────
 *   <svgz width height background>
 *     <camera fov eye center up near far aa orbit/>
 *     <path3d    d3 fill stroke stroke-width opacity depth-bias render-order/>
 *     <polygon3d points3d fill stroke …/>
 *     <group3d   transform3d>…</group3d>
 *     <sphere3d  center radius subdivisions lat-rings lon-lines fill stroke …/>
 *     <cylinder3d start end radius radius2 subdivisions cap-start cap-end rings lines fill stroke …/>
 *     <lathe3d   d2 origin axis sweep subdivisions profile-samples rings lines cap-start cap-end fill stroke …/>
 *     <extrude3d d2 origin dir depth axis-x axis-y steps profile-samples rings lines cap-start cap-end fill stroke …/>
 *     <surface3d d3 subdivisions rings lines fill stroke …/>
 *   </svgz>
 *
 * MIT License  —  https://github.com/your-org/svgz
 */

// ═══════════════════════════════════════════════════════════════
//  SVG-Z RENDERER
// ═══════════════════════════════════════════════════════════════

class Vec3 {
  constructor(x=0,y=0,z=0){this.x=x;this.y=y;this.z=z;}
  add(v){return new Vec3(this.x+v.x,this.y+v.y,this.z+v.z);}
  sub(v){return new Vec3(this.x-v.x,this.y-v.y,this.z-v.z);}
  scale(s){return new Vec3(this.x*s,this.y*s,this.z*s);}
  dot(v){return this.x*v.x+this.y*v.y+this.z*v.z;}
  cross(v){return new Vec3(this.y*v.z-this.z*v.y,this.z*v.x-this.x*v.z,this.x*v.y-this.y*v.x);}
  len(){return Math.sqrt(this.dot(this));}
  norm(){const l=this.len()||1;return this.scale(1/l);}
  lerp(v,t){return this.scale(1-t).add(v.scale(t));}
  static fromArray(a){return new Vec3(a[0]||0,a[1]||0,a[2]||0);}
}

class Mat4 {
  constructor(d){this.d=d||[1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];}
  mul(m){
    const a=this.d,b=m.d,c=new Array(16);
    for(let r=0;r<4;r++)for(let col=0;col<4;col++){
      c[r*4+col]=0;
      for(let k=0;k<4;k++)c[r*4+col]+=a[r*4+k]*b[k*4+col];
    }
    return new Mat4(c);
  }
  transformPoint(v){
    const d=this.d,{x,y,z}=v;
    const w=d[12]*x+d[13]*y+d[14]*z+d[15];
    return new Vec3(
      (d[0]*x+d[1]*y+d[2]*z+d[3])/w,
      (d[4]*x+d[5]*y+d[6]*z+d[7])/w,
      (d[8]*x+d[9]*y+d[10]*z+d[11])/w
    );
  }
  static perspective(fov,aspect,near,far){
    const f=1/Math.tan(fov*Math.PI/360);
    const nf=1/(near-far);
    return new Mat4([
      f/aspect,0,0,0,
      0,f,0,0,
      0,0,(far+near)*nf,-1,
      0,0,2*far*near*nf,0
    ]);
  }
  static lookAt(eye,center,up){
    const f=center.sub(eye).norm();
    const r=f.cross(up).norm();
    const u=r.cross(f);
    return new Mat4([
      r.x,r.y,r.z,-r.dot(eye),
      u.x,u.y,u.z,-u.dot(eye),
      -f.x,-f.y,-f.z,f.dot(eye),
      0,0,0,1
    ]);
  }
  static rotateY(a){const c=Math.cos(a),s=Math.sin(a);return new Mat4([c,0,s,0,0,1,0,0,-s,0,c,0,0,0,0,1]);}
  static rotateX(a){const c=Math.cos(a),s=Math.sin(a);return new Mat4([1,0,0,0,0,c,-s,0,0,s,c,0,0,0,0,1]);}
  static rotateZ(a){const c=Math.cos(a),s=Math.sin(a);return new Mat4([c,-s,0,0,s,c,0,0,0,0,1,0,0,0,0,1]);}
  static translate(x,y,z){return new Mat4([1,0,0,x,0,1,0,y,0,0,1,z,0,0,0,1]);}
  static scale(x,y,z){return new Mat4([x,0,0,0,0,y,0,0,0,0,z,0,0,0,0,1]);}
}

// ── Parse SVG-Z source ──────────────────────────────────────────
class SVGZParser {
  parse(src) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(src, 'image/svg+xml');
    const root = doc.documentElement;

    // Check parse errors
    const err = doc.querySelector('parsererror');
    if (err) throw new Error('XML parse error: ' + err.textContent.slice(0,80));

    const scene = {
      width:      parseFloat(root.getAttribute('width'))  || 500,
      height:     parseFloat(root.getAttribute('height')) || 500,
      background: root.getAttribute('background') || '#0a0a0f',
      camera:     this.parseCamera(root),
      elements:   []
    };

    for (const child of root.children) {
      const el = this.parseElement(child);
      if (el) scene.elements.push(el);
    }
    return scene;
  }

  parseCamera(root) {
    const camEl = root.querySelector('camera');
    if (camEl) {
      const aaRaw = camEl.getAttribute('aa');
      const orbitRaw = camEl.getAttribute('orbit');
      return {
        fov:    parseFloat(camEl.getAttribute('fov')) || 60,
        eye:    this.parseVec3(camEl.getAttribute('eye') || '0,0,5'),
        center: this.parseVec3(camEl.getAttribute('center') || '0,0,0'),
        up:     this.parseVec3(camEl.getAttribute('up') || '0,1,0'),
        near:   parseFloat(camEl.getAttribute('near')) || 0.1,
        far:    parseFloat(camEl.getAttribute('far')) || 100,
        aa:     aaRaw || null,               // 'off'|'tsaa'|'msaa2'|'msaa4'|null
        orbit:  orbitRaw !== null ? parseFloat(orbitRaw) || 0 : null, // speed multiplier, null=unset
      };
    }
    return { fov:60, eye:new Vec3(0,0,5), center:new Vec3(0,0,0), up:new Vec3(0,1,0), near:0.1, far:100, aa:null, orbit:null };
  }

  parseVec3(s) {
    const parts = s.trim().split(/[\s,]+/).map(parseFloat);
    return new Vec3(parts[0]||0, parts[1]||0, parts[2]||0);
  }

  parseElement(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'camera') return null;

    const base = {
      fill: el.getAttribute('fill') || 'none',
      stroke: el.getAttribute('stroke') || 'none',
      strokeWidth: parseFloat(el.getAttribute('stroke-width')) || 1,
      opacity: parseFloat(el.getAttribute('opacity') ?? '1'),
      depthBias: parseFloat(el.getAttribute('depth-bias') || '0'),
      renderOrder: parseInt(el.getAttribute('render-order') || '0'),
    };

    if (tag === 'path3d') {
      return { type: 'path3d', d3: el.getAttribute('d3') || '', ...base };
    }

    if (tag === 'polygon3d') {
      const pointsStr = el.getAttribute('points3d') || '';
      const points = this.parsePoints3d(pointsStr);
      return { type: 'polygon3d', points, ...base };
    }

    if (tag === 'group3d') {
      const transform = el.getAttribute('transform3d') || '';
      const children = [];
      for (const child of el.children) {
        const c = this.parseElement(child);
        if (c) children.push(c);
      }
      return { type: 'group3d', transform, children, ...base };
    }

    if (tag === 'sphere3d') {
      // lat-rings / lon-lines: explicit count, 0 = none, -1 = auto
      const latRings = el.getAttribute('lat-rings');
      const lonLines = el.getAttribute('lon-lines');
      return {
        type:         'sphere3d',
        center:       this.parseVec3(el.getAttribute('center') || '0,0,0'),
        radius:       parseFloat(el.getAttribute('radius') || '1'),
        subdivisions: Math.max(4, Math.min(64,
                        parseInt(el.getAttribute('subdivisions') || '24'))),
        // null  → use auto spacing  |  0 → off  |  N → exactly N
        latRings: latRings !== null ? parseInt(latRings) : null,
        lonLines: lonLines !== null ? parseInt(lonLines) : null,
        ...base
      };
    }

    if (tag === 'cylinder3d') {
      const rings = el.getAttribute('rings');      // null=auto, 0=off, N=N
      const lines = el.getAttribute('lines');      // null=auto, 0=off, N=N
      return {
        type:         'cylinder3d',
        start:        this.parseVec3(el.getAttribute('start')  || '0,-1,0'),
        end:          this.parseVec3(el.getAttribute('end')    || '0,1,0'),
        radius:       parseFloat(el.getAttribute('radius')  || '1'),
        // radius2: if set, cylinder becomes a cone frustum
        radius2:      el.getAttribute('radius2') !== null
                        ? parseFloat(el.getAttribute('radius2'))
                        : null,
        subdivisions: Math.max(3, Math.min(128,
                        parseInt(el.getAttribute('subdivisions') || '32'))),
        capStart:     el.getAttribute('cap-start') !== 'false',
        capEnd:       el.getAttribute('cap-end')   !== 'false',
        rings:        rings !== null ? parseInt(rings) : null,
        lines:        lines !== null ? parseInt(lines) : null,
        ...base
      };
    }

    if (tag === 'lathe3d') {
      const lRings = el.getAttribute('rings');  // null=auto(~8), 0=off, N=N
      const lLines = el.getAttribute('lines');  // null=auto(sweep edges), 0=off, N=N
      return {
        type:         'lathe3d',
        // d2: 2D profile path — x=radius from axis, y=height along axis
        // Uses standard SVG path commands (M, L, C, Q, Z) with 2D coords.
        d2:           el.getAttribute('d2') || 'M 0,0 L 1,0',
        // axis: revolve around 'x', 'y' (default), or 'z'
        axis:         (el.getAttribute('axis') || 'y').toLowerCase(),
        // origin: world-space centre of revolution
        origin:       this.parseVec3(el.getAttribute('origin') || '0,0,0'),
        // sweep: degrees of revolution (360 = full, <360 = partial)
        sweep:        Math.min(360, Math.max(1,
                        parseFloat(el.getAttribute('sweep') || '360'))),
        subdivisions: Math.max(3, Math.min(128,
                        parseInt(el.getAttribute('subdivisions') || '48'))),
        // profile-samples: how finely to sample the 2D profile curve
        profileSamples: Math.max(4, Math.min(256,
                        parseInt(el.getAttribute('profile-samples') || '64'))),
        capStart:     el.getAttribute('cap-start') !== 'false',
        capEnd:       el.getAttribute('cap-end')   !== 'false',
        // rings: horizontal cross-section circles  null=auto, 0=off, N=N
        rings:        lRings !== null ? parseInt(lRings) : null,
        // lines: vertical profile lines around the surface  null=auto, 0=off, N=N
        lines:        lLines !== null ? parseInt(lLines) : null,
        ...base
      };
    }

    if (tag === 'extrude3d') {
      const eRings = el.getAttribute('rings');  // null=auto, 0=off, N=N
      const eLines = el.getAttribute('lines');  // null=auto, 0=off, N=N
      return {
        type:    'extrude3d',
        // d2: 2D closed or open profile (same format as lathe3d)
        d2:      el.getAttribute('d2') || 'M 0,0 L 1,0 L 1,1 L 0,1 Z',
        // origin: world-space anchor for the start face
        origin:  this.parseVec3(el.getAttribute('origin') || '0,0,0'),
        // dir: world-space extrusion direction (will be normalised)
        dir:     this.parseVec3(el.getAttribute('dir') || '0,0,1'),
        // depth: how far to extrude along dir
        depth:   parseFloat(el.getAttribute('depth') || '1'),
        // axis-x / axis-y: map profile 2D coords onto world axes
        // default: profile lies in XY plane (axisX=1,0,0  axisY=0,1,0)
        axisX:   this.parseVec3(el.getAttribute('axis-x') || '1,0,0'),
        axisY:   this.parseVec3(el.getAttribute('axis-y') || '0,1,0'),
        // steps: cross-section slices along depth (1=straight, >1 for stroke rings)
        steps:   Math.max(1, Math.min(64,
                   parseInt(el.getAttribute('steps') || '1'))),
        profileSamples: Math.max(4, Math.min(256,
                   parseInt(el.getAttribute('profile-samples') || '64'))),
        capStart: el.getAttribute('cap-start') !== 'false',
        capEnd:   el.getAttribute('cap-end')   !== 'false',
        rings:    eRings !== null ? parseInt(eRings) : null,
        lines:    eLines !== null ? parseInt(eLines) : null,
        ...base
      };
    }

    if (tag === 'surface3d') {
      const sRings = el.getAttribute('rings');  // null=auto, 0=off, N=N  (iso-V lines)
      const sLines = el.getAttribute('lines');  // null=auto, 0=off, N=N  (iso-U lines)
      return {
        type:         'surface3d',
        // d3: series of B commands, each followed by 16 x,y,z control points
        // defining one bicubic Bézier patch.
        // B p00 p01 p02 p03  p10 p11 p12 p13  p20 p21 p22 p23  p30 p31 p32 p33
        d3:           el.getAttribute('d3') || '',
        subdivisions: Math.max(2, Math.min(64,
                        parseInt(el.getAttribute('subdivisions') || '16'))),
        // rings: iso-V parameter lines (u=const) across the surface
        rings:        sRings !== null ? parseInt(sRings) : null,
        // lines: iso-U parameter lines (v=const) along the surface
        lines:        sLines !== null ? parseInt(sLines) : null,
        ...base
      };
    }

    return null;
  }

  parsePoints3d(s) {
    const nums = s.trim().split(/[\s,]+/).map(parseFloat).filter(v=>!isNaN(v));
    const pts = [];
    for (let i=0;i<nums.length-2;i+=3) pts.push(new Vec3(nums[i],nums[i+1],nums[i+2]));
    return pts;
  }

  // Parse a d3 surface attribute into an array of patch control-point grids.
  // Each B command produces one patch: a 4×4 array of Vec3.
  parseSurface3D(d3) {
    const tokens = d3.trim().match(/[Bb]|[-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?/g) || [];
    const patches = [];
    let i = 0;
    const nf = () => parseFloat(tokens[i++]);
    while (i < tokens.length) {
      const cmd = tokens[i++];
      if (!cmd) continue;
      if (cmd.toUpperCase() === 'B') {
        // Read 16 control points (4 rows × 4 cols), each x,y,z
        const grid = [];
        for (let r = 0; r < 4; r++) {
          const row = [];
          for (let c = 0; c < 4; c++) {
            row.push(new Vec3(nf(), nf(), nf()));
          }
          grid.push(row);
        }
        patches.push(grid);
      }
    }
    return patches;
  }

  // Sample a 2D SVG-style path into [{x,y}] points.
  // Commands: M x,y  L x,y  C x,y x,y x,y  Q x,y x,y  Z
  parseProfile2D(d, samples=64) {
    const tokens = d.trim().match(/[MmLlCcQqZz]|[-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?/g) || [];
    const segs = []; let i=0, cx=0, cy=0, sx=0, sy=0;
    const nf = () => parseFloat(tokens[i++]);
    const nv = () => { const x=nf(),y=nf(); return {x,y}; };
    while (i < tokens.length) {
      const cmd = tokens[i++];
      if (!cmd || /^[-+0-9.]/.test(cmd)) { i--; continue; }
      switch (cmd.toUpperCase()) {
        case 'M': { const v=nv(); cx=v.x; cy=v.y; sx=cx; sy=cy;
                    segs.push({type:'M',p:{x:cx,y:cy}}); break; }
        case 'L': { const v=nv();
                    segs.push({type:'L',p0:{x:cx,y:cy},p:v});
                    cx=v.x; cy=v.y; break; }
        case 'C': { const c1=nv(),c2=nv(),ep=nv();
                    segs.push({type:'C',p0:{x:cx,y:cy},c1,c2,p:ep});
                    cx=ep.x; cy=ep.y; break; }
        case 'Q': { const c1=nv(),ep=nv();
                    segs.push({type:'Q',p0:{x:cx,y:cy},c1,p:ep});
                    cx=ep.x; cy=ep.y; break; }
        case 'Z': { segs.push({type:'Z',p0:{x:cx,y:cy},p:{x:sx,y:sy}});
                    cx=sx; cy=sy; break; }
      }
    }
    // Sample each segment into points
    const pts = [];
    const lerp2 = (a,b,t) => ({x:a.x+(b.x-a.x)*t, y:a.y+(b.y-a.y)*t});
    for (const seg of segs) {
      if (seg.type==='M') { pts.push(seg.p); continue; }
      // Z closes back to start — skip intermediate samples (the barrel
      // already connects last→first via the closed-profile quad), but DO
      // push the endpoint so _profileIsClosed() detects closure correctly.
      if (seg.type==='Z') { pts.push(seg.p); continue; }
      const steps = Math.max(2, Math.round(samples / segs.length));
      // Start at t=1/steps (not t=0) — the start point was already added
      // by the previous segment's endpoint or by M, avoiding duplicates.
      for (let t=1/steps; t<=1-1e-9; t+=1/steps) {
        let p;
        if (seg.type==='L') {
          p = lerp2(seg.p0, seg.p, t);
        } else if (seg.type==='C') {
          const mt=1-t;
          p = { x: seg.p0.x*mt*mt*mt + 3*seg.c1.x*mt*mt*t + 3*seg.c2.x*mt*t*t + seg.p.x*t*t*t,
                y: seg.p0.y*mt*mt*mt + 3*seg.c1.y*mt*mt*t + 3*seg.c2.y*mt*t*t + seg.p.y*t*t*t };
        } else if (seg.type==='Q') {
          const mt=1-t;
          p = { x: seg.p0.x*mt*mt + 2*seg.c1.x*mt*t + seg.p.x*t*t,
                y: seg.p0.y*mt*mt + 2*seg.c1.y*mt*t + seg.p.y*t*t };
        }
        if (p) pts.push(p);
      }
      pts.push(seg.p); // always include the exact endpoint
    }
    // For closed profiles the last point equals the first — keep it so
    // _profileIsClosed() works, but ear-clip will deduplicate correctly.
    return pts;
  }
}

// ── Path3D: parse d3 commands into 3D segments ─────────────────
class Path3D {
  constructor(d3) {
    this.segments = this._parse(d3);
  }

  _parse(d) {
    const tokens = d.trim().match(/[MmLlCcQqZz]|[-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?/g) || [];
    const segs = [];
    let i=0, cx=0,cy=0,cz=0, startX=0,startY=0,startZ=0;

    const nextFloat = () => parseFloat(tokens[i++]);
    const nextVec3 = () => {
      const x=nextFloat(),y=nextFloat(),z=nextFloat();
      return new Vec3(x,y,z);
    };

    while(i < tokens.length) {
      const cmd = tokens[i++];
      if(!cmd || /^[-+0-9.]/.test(cmd)){i--;continue;}
      switch(cmd.toUpperCase()) {
        case 'M': {
          const v = nextVec3();
          cx=v.x;cy=v.y;cz=v.z;
          startX=cx;startY=cy;startZ=cz;
          segs.push({type:'M', p:v});
          break;
        }
        case 'L': {
          const v = nextVec3();
          segs.push({type:'L', p0:new Vec3(cx,cy,cz), p:v});
          cx=v.x;cy=v.y;cz=v.z;
          break;
        }
        case 'C': {
          const c1=nextVec3(),c2=nextVec3(),ep=nextVec3();
          segs.push({type:'C', p0:new Vec3(cx,cy,cz), c1, c2, p:ep});
          cx=ep.x;cy=ep.y;cz=ep.z;
          break;
        }
        case 'Q': {
          const c1=nextVec3(),ep=nextVec3();
          segs.push({type:'Q', p0:new Vec3(cx,cy,cz), c1, p:ep});
          cx=ep.x;cy=ep.y;cz=ep.z;
          break;
        }
        case 'Z': {
          segs.push({type:'Z', p0:new Vec3(cx,cy,cz), p:new Vec3(startX,startY,startZ)});
          cx=startX;cy=startY;cz=startZ;
          break;
        }
      }
    }
    return segs;
  }

  // Sample points along path (3D positions + t param)
  sample(steps=60) {
    const pts = [];
    for (const seg of this.segments) {
      if (seg.type==='M') { pts.push({p:seg.p,t:0}); continue; }
      if (seg.type==='L'||seg.type==='Z') {
        for(let t=0;t<=1;t+=1/steps) pts.push({p:seg.p0.lerp(seg.p,t)});
        pts.push({p:seg.p});
        continue;
      }
      if (seg.type==='C') {
        for(let t=0;t<=1;t+=1/steps){
          const mt=1-t;
          const p=seg.p0.scale(mt*mt*mt)
            .add(seg.c1.scale(3*mt*mt*t))
            .add(seg.c2.scale(3*mt*t*t))
            .add(seg.p.scale(t*t*t));
          pts.push({p});
        }
        continue;
      }
      if (seg.type==='Q') {
        for(let t=0;t<=1;t+=1/steps){
          const mt=1-t;
          const p=seg.p0.scale(mt*mt)
            .add(seg.c1.scale(2*mt*t))
            .add(seg.p.scale(t*t));
          pts.push({p});
        }
        continue;
      }
    }
    return pts;
  }

  isClosed() {
    return this.segments.some(s=>s.type==='Z');
  }
}

// ── Z-Buffer + WBOIT Rasterizer (with TSAA history buffer) ───
//
//  Rendering runs at native 1× resolution every frame.
//  TSAA works by:
//    1. Offsetting the projection matrix by a sub-pixel Halton jitter
//       each frame, so geometry lands on slightly different pixel centres.
//    2. Exponentially blending the resolved frame into a float history
//       buffer:  history = current * alpha + history * (1 - alpha)
//    3. Displaying the history buffer as the final output.
//
//  On any camera/scene change dirtyFrames is reset to TSAA_TAPS so the
//  history rebuilds over the next N frames then goes idle.
//  History is flushed on reset to prevent ghosting from the old view.
//
//  Three per-pixel buffers at native W×H:
//    zbuf    Float32    opaque depth
//    fbuf    Float32×4  resolved colour for current frame (float for blend precision)
//    history Float32×4  temporal accumulation buffer
//
//  WBOIT buffers (also native W×H):
//    wAccum  Float32×4
//    wReveal Float32
//
class ZBufferRenderer {
  constructor(canvas) {
    this.canvas  = canvas;
    this.ctx     = canvas.getContext('2d');
    this.W       = canvas.width;
    this.H       = canvas.height;
    this.pass    = 'opaque';
    // aaMode: 'tsaa' | 'msaa' | 'off'
    this.aaMode  = 'tsaa';
    this.ssf     = 1;   // supersampling factor (MSAA only)
    this.SW      = this.W;
    this.SH      = this.H;
    this._allocBuffers();
  }

  _allocBuffers() {
    // Native display pixels
    const n = this.W * this.H;
    // Supersampled pixels (for MSAA; ssf=1 when TSAA/off)
    const sn = this.SW * this.SH;
    this.zbuf    = new Float32Array(sn);
    this.fbuf    = new Float32Array(sn * 4);  // current frame (float)
    this.history = new Float32Array(n * 4);   // TSAA temporal accumulator (native res)
    this.wAccum  = new Float32Array(sn * 4);
    this.wReveal = new Float32Array(sn);
    this.imageData = this.ctx.createImageData(this.W, this.H);
    this.historyValid = false;
  }



  flushHistory() {
    this.historyValid = false;
    this.history.fill(0);
  }

  get tsaaOn() { return this.aaMode === 'tsaa'; }

  setMode(mode) {
    // mode: 'tsaa' | 'msaa1' | 'msaa2' | 'msaa4' | 'off'
    if (mode === 'tsaa') {
      this.aaMode = 'tsaa'; this.ssf = 1;
    } else if (mode === 'msaa2') {
      this.aaMode = 'msaa'; this.ssf = 2;
    } else if (mode === 'msaa4') {
      this.aaMode = 'msaa'; this.ssf = 4;
    } else {
      this.aaMode = 'off'; this.ssf = 1;
    }
    this.SW = this.W * this.ssf;
    this.SH = this.H * this.ssf;
    this._allocBuffers();
  }

  resize(w, h) {
    this.W = w; this.H = h;
    this.SW = w * this.ssf; this.SH = h * this.ssf;
    this.canvas.width = w; this.canvas.height = h;
    this._allocBuffers();
  }

  // ── Frame-start clears ───────────────────────────────────────
  clearOpaque(bgR=10, bgG=10, bgB=15) {
    this.zbuf.fill(Infinity);
    const f = this.fbuf, n4 = this.SW * this.SH * 4;
    for (let i = 0; i < n4; i += 4) {
      f[i]=bgR; f[i+1]=bgG; f[i+2]=bgB; f[i+3]=255;
    }
  }

  clearTransparent() {
    this.wAccum.fill(0);
    this.wReveal.fill(1);
  }

  // ── Pixel writers ────────────────────────────────────────────
  _setPixelOpaque(px, py, z, r, g, b, a) {
    if (px<0||px>=this.SW||py<0||py>=this.SH) return;
    const idx = py*this.SW + px;
    if (z < this.zbuf[idx]) {
      this.zbuf[idx] = z;
      const i = idx*4, alpha = a/255;
      this.fbuf[i]   = r*alpha + this.fbuf[i]  *(1-alpha);
      this.fbuf[i+1] = g*alpha + this.fbuf[i+1]*(1-alpha);
      this.fbuf[i+2] = b*alpha + this.fbuf[i+2]*(1-alpha);
      this.fbuf[i+3] = 255;
    }
  }

  _setPixelTransparent(px, py, z, r, g, b, a) {
    if (px<0||px>=this.SW||py<0||py>=this.SH) return;
    const idx = py*this.SW + px;
    if (z >= this.zbuf[idx]) return;
    const alpha = a/255;
    const zn = z*0.5+0.5, z4 = zn*zn*zn*zn;
    const w = alpha * Math.min(Math.max(0.03/(1e-5+z4), 0.01), 3000);
    const i = idx*4;
    this.wAccum[i]   += r*w; this.wAccum[i+1] += g*w;
    this.wAccum[i+2] += b*w; this.wAccum[i+3] += alpha*w;
    this.wReveal[idx] *= (1-alpha);
  }

  setPixel(px, py, z, r, g, b, a=255) {
    if (this.pass === 'opaque') this._setPixelOpaque(px,py,z,r,g,b,a);
    else                        this._setPixelTransparent(px,py,z,r,g,b,a);
  }

  // ── WBOIT resolve ────────────────────────────────────────────
  resolveTransparent() {
    const n = this.SW * this.SH;
    for (let idx = 0; idx < n; idx++) {
      const reveal = this.wReveal[idx];
      if (reveal >= 0.9999) continue;
      const i = idx*4, wA = this.wAccum[i+3];
      if (wA < 1e-6) continue;
      const blend = 1 - reveal;
      this.fbuf[i]   = (this.wAccum[i]  /wA)*blend + this.fbuf[i]  *reveal;
      this.fbuf[i+1] = (this.wAccum[i+1]/wA)*blend + this.fbuf[i+1]*reveal;
      this.fbuf[i+2] = (this.wAccum[i+2]/wA)*blend + this.fbuf[i+2]*reveal;
    }
  }

  // ── TSAA temporal blend + blit ───────────────────────────────
  //  blendAlpha: how much the NEW frame contributes.
  //    High (0.5-1.0) → fast convergence, less smoothing (use during motion)
  //    Low  (0.1-0.2) → slow convergence, maximum smoothing (use when static)
  flush(blendAlpha=0.15) {
    const out = this.imageData.data;

    if (this.aaMode === 'msaa') {
      // ── MSAA: box-filter downsample SW×SH → W×H then blit ───
      const s=this.ssf, s2=s*s, SW=this.SW, fb=this.fbuf;
      for (let py=0; py<this.H; py++) {
        for (let px=0; px<this.W; px++) {
          let sr=0,sg=0,sb=0,sa=0;
          for (let dy=0; dy<s; dy++) for (let dx=0; dx<s; dx++) {
            const si=((py*s+dy)*SW+(px*s+dx))*4;
            sr+=fb[si]; sg+=fb[si+1]; sb+=fb[si+2]; sa+=fb[si+3];
          }
          const oi=(py*this.W+px)*4;
          out[oi]=sr/s2; out[oi+1]=sg/s2; out[oi+2]=sb/s2; out[oi+3]=sa/s2;
        }
      }
    } else if (this.aaMode === 'tsaa') {
      // ── TSAA: temporal blend then blit ───────────────────────
      const n4 = this.W * this.H * 4;
      const fb = this.fbuf, hist = this.history;
      if (!this.historyValid) {
        hist.set(fb); this.historyValid = true;
      } else {
        const a=blendAlpha, b=1-a;
        for (let i=0; i<n4; i++) hist[i] = fb[i]*a + hist[i]*b;
      }
      for (let i=0; i<n4; i++) out[i] = hist[i];
    } else {
      // ── Off: direct copy ─────────────────────────────────────
      const n4 = this.W * this.H * 4, fb = this.fbuf;
      for (let i=0; i<n4; i++) out[i] = fb[i];
    }

    this.ctx.putImageData(this.imageData, 0, 0);
  }

  // ── Triangle rasterizer ──────────────────────────────────────
  fillTriangle(v0, v1, v2, r, g, b, a, depthBias=0) {
    const s=this.ssf;
    const ax=v0.x*s,ay=v0.y*s, bx=v1.x*s,by=v1.y*s, cx=v2.x*s,cy=v2.y*s;
    const minX=Math.max(0,Math.floor(Math.min(ax,bx,cx)));
    const maxX=Math.min(this.SW-1,Math.ceil(Math.max(ax,bx,cx)));
    const minY=Math.max(0,Math.floor(Math.min(ay,by,cy)));
    const maxY=Math.min(this.SH-1,Math.ceil(Math.max(ay,by,cy)));
    const dX1=bx-ax,dY1=by-ay,dX2=cx-ax,dY2=cy-ay;
    const denom=dX1*dY2-dX2*dY1;
    if (Math.abs(denom)<1e-8) return;
    const invD=1/denom;
    for (let py=minY; py<=maxY; py++) {
      for (let px=minX; px<=maxX; px++) {
        const qx=px-ax,qy=py-ay;
        const st=(qx*dY2-qy*dX2)*invD, tt=(dX1*qy-dY1*qx)*invD;
        if (st>=0&&tt>=0&&st+tt<=1) {
          const z=v0.z+st*(v1.z-v0.z)+tt*(v2.z-v0.z)+depthBias;
          this.setPixel(px,py,z,r,g,b,a);
        }
      }
    }
  }

  // ── Line rasterizer ──────────────────────────────────────────
  drawLine(x0,y0,z0,x1,y1,z1,r,g,b,a,width=1,depthBias=0) {
    const s=this.ssf;
    const sx0=x0*s,sy0=y0*s,sx1=x1*s,sy1=y1*s;
    const steps=Math.max(Math.abs(sx1-sx0),Math.abs(sy1-sy0))*2+1;
    const hw=(width*s)/2, hw2=hw*hw;
    for (let i=0; i<=steps; i++) {
      const t=i/steps;
      const x=sx0+(sx1-sx0)*t, y=sy0+(sy1-sy0)*t, z=z0+(z1-z0)*t+depthBias;
      for (let dy=Math.ceil(y-hw); dy<=Math.floor(y+hw); dy++)
        for (let dx=Math.ceil(x-hw); dx<=Math.floor(x+hw); dx++)
          if ((dx-x)**2+(dy-y)**2<=hw2) this.setPixel(dx,dy,z,r,g,b,a);
    }
  }
}

// ── Parse CSS color ────────────────────────────────────────────
function parseColor(str) {
  if (!str || str==='none') return null;
  const cvs = document.createElement('canvas');
  cvs.width=cvs.height=1;
  const ctx=cvs.getContext('2d');
  ctx.fillStyle=str;
  ctx.fillRect(0,0,1,1);
  const d=ctx.getImageData(0,0,1,1).data;
  return [d[0],d[1],d[2],d[3]];
}

// ── Main SVG-Z Renderer ────────────────────────────────────────
class SVGZRenderer {
  constructor(canvas) {
    this.raster = new ZBufferRenderer(canvas);
    this.parser = new SVGZParser();
    this.scene = null;
    this.depthViz = false;
    this.wireframe = false;

    // Orbit camera state
    this.orbit = { theta:0, phi:0.3, radius:1, panX:0, panY:0 };
    this._drag = null;
    this._pinch = null;
    this._scrolling = false;
    this._scrollTimer = null;
    this.dirty = true;

    // TSAA — Halton(2,3) sub-pixel jitter sequence (8 taps)
    // Each tap is a (dx,dy) offset in pixel units applied to the projection.
    this.TSAA_TAPS = 8;
    this._halton = this._buildHalton(this.TSAA_TAPS);
    this._tapIdx  = 0;
    this.dirtyFrames = this.TSAA_TAPS; // how many more frames to render

    this._setupInteraction(canvas);
  }

  _setupInteraction(canvas) {
    // Prevent browser scroll/zoom from hijacking touch on the canvas
    canvas.style.touchAction = 'none';

    // ── Mouse ──────────────────────────────────────────────────
    canvas.addEventListener('mousedown', e=>{
      this._drag={x:e.clientX,y:e.clientY,button:e.button,
        theta:this.orbit.theta,phi:this.orbit.phi,
        panX:this.orbit.panX,panY:this.orbit.panY};
      e.preventDefault();
    });
    window.addEventListener('mousemove', e=>{
      if(!this._drag) return;
      const dx=(e.clientX-this._drag.x)*0.007;
      const dy=(e.clientY-this._drag.y)*0.007;
      if(this._drag.button===2||e.shiftKey){
        this.orbit.panX=this._drag.panX-dx*2;
        this.orbit.panY=this._drag.panY+dy*2;
      } else {
        this.orbit.theta=this._drag.theta+dx;
        this.orbit.phi=Math.max(-1.4,Math.min(1.4,this._drag.phi+dy));
      }
      this.dirty=true; this.dirtyFrames=this.TSAA_TAPS;
    });
    window.addEventListener('mouseup', ()=>this._drag=null);
    canvas.addEventListener('wheel', e=>{
      this.orbit.radius=Math.max(0.5,this.orbit.radius+e.deltaY*0.003);
      this._scrolling = true;
      clearTimeout(this._scrollTimer);
      this._scrollTimer = setTimeout(()=>{ this._scrolling = false; }, 150);
      this.dirty=true; this.dirtyFrames=this.TSAA_TAPS;
      e.preventDefault();
    },{passive:false});
    canvas.addEventListener('contextmenu',e=>e.preventDefault());

    // ── Touch ──────────────────────────────────────────────────
    canvas.addEventListener('touchstart', e=>{
      e.preventDefault();
      if (e.touches.length === 1) {
        const t = e.touches[0];
        this._drag = { x:t.clientX, y:t.clientY, button:0,
          theta:this.orbit.theta, phi:this.orbit.phi,
          panX:this.orbit.panX, panY:this.orbit.panY };
        this._pinch = null;
      } else if (e.touches.length === 2) {
        const dx = e.touches[1].clientX - e.touches[0].clientX;
        const dy = e.touches[1].clientY - e.touches[0].clientY;
        this._pinch = { dist: Math.hypot(dx, dy), radius: this.orbit.radius };
        this._drag = null;
      }
    },{passive:false});

    canvas.addEventListener('touchmove', e=>{
      e.preventDefault();
      if (e.touches.length === 1 && this._drag) {
        const t = e.touches[0];
        const dx = (t.clientX - this._drag.x) * 0.007;
        const dy = (t.clientY - this._drag.y) * 0.007;
        this.orbit.theta = this._drag.theta + dx;
        this.orbit.phi   = Math.max(-1.4, Math.min(1.4, this._drag.phi + dy));
        this.dirty = true; this.dirtyFrames = this.TSAA_TAPS;
      } else if (e.touches.length === 2 && this._pinch) {
        const dx   = e.touches[1].clientX - e.touches[0].clientX;
        const dy   = e.touches[1].clientY - e.touches[0].clientY;
        const dist = Math.hypot(dx, dy);
        this.orbit.radius = Math.max(0.5, this._pinch.radius * (this._pinch.dist / dist));
        this._scrolling = true;
        clearTimeout(this._scrollTimer);
        this._scrollTimer = setTimeout(()=>{ this._scrolling = false; }, 150);
        this.dirty = true; this.dirtyFrames = this.TSAA_TAPS;
      }
    },{passive:false});

    const endTouch = e=>{
      if (e.touches.length === 0) {
        this._drag = null; this._pinch = null;
      } else if (e.touches.length === 1 && this._pinch) {
        // Finger lifted from pinch — resume single-finger orbit
        const t = e.touches[0];
        this._drag = { x:t.clientX, y:t.clientY, button:0,
          theta:this.orbit.theta, phi:this.orbit.phi,
          panX:this.orbit.panX, panY:this.orbit.panY };
        this._pinch = null;
      }
    };
    canvas.addEventListener('touchend',    endTouch);
    canvas.addEventListener('touchcancel', ()=>{ this._drag=null; this._pinch=null; });
  }

  load(src) {
    this.scene = this.parser.parse(src);
    // Apply AA mode from camera element if specified (overrides external setMode call)
    if (this.scene.camera.aa) {
      this.raster.setMode(this.scene.camera.aa);
    }
    this._resetTSAA();
    return this.scene;
  }

  _buildHalton(n) {
    // Returns n (dx,dy) jitter offsets in [-0.5, 0.5] pixel space
    // using Halton bases 2 and 3
    const seq = [];
    for (let i = 1; i <= n; i++) {
      seq.push([this._haltonBase(i,2)-0.5, this._haltonBase(i,3)-0.5]);
    }
    return seq;
  }

  _haltonBase(index, base) {
    let result=0, f=1;
    while (index > 0) { f/=base; result+=f*(index%base); index=Math.floor(index/base); }
    return result;
  }

  // Reset history and request a full accumulation burst
  _resetTSAA() {
    this.dirty = true;
    this.dirtyFrames = this.TSAA_TAPS;
    this.raster.flushHistory();
  }

  // Return a jitter-modified projection matrix for the current tap
  _jitteredProj(proj, W, H) {
    if (!this.raster.tsaaOn) return proj;
    const [jx, jy] = this._halton[this._tapIdx % this.TSAA_TAPS];
    // Translate NDC by sub-pixel amount: 2*jitter/screenSize
    const tx = 2*jx/W, ty = 2*jy/H;
    const j = new Mat4([
      1,0,0,tx,
      0,1,0,ty,
      0,0,1,0,
      0,0,0,1
    ]);
    return j.mul(proj);
  }

  buildCamera() {
    if (!this.scene) return {vp:new Mat4(), proj:new Mat4()};
    const cam = this.scene.camera;
    const W=this.raster.W, H=this.raster.H;

    // Apply orbit on top of scene camera
    const base = cam.eye.sub(cam.center);
    const baseRadius = base.len() * this.orbit.radius;

    const eye = new Vec3(
      cam.center.x + this.orbit.panX + baseRadius*Math.sin(this.orbit.theta)*Math.cos(this.orbit.phi),
      cam.center.y - this.orbit.panY + baseRadius*Math.sin(this.orbit.phi),
      cam.center.z + baseRadius*Math.cos(this.orbit.theta)*Math.cos(this.orbit.phi)
    );
    const center = new Vec3(cam.center.x+this.orbit.panX, cam.center.y-this.orbit.panY, cam.center.z);

    const view = Mat4.lookAt(eye, center, cam.up);
    const proj = Mat4.perspective(cam.fov, W/H, cam.near, cam.far);
    return { view, proj, eye };
  }

  // Project 3D point → {x,y,z} in screen coords, z=NDC depth
  project(p3, view, proj, W, H) {
    const v = view.transformPoint(p3);
    const ndc = proj.transformPoint(v);
    return {
      x: (ndc.x+1)*0.5*W,
      y: (1-ndc.y)*0.5*H,
      z: ndc.z,
      viewZ: v.z
    };
  }

  render(inMotion=false) {
    if (!this.scene) return;
    const {view,proj} = this.buildCamera();
    const W=this.raster.W, H=this.raster.H;

    // Apply sub-pixel jitter to projection for this tap
    const jProj = this._jitteredProj(proj, W, H);

    const allPrims = [];
    this._collectPrims(this.scene.elements, view, jProj, W, H, allPrims, new Mat4());
    allPrims.sort((a,b)=>(a.renderOrder-b.renderOrder)||((a.avgZ-b.avgZ)));

    const isTransp = p => (p.opacity??1)<1 || ((p.fill||p.stroke||[])[3]??255)<255;
    const opaquePrims      = allPrims.filter(p => !isTransp(p));
    const transparentPrims = allPrims.filter(p =>  isTransp(p));

    // Pass 1: opaque
    const bg = parseColor(this.scene.background) || [10,10,15,255];
    this.raster.clearOpaque(bg[0], bg[1], bg[2]);
    this.raster.pass = 'opaque';
    for (const prim of opaquePrims) this._rasterize(prim);

    // Pass 2: transparent (WBOIT)
    this.raster.clearTransparent();
    this.raster.pass = 'transparent';
    for (const prim of transparentPrims) this._rasterize(prim);

    // Pass 3: WBOIT resolve
    this.raster.resolveTransparent();

    // Pass 4: TSAA temporal blend + blit
    // During motion use a higher blend (faster response, less smoothing).
    // As frames wind down toward idle, drop to a lower blend for maximum AA.
    const blendAlpha = inMotion ? 0.6 : 0.2;
    this.raster.flush(blendAlpha);

    // Advance jitter tap
    this._tapIdx = (this._tapIdx + 1) % this.TSAA_TAPS;
  }

  _collectPrims(elements, view, proj, W, H, out, groupMat) {
    for(const el of elements) {
      if(!el) continue;
      if(el.type==='group3d') {
        const m = this._parseTransform3d(el.transform) || new Mat4();
        this._collectPrims(el.children, view, proj, W, H, out, groupMat.mul(m));
        continue;
      }
      if(el.type==='path3d') {
        this._collectPath(el, view, proj, W, H, out, groupMat);
      }
      if(el.type==='polygon3d') {
        this._collectPolygon(el, view, proj, W, H, out, groupMat);
      }
      if(el.type==='sphere3d') {
        this._collectSphere(el, view, proj, W, H, out, groupMat);
      }
      if(el.type==='cylinder3d') {
        this._collectCylinder(el, view, proj, W, H, out, groupMat);
      }
      if(el.type==='lathe3d') {
        this._collectLathe(el, view, proj, W, H, out, groupMat);
      }
      if(el.type==='extrude3d') {
        this._collectExtrude(el, view, proj, W, H, out, groupMat);
      }
      if(el.type==='surface3d') {
        this._collectSurface(el, view, proj, W, H, out, groupMat);
      }
    }
  }

  _parseTransform3d(t) {
    if(!t) return null;
    const rotY = t.match(/rotateY\(([^)]+)\)/);
    const rotX = t.match(/rotateX\(([^)]+)\)/);
    const rotZ = t.match(/rotateZ\(([^)]+)\)/);
    const trans = t.match(/translate3d\(([^)]+)\)/);
    const scl = t.match(/scale3d\(([^)]+)\)/);
    let m = new Mat4();
    if(trans){const p=trans[1].split(',').map(parseFloat);m=m.mul(Mat4.translate(p[0],p[1],p[2]||0));}
    if(rotX){m=m.mul(Mat4.rotateX(parseFloat(rotX[1])*Math.PI/180));}
    if(rotY){m=m.mul(Mat4.rotateY(parseFloat(rotY[1])*Math.PI/180));}
    if(rotZ){m=m.mul(Mat4.rotateZ(parseFloat(rotZ[1])*Math.PI/180));}
    if(scl){const p=scl[1].split(',').map(parseFloat);m=m.mul(Mat4.scale(p[0],p[1],p[2]||1));}
    return m;
  }

  _collectPath(el, view, proj, W, H, out, gm) {
    const path = new Path3D(el.d3);
    const samples = path.sample(80);
    const isClosed = path.isClosed();

    // Project all sample points
    const projected = samples.map(({p})=>{
      const wp = gm.transformPoint(p);
      return this.project(wp, view, proj, W, H);
    });

    const fill = parseColor(el.fill);
    const stroke = parseColor(el.stroke);
    if (fill && isClosed) {
      out.push({
        type:'fill_path',
        pts: projected,
        fill, opacity: el.opacity,
        depthBias: el.depthBias,
        renderOrder: el.renderOrder,
        avgZ: projected.reduce((s,p)=>s+p.z,0)/projected.length
      });
    }
    if (stroke && stroke[3]>0 && el.stroke!=='none') {
      out.push({
        type:'stroke_path',
        pts: projected,
        stroke, strokeWidth: el.strokeWidth,
        opacity: el.opacity,
        depthBias: el.depthBias,
        renderOrder: el.renderOrder,
        avgZ: projected.reduce((s,p)=>s+p.z,0)/projected.length
      });
    }
  }

  _collectPolygon(el, view, proj, W, H, out, gm) {
    if(!el.points||el.points.length<3) return;
    const projected = el.points.map(p=>{
      const wp=gm.transformPoint(p);
      return this.project(wp,view,proj,W,H);
    });
    const fill = parseColor(el.fill);
    const stroke = parseColor(el.stroke);
    const avgZ = projected.reduce((s,p)=>s+p.z,0)/projected.length;

    if(fill){
      out.push({type:'fill_polygon',pts:projected,fill,opacity:el.opacity,
        depthBias:el.depthBias,renderOrder:el.renderOrder,avgZ});
    }
    if(stroke&&stroke[3]>0&&el.stroke!=='none'){
      out.push({type:'stroke_polygon',pts:projected,stroke,strokeWidth:el.strokeWidth,
        opacity:el.opacity,depthBias:el.depthBias,renderOrder:el.renderOrder,avgZ});
    }
  }

  // ── sphere3d ─────────────────────────────────────────────────
  //
  //  UV-sphere tessellation.
  //
  //  Pole fix: at ring 0 (north) and ring `rings` (south), all sectors
  //  share a single point.  We project the pole once and emit proper
  //  fan triangles (pole → edge[si], edge[si+1]) rather than quads,
  //  which eliminates the hole at both poles.
  //
  //  lat-rings / lon-lines attributes:
  //    null  → auto spacing (~6 lat, ~6 lon)
  //    0     → disabled
  //    N     → exactly N lines drawn
  //
  _collectSphere(el, view, proj, W, H, out, gm) {
    const rings   = el.subdivisions;
    const sectors = el.subdivisions * 2;

    const fill      = parseColor(el.fill);
    const stroke    = parseColor(el.stroke);
    const hasStroke = stroke && stroke[3] > 0 && el.stroke !== 'none';

    const worldCentre = gm.transformPoint(el.center);
    const r = el.radius;

    // ── Build projected vertex grid ───────────────────────────
    // verts[ri][si], ri 0..rings, si 0..sectors
    // At ri=0 all points collapse to north pole; ri=rings → south pole.
    // We still build the full grid so stroke lines have correct vertices,
    // but for fill we use the single projected pole point directly.
    const verts = [];
    for (let ri = 0; ri <= rings; ri++) {
      const phi    = Math.PI * ri / rings;
      const sinPhi = Math.sin(phi), cosPhi = Math.cos(phi);
      const row = [];
      for (let si = 0; si <= sectors; si++) {
        const theta    = 2 * Math.PI * si / sectors;
        const p = new Vec3(
          worldCentre.x + r * sinPhi * Math.cos(theta),
          worldCentre.y + r * cosPhi,
          worldCentre.z + r * sinPhi * Math.sin(theta)
        );
        row.push(this.project(p, view, proj, W, H));
      }
      verts.push(row);
    }

    // Single projected pole vertices (all sectors identical at poles)
    const northPole = verts[0][0];
    const southPole = verts[rings][0];

    const centreProj = this.project(worldCentre, view, proj, W, H);
    const avgZ = centreProj.z;

    // ── Fill triangles ────────────────────────────────────────
    if (fill) {
      const [,,, fa] = fill;
      const a   = Math.round((el.opacity ?? 1) * (fa ?? 255));
      const tris = [];

      for (let ri = 0; ri < rings; ri++) {
        for (let si = 0; si < sectors; si++) {
          if (ri === 0) {
            // North pole cap: single fan triangle
            tris.push([northPole, verts[1][si], verts[1][si+1]]);
          } else if (ri === rings - 1) {
            // South pole cap: single fan triangle
            tris.push([verts[rings-1][si], southPole, verts[rings-1][si+1]]);
          } else {
            // Body quad → two triangles
            const v00 = verts[ri]  [si],   v01 = verts[ri]  [si+1];
            const v10 = verts[ri+1][si],   v11 = verts[ri+1][si+1];
            tris.push([v00, v10, v11]);
            tris.push([v00, v11, v01]);
          }
        }
      }

      out.push({
        type: 'sphere_tris',
        tris, fill, a,
        depthBias:   el.depthBias,
        renderOrder: el.renderOrder,
        opacity:     el.opacity,
        avgZ,
        depthVizZ:   avgZ,
      });
    }

    // ── Stroke: latitude rings + longitude lines ──────────────
    if (hasStroke) {
      // Determine counts:
      //   null → auto (~6 of each)   0 → off   N → exactly N
      const autoLat = el.latRings === null;
      const autoLon = el.lonLines === null;
      const nLat    = autoLat ? 6 : el.latRings;
      const nLon    = autoLon ? 6 : el.lonLines;

      // Latitude rings — evenly spaced through the body (skip poles)
      if (nLat > 0) {
        for (let i = 1; i <= nLat; i++) {
          const ri = Math.round(i * rings / (nLat + 1));
          if (ri <= 0 || ri >= rings) continue;
          const pts = [];
          for (let si = 0; si <= sectors; si++) pts.push(verts[ri][si]);
          out.push({
            type: 'stroke_path', pts,
            stroke, strokeWidth: el.strokeWidth,
            opacity: el.opacity, depthBias: el.depthBias,
            renderOrder: el.renderOrder, avgZ
          });
        }
      }

      // Longitude lines — meridians from pole to pole
      if (nLon > 0) {
        for (let i = 0; i < nLon; i++) {
          const si = Math.round(i * sectors / nLon);
          const pts = [];
          for (let ri = 0; ri <= rings; ri++) pts.push(verts[ri][si]);
          out.push({
            type: 'stroke_path', pts,
            stroke, strokeWidth: el.strokeWidth,
            opacity: el.opacity, depthBias: el.depthBias,
            renderOrder: el.renderOrder, avgZ
          });
        }
      }
    }
  }

  // ── cylinder3d ───────────────────────────────────────────────
  //
  //  Generates a cylinder (or cone frustum when radius2 is set)
  //  between two arbitrary 3D endpoints.
  //
  //  The local frame is built from the axis vector so the cylinder
  //  always aligns between start→end regardless of orientation.
  //
  //  Cap geometry uses a proper triangle fan from the centre point
  //  so there are no holes at the cap centres.
  //
  //  Attributes:
  //    start / end       endpoint positions (Vec3)
  //    radius            radius at start end
  //    radius2           radius at end (null → same as radius = true cylinder)
  //    subdivisions      sectors around circumference (3–128)
  //    cap-start/end     "true"/"false" — whether to close the ends
  //    rings             null=auto, 0=off, N=N  ring strokes along barrel
  //    lines             null=auto, 0=off, N=N  line strokes along barrel
  //
  _collectCylinder(el, view, proj, W, H, out, gm) {
    const secs  = el.subdivisions;
    const rA    = el.radius;
    const rB    = el.radius2 !== null ? el.radius2 : rA;

    // World-space endpoints
    const wStart = gm.transformPoint(el.start);
    const wEnd   = gm.transformPoint(el.end);

    // ── Build local orthonormal frame aligned to axis ─────────
    const axis = wEnd.sub(wStart);
    const len  = axis.len();
    if (len < 1e-8) return;           // degenerate — zero-length cylinder
    const axisN = axis.scale(1/len);

    // Pick an up vector not parallel to the axis
    const worldUp = Math.abs(axisN.y) < 0.99 ? new Vec3(0,1,0) : new Vec3(1,0,0);
    const right   = axisN.cross(worldUp).norm();
    const up      = right.cross(axisN).norm();  // truly perpendicular to axis

    // ── Build projected rings ─────────────────────────────────
    // ringVerts[0] = start ring,  ringVerts[1] = end ring
    const buildRing = (centre, radius) => {
      const row = [];
      for (let si = 0; si <= secs; si++) {
        const theta = 2 * Math.PI * si / secs;
        const p = new Vec3(
          centre.x + radius * (Math.cos(theta)*right.x + Math.sin(theta)*up.x),
          centre.y + radius * (Math.cos(theta)*right.y + Math.sin(theta)*up.y),
          centre.z + radius * (Math.cos(theta)*right.z + Math.sin(theta)*up.z)
        );
        row.push(this.project(p, view, proj, W, H));
      }
      return row;
    };

    const ringStart = buildRing(wStart, rA);
    const ringEnd   = buildRing(wEnd,   rB);

    const pStart = this.project(wStart, view, proj, W, H);
    const pEnd   = this.project(wEnd,   view, proj, W, H);
    const avgZ   = (pStart.z + pEnd.z) * 0.5;

    const fill      = parseColor(el.fill);
    const stroke    = parseColor(el.stroke);
    const hasStroke = stroke && stroke[3] > 0 && el.stroke !== 'none';

    // ── Fill triangles ────────────────────────────────────────
    if (fill) {
      const [,,,fa] = fill;
      const a    = Math.round((el.opacity ?? 1) * (fa ?? 255));
      const tris = [];

      // Barrel — one quad (two tris) per sector
      for (let si = 0; si < secs; si++) {
        const s0 = ringStart[si],   s1 = ringStart[si+1];
        const e0 = ringEnd[si],     e1 = ringEnd[si+1];
        tris.push([s0, e0, e1]);
        tris.push([s0, e1, s1]);
      }

      // Start cap — fan from projected centre
      if (el.capStart && rA > 0) {
        for (let si = 0; si < secs; si++) {
          tris.push([pStart, ringStart[si+1], ringStart[si]]);
        }
      }

      // End cap — fan from projected centre
      if (el.capEnd && rB > 0) {
        for (let si = 0; si < secs; si++) {
          tris.push([pEnd, ringEnd[si], ringEnd[si+1]]);
        }
      }

      out.push({
        type: 'sphere_tris',   // reuse the triangle-list rasterize path
        tris, fill, a,
        depthBias:   el.depthBias,
        renderOrder: el.renderOrder,
        opacity:     el.opacity,
        avgZ,
        depthVizZ:   avgZ,
      });
    }

    // ── Stroke ────────────────────────────────────────────────
    if (hasStroke) {
      const push = pts => out.push({
        type: 'stroke_path', pts,
        stroke, strokeWidth: el.strokeWidth,
        opacity: el.opacity, depthBias: el.depthBias,
        renderOrder: el.renderOrder, avgZ
      });

      // Cap-edge circles
      if (el.capStart) push([...ringStart]);
      if (el.capEnd)   push([...ringEnd]);

      // Longitudinal lines along the barrel
      const nLines = el.lines === null ? 6 : el.lines;
      for (let i = 0; i < nLines; i++) {
        const si = Math.round(i * secs / nLines);
        push([ringStart[si], ringEnd[si]]);
      }

      // Ring lines — cross-section circles spaced along the barrel
      const nRings = el.rings === null ? 0 : el.rings; // default: none
      for (let ri = 1; ri <= nRings; ri++) {
        const t = ri / (nRings + 1);
        const ringMid = buildRing(
          new Vec3(
            wStart.x + axis.x*t,
            wStart.y + axis.y*t,
            wStart.z + axis.z*t
          ),
          rA + (rB - rA) * t
        );
        push([...ringMid]);
      }
    }
  }

  // ── lathe3d ──────────────────────────────────────────────────
  //
  //  Revolves a 2D profile curve around a chosen axis to produce a
  //  surface of revolution.
  //
  //  The profile is defined in a local 2D plane where:
  //    x  =  radial distance from the axis  (must be >= 0 for sensible results)
  //    y  =  position along the axis
  //
  //  Axis mapping (origin is the world-space pivot point):
  //    'y'  →  revolve around world Y  (default — vase, bottle, column)
  //    'x'  →  revolve around world X  (donut on its side)
  //    'z'  →  revolve around world Z
  //
  //  A sweep < 360° produces a partial revolution with optional caps
  //  on the cut faces (cap-start / cap-end).
  //
  //  Tessellation:
  //    profileSamples  — how many points sample the 2D profile curve
  //    subdivisions    — how many sectors around the revolution
  //
  _collectLathe(el, view, proj, W, H, out, gm) {
    const secs    = el.subdivisions;
    const sweepR  = el.sweep * Math.PI / 180;
    const origin  = gm.transformPoint(el.origin);

    // ── Sample the 2D profile ─────────────────────────────────
    const profile = this.parser.parseProfile2D(el.d2, el.profileSamples);
    if (profile.length < 2) return;

    // ── Map axis name → world-space basis vectors ─────────────
    // localR: radial direction for profile.x
    // localY: axial direction for profile.y
    let localR, localY;
    switch (el.axis) {
      case 'x': localR = new Vec3(0,0,1); localY = new Vec3(1,0,0); break;
      case 'z': localR = new Vec3(1,0,0); localY = new Vec3(0,0,1); break;
      default:  localR = new Vec3(1,0,0); localY = new Vec3(0,1,0); break; // 'y'
    }

    // ── Build 3D vertex grid ──────────────────────────────────
    // verts[si][pi] where si=sector, pi=profile point
    // For each sector angle θ, rotate localR around localY by θ.
    const verts = [];
    for (let si = 0; si <= secs; si++) {
      const theta  = sweepR * si / secs;
      const cosT   = Math.cos(theta), sinT = Math.sin(theta);
      // Rotate localR around localY by theta (Rodrigues' formula simplified
      // since localR ⊥ localY)
      const radDir = new Vec3(
        localR.x*cosT + localY.cross(localR).x*sinT,
        localR.y*cosT + localY.cross(localR).y*sinT,
        localR.z*cosT + localY.cross(localR).z*sinT
      );
      const row = [];
      for (const pt of profile) {
        const radius = Math.max(0, pt.x);  // clamp negative radii to 0
        const p = new Vec3(
          origin.x + radDir.x*radius + localY.x*pt.y,
          origin.y + radDir.y*radius + localY.y*pt.y,
          origin.z + radDir.z*radius + localY.z*pt.y
        );
        row.push(this.project(p, view, proj, W, H));
      }
      verts.push(row);
    }

    const centreProj = this.project(origin, view, proj, W, H);
    const avgZ = centreProj.z;

    const fill      = parseColor(el.fill);
    const stroke    = parseColor(el.stroke);
    const hasStroke = stroke && stroke[3] > 0 && el.stroke !== 'none';
    const nProf     = profile.length;

    // ── Fill — quads across (sector × profile) grid ───────────
    if (fill) {
      const [,,,fa] = fill;
      const a    = Math.round((el.opacity ?? 1) * (fa ?? 255));
      const tris = [];

      for (let si = 0; si < secs; si++) {
        for (let pi = 0; pi < nProf - 1; pi++) {
          const v00 = verts[si]  [pi],   v01 = verts[si]  [pi+1];
          const v10 = verts[si+1][pi],   v11 = verts[si+1][pi+1];

          // Collapse degenerate quads where both radii are zero
          const r0 = Math.max(0, profile[pi].x);
          const r1 = Math.max(0, profile[pi+1].x);

          if (r0 < 1e-6 && r1 < 1e-6) continue; // both on-axis: skip

          if (r0 < 1e-6) {
            // Axis pole: fan from shared pole point to next ring edge
            // v00 and v10 are both at radius=0 (same 3D point), so use v00+v01+v11
            tris.push([v00, v01, v11]);
          } else if (r1 < 1e-6) {
            // Bottom of cone: single triangle
            tris.push([v00, v10, v01]);
          } else {
            // Normal quad: two triangles
            tris.push([v00, v10, v11]);
            tris.push([v00, v11, v01]);
          }
        }
      }

      // ── Partial sweep caps ────────────────────────────────────
      const partial = el.sweep < 359.9;
      if (partial) {
        // Build cap polygon for start (si=0) and end (si=secs) faces
        const buildCapTris = (si) => {
          // Find the axis centre at the cap face, then fan-triangulate
          // from the midpoint of the axis-touching part of the profile.
          // Simple approach: find a sensible centroid from profile points.
          const capVerts = verts[si];
          // Centroid in screen space
          let cx=0,cy=0,cz=0;
          for (const v of capVerts) { cx+=v.x; cy+=v.y; cz+=v.z; }
          cx/=capVerts.length; cy/=capVerts.length; cz/=capVerts.length;
          const centre = {x:cx, y:cy, z:cz};
          for (let pi = 0; pi < nProf-1; pi++) {
            tris.push([centre, capVerts[pi], capVerts[pi+1]]);
          }
          // Close the polygon: connect last point back to first
          tris.push([centre, capVerts[nProf-1], capVerts[0]]);
        };
        if (el.capStart) buildCapTris(0);
        if (el.capEnd)   buildCapTris(secs);
      }

      out.push({
        type: 'sphere_tris',
        tris, fill, a,
        depthBias:   el.depthBias,
        renderOrder: el.renderOrder,
        opacity:     el.opacity,
        avgZ,
        depthVizZ:   avgZ,
      });
    }

    // ── Stroke — profile curves + optional silhouette rings ───
    if (hasStroke) {
      const push = pts => out.push({
        type: 'stroke_path', pts,
        stroke, strokeWidth: el.strokeWidth,
        opacity: el.opacity, depthBias: el.depthBias,
        renderOrder: el.renderOrder, avgZ
      });

      // ── Vertical profile lines (follow the profile around the surface) ──
      // null → auto: draw sweep edges (start + end on partial, just start
      //               on full revolution) plus evenly-spaced meridians
      // 0   → off (no vertical lines at all)
      // N   → exactly N lines evenly distributed around the sweep
      const partial = el.sweep < 359.9;
      const nLines = el.lines === null
        ? (partial ? 2 : 6)   // auto: sweep edges on partial, 6 meridians on full
        : el.lines;

      if (nLines > 0) {
        if (partial) {
          // Always draw the two sweep-edge profiles
          push(verts[0]);
          push(verts[secs]);
          // Extra lines between them
          for (let i = 1; i < nLines - 1; i++) {
            const si = Math.round(i * secs / (nLines - 1));
            push(verts[si]);
          }
        } else {
          // Full revolution: distribute evenly
          for (let i = 0; i < nLines; i++) {
            const si = Math.round(i * secs / nLines);
            push(verts[si]);
          }
        }
      }

      // ── Horizontal rings (cross-section circles along the profile) ──
      // null → auto: ~8 rings evenly spaced along the profile
      // 0   → off
      // N   → exactly N rings
      const nRings = el.rings === null ? 8 : el.rings;

      if (nRings > 0) {
        for (let i = 0; i <= nRings; i++) {
          const pi = Math.round(i * (nProf - 1) / nRings);
          const ring = [];
          for (let si = 0; si <= secs; si++) ring.push(verts[si][pi]);
          push(ring);
        }
      }
    }
  }

  // ── extrude3d ─────────────────────────────────────────────────
  //
  //  Extrudes a 2D profile along a 3D direction vector.
  //
  //  The profile is defined in a local 2D plane, oriented by axisX
  //  and axisY world vectors.  The extrusion travels along dir×depth.
  //
  //  Cap triangulation uses ear-clipping so concave profiles (stars,
  //  letters, irregular polygons) produce correct filled faces without
  //  the artefacts of fan triangulation.
  //
  //  Attributes summary:
  //    d2              2D profile path (M/L/C/Q/Z, 2D coords)
  //    origin          world-space anchor of start face
  //    dir             extrusion direction (normalised internally)
  //    depth           length of extrusion
  //    axis-x/axis-y   orient the profile plane in world space
  //    steps           slices along depth (1=plain, >1 adds stroke rings)
  //    profile-samples curve sampling density
  //    cap-start/end   fill the end faces
  //    rings           cross-section stroke rings (null=auto, 0=off, N=N)
  //    lines           profile-edge strokes along barrel (null=auto, 0=off, N=N)
  //
  _collectExtrude(el, view, proj, W, H, out, gm) {
    // ── Setup ─────────────────────────────────────────────────
    const origin = gm.transformPoint(el.origin);
    const axisX  = el.axisX.norm();
    const axisY  = el.axisY.norm();
    const dirN   = el.dir.norm();
    const extVec = dirN.scale(el.depth);   // full extrusion vector

    // ── Sample 2D profile → 3D points on start face ───────────
    const profile2D = this.parser.parseProfile2D(el.d2, el.profileSamples);
    if (profile2D.length < 2) return;

    // Map 2D profile point → 3D world position at a given step t∈[0,1]
    const profileTo3D = (pt2d, t) => new Vec3(
      origin.x + axisX.x*pt2d.x + axisY.x*pt2d.y + extVec.x*t,
      origin.y + axisX.y*pt2d.x + axisY.y*pt2d.y + extVec.y*t,
      origin.z + axisX.z*pt2d.x + axisY.z*pt2d.y + extVec.z*t
    );

    const steps  = el.steps;
    const nProf  = profile2D.length;

    // Build projected vertex grid: verts[step][profileIdx]
    // step 0 = start face, step `steps` = end face
    const verts = [];
    for (let st = 0; st <= steps; st++) {
      const t = st / steps;
      const row = profile2D.map(pt => {
        const p = profileTo3D(pt, t);
        const wp = gm.transformPoint ? p : p; // already in world space
        return this.project(p, view, proj, W, H);
      });
      verts.push(row);
    }

    const pStart = this.project(origin, view, proj, W, H);
    const pEnd   = this.project(
      new Vec3(origin.x+extVec.x, origin.y+extVec.y, origin.z+extVec.z),
      view, proj, W, H
    );
    const avgZ = (pStart.z + pEnd.z) * 0.5;

    const fill      = parseColor(el.fill);
    const stroke    = parseColor(el.stroke);
    const hasStroke = stroke && stroke[3] > 0 && el.stroke !== 'none';

    // ── Fill triangles ────────────────────────────────────────
    if (fill) {
      const [,,,fa] = fill;
      const a    = Math.round((el.opacity ?? 1) * (fa ?? 255));
      const tris = [];

      // Barrel: quads between consecutive steps
      for (let st = 0; st < steps; st++) {
        for (let pi = 0; pi < nProf - 1; pi++) {
          const v00 = verts[st]  [pi],   v01 = verts[st]  [pi+1];
          const v10 = verts[st+1][pi],   v11 = verts[st+1][pi+1];
          tris.push([v00, v10, v11]);
          tris.push([v00, v11, v01]);
        }
        // Close the loop if profile is closed
        if (this._profileIsClosed(profile2D)) {
          const pi = nProf - 1;
          const v00 = verts[st][pi],    v01 = verts[st][0];
          const v10 = verts[st+1][pi],  v11 = verts[st+1][0];
          tris.push([v00, v10, v11]);
          tris.push([v00, v11, v01]);
        }
      }

      // Caps: ear-clip the 2D profile then map to 3D
      if (el.capStart) {
        const capTris = this._earClip(profile2D);
        for (const [i0,i1,i2] of capTris) {
          // Reverse winding for start cap (faces outward)
          tris.push([verts[0][i0], verts[0][i2], verts[0][i1]]);
        }
      }
      if (el.capEnd) {
        const capTris = this._earClip(profile2D);
        for (const [i0,i1,i2] of capTris) {
          tris.push([verts[steps][i0], verts[steps][i1], verts[steps][i2]]);
        }
      }

      out.push({
        type: 'sphere_tris',
        tris, fill, a,
        depthBias:   el.depthBias,
        renderOrder: el.renderOrder,
        opacity:     el.opacity,
        avgZ,
        depthVizZ:   avgZ,
      });
    }

    // ── Stroke ────────────────────────────────────────────────
    if (hasStroke) {
      const push = pts => out.push({
        type: 'stroke_path', pts,
        stroke, strokeWidth: el.strokeWidth,
        opacity: el.opacity, depthBias: el.depthBias,
        renderOrder: el.renderOrder, avgZ
      });

      // Cap outlines — always close the loop for a clean border
      const closePts = pts => this._profileIsClosed(profile2D)
        ? [...pts, pts[0]] : pts;
      if (el.capStart) push(closePts([...verts[0]]));
      if (el.capEnd)   push(closePts([...verts[steps]]));

      // Longitudinal lines: profile edges running along the extrusion
      // null=auto(4), 0=off, N=N
      const nLines = el.lines === null ? 4 : el.lines;
      for (let i = 0; i < nLines; i++) {
        const pi = Math.round(i * (nProf - 1) / Math.max(1, nLines - 1));
        const pts = [];
        for (let st = 0; st <= steps; st++) pts.push(verts[st][Math.min(pi, nProf-1)]);
        push(pts);
      }

      // Cross-section rings: evenly spaced in world space along the extrusion
      // null=auto(1 ring at midpoint when steps=1, otherwise interior steps)
      // 0=off, N=N rings at evenly-spaced t values
      const nRings = el.rings === null
        ? (steps <= 1 ? 1 : steps - 1)
        : el.rings;
      for (let i = 1; i <= nRings; i++) {
        const t = i / (nRings + 1);
        // Project a fresh ring at this t along the extrusion
        const ringPts = profile2D.map(pt => {
          const p = profileTo3D(pt, t);
          return this.project(p, view, proj, W, H);
        });
        if (this._profileIsClosed(profile2D)) ringPts.push(ringPts[0]);
        push(ringPts);
      }
    }
  }

  // Check if a 2D profile is closed (first ≈ last point)
  _profileIsClosed(profile) {
    if (profile.length < 2) return false;
    const first = profile[0], last = profile[profile.length-1];
    return Math.abs(first.x-last.x) < 1e-4 && Math.abs(first.y-last.y) < 1e-4;
  }

  // ── Ear-clip triangulation for 2D polygon caps ────────────────
  //
  //  Works for simple polygons (convex or concave, no self-intersections).
  //  Returns [[i0,i1,i2], ...] index triples into the profile array.
  //
  _earClip(profile) {
    // Build a deduplicated index list — skip last point if it duplicates first
    const closed = this._profileIsClosed(profile);
    const n = closed ? profile.length - 1 : profile.length;
    if (n < 3) return [];

    // Compute signed area to determine winding
    let area = 0;
    for (let i = 0; i < n; i++) {
      const j = (i+1) % n;
      area += profile[i].x * profile[j].y - profile[j].x * profile[i].y;
    }
    // If CW, reverse the index order so we always work CCW
    const indices = Array.from({length: n}, (_,i) => area < 0 ? n-1-i : i);

    const tris = [];
    // pt(i) looks up the original profile using the (possibly reversed) index list
    const pt = i => profile[indices[i]];

    const isEar = (remaining, pos) => {
      const len  = remaining.length;
      const prev = remaining[(pos-1+len) % len];
      const curr = remaining[pos];
      const next = remaining[(pos+1) % len];
      const a = pt(prev), b = pt(curr), c = pt(next);
      // Must be a left turn (convex vertex in CCW polygon)
      if ((b.x-a.x)*(c.y-a.y) - (b.y-a.y)*(c.x-a.x) <= 0) return false;
      // No other remaining vertex inside the triangle
      for (let i = 0; i < remaining.length; i++) {
        const p = remaining[i];
        if (p === prev || p === curr || p === next) continue;
        const v = pt(p);
        const d1 = (v.x-b.x)*(a.y-b.y) - (a.x-b.x)*(v.y-b.y);
        const d2 = (v.x-c.x)*(b.y-c.y) - (b.x-c.x)*(v.y-c.y);
        const d3 = (v.x-a.x)*(c.y-a.y) - (c.x-a.x)*(v.y-a.y);
        const hasNeg = (d1<0)||(d2<0)||(d3<0);
        const hasPos = (d1>0)||(d2>0)||(d3>0);
        if (!(hasNeg && hasPos)) return false;
      }
      return true;
    };

    // Work with positions into the indices array (not raw profile indices)
    let remaining = Array.from({length: n}, (_,i) => i);
    let safety = n * n + 10;

    while (remaining.length > 3 && safety-- > 0) {
      let clipped = false;
      for (let i = 0; i < remaining.length; i++) {
        if (isEar(remaining, i)) {
          const prev = remaining[(i-1+remaining.length) % remaining.length];
          const curr = remaining[i];
          const next = remaining[(i+1) % remaining.length];
          // Return original profile indices (un-reversed) so verts[][] lookup works
          tris.push([indices[prev], indices[curr], indices[next]]);
          remaining.splice(i, 1);
          clipped = true;
          break;
        }
      }
      if (!clipped) break;
    }
    if (remaining.length === 3) {
      tris.push([indices[remaining[0]], indices[remaining[1]], indices[remaining[2]]]);
    }
    return tris;
  }

  // ── surface3d ─────────────────────────────────────────────────
  //
  //  Evaluates one or more bicubic Bézier patches defined by the `d3`
  //  attribute.  Each `B` command introduces 16 control points that
  //  form a 4×4 grid spanning the patch.
  //
  //  Evaluation uses the standard Bernstein basis:
  //    P(u,v) = Σ_i Σ_j B_i(u) · B_j(v) · P[i][j]
  //  where B_k(t) are the cubic Bernstein polynomials:
  //    B_0(t) = (1-t)³   B_1(t) = 3t(1-t)²
  //    B_2(t) = 3t²(1-t) B_3(t) = t³
  //
  //  Each patch is tessellated into a (sub+1)×(sub+1) vertex grid and
  //  rasterised as quad pairs.  Stroke iso-lines follow constant u or v
  //  parameter curves across the patch.
  //
  //  Attributes:
  //    d3            one or more B commands with 16 3D control points each
  //    subdivisions  tessellation density per patch (2–64)
  //    rings         iso-V lines (u = const)  null=auto, 0=off, N=N
  //    lines         iso-U lines (v = const)  null=auto, 0=off, N=N
  //
  _collectSurface(el, view, proj, W, H, out, gm) {
    const patches = this.parser.parseSurface3D(el.d3);
    if (patches.length === 0) return;

    const sub     = el.subdivisions;
    const fill    = parseColor(el.fill);
    const stroke  = parseColor(el.stroke);
    const hasStroke = stroke && stroke[3] > 0 && el.stroke !== 'none';

    // Bernstein basis weights for t
    const B = (t) => {
      const mt = 1 - t;
      return [mt*mt*mt, 3*t*mt*mt, 3*t*t*mt, t*t*t];
    };

    // Evaluate one patch at (u,v) ∈ [0,1]²
    const evalPatch = (grid, u, v) => {
      const bu = B(u), bv = B(v);
      let x=0, y=0, z=0;
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
          const w = bu[i] * bv[j];
          x += w * grid[i][j].x;
          y += w * grid[i][j].y;
          z += w * grid[i][j].z;
        }
      }
      return new Vec3(x, y, z);
    };

    const allTris   = [];
    const allStrokes = [];

    for (const grid of patches) {
      // Apply group transform to control points
      const tGrid = grid.map(row => row.map(p => gm.transformPoint(p)));

      // Build (sub+1)×(sub+1) projected vertex grid
      const verts = [];
      for (let ui = 0; ui <= sub; ui++) {
        const u = ui / sub;
        const row = [];
        for (let vi = 0; vi <= sub; vi++) {
          const v = vi / sub;
          const p3 = evalPatch(tGrid, u, v);
          row.push(this.project(p3, view, proj, W, H));
        }
        verts.push(row);
      }

      // ── Fill: quad pairs across the grid ─────────────────────
      if (fill) {
        for (let ui = 0; ui < sub; ui++) {
          for (let vi = 0; vi < sub; vi++) {
            const v00 = verts[ui]  [vi],   v01 = verts[ui]  [vi+1];
            const v10 = verts[ui+1][vi],   v11 = verts[ui+1][vi+1];
            allTris.push([v00, v10, v11]);
            allTris.push([v00, v11, v01]);
          }
        }
      }

      // ── Strokes: iso-parameter curves ─────────────────────────
      if (hasStroke) {
        // iso-U lines: v = const, u varies  (horizontal ribbons)
        // null=auto(sub+1), 0=off, N=N
        const nLines = el.lines === null ? Math.max(2, Math.round(sub/2)) : el.lines;
        if (nLines > 0) {
          for (let i = 0; i <= nLines; i++) {
            const vi = Math.round(i * sub / nLines);
            const pts = verts.map(row => row[Math.min(vi, sub)]);
            allStrokes.push(pts);
          }
        }

        // iso-V lines: u = const, v varies  (vertical ribbons)
        // null=auto(sub+1), 0=off, N=N
        const nRings = el.rings === null ? Math.max(2, Math.round(sub/2)) : el.rings;
        if (nRings > 0) {
          for (let i = 0; i <= nRings; i++) {
            const ui = Math.round(i * sub / nRings);
            const pts = verts[Math.min(ui, sub)];
            allStrokes.push(pts);
          }
        }
      }
    }

    // Compute avgZ from all triangle vertices
    let zSum = 0, zCount = 0;
    for (const [v0,v1,v2] of allTris) {
      zSum += v0.z + v1.z + v2.z; zCount += 3;
    }
    const avgZ = zCount > 0 ? zSum / zCount : 0;

    if (fill && allTris.length > 0) {
      const [,,,fa] = fill;
      const a = Math.round((el.opacity ?? 1) * (fa ?? 255));
      out.push({
        type: 'sphere_tris',
        tris: allTris, fill, a,
        depthBias:   el.depthBias,
        renderOrder: el.renderOrder,
        opacity:     el.opacity,
        avgZ,
        depthVizZ:   avgZ,
      });
    }

    if (hasStroke) {
      for (const pts of allStrokes) {
        out.push({
          type: 'stroke_path', pts,
          stroke, strokeWidth: el.strokeWidth,
          opacity: el.opacity, depthBias: el.depthBias,
          renderOrder: el.renderOrder, avgZ
        });
      }
    }
  }

  _depthColor(z) {
    // Map NDC z [-1,1] to color gradient (near=red,mid=blue,far=green)
    const t=Math.max(0,Math.min(1,(z+1)*0.5));
    const r=Math.round(255*(1-t));
    const g=Math.round(255*t);
    const b=Math.round(180*(0.5-Math.abs(t-0.5))*2);
    return [r,g,b,255];
  }

  _rasterize(prim) {
    if(prim.type==='fill_path'||prim.type==='fill_polygon') {
      const pts=prim.pts;
      if(pts.length<3) return;
      // Fan triangulation from centroid
      let cx=0,cy=0,cz=0;
      for(const p of pts){cx+=p.x;cy+=p.y;cz+=p.z;}
      cx/=pts.length;cy/=pts.length;cz/=pts.length;
      const center={x:cx,y:cy,z:cz+prim.depthBias};

      let [r,g,b,a]=this.depthViz?this._depthColor(cz):prim.fill;
      a=Math.round((prim.opacity??1)*(a??255));

      for(let i=0;i<pts.length;i++){
        const p0=pts[i], p1=pts[(i+1)%pts.length];
        this.raster.fillTriangle(
          {x:center.x,y:center.y,z:center.z},
          {x:p0.x,y:p0.y,z:p0.z+prim.depthBias},
          {x:p1.x,y:p1.y,z:p1.z+prim.depthBias},
          r,g,b,a,0
        );
      }
    }
    if(prim.type==='sphere_tris') {
      let [r,g,b] = this.depthViz ? this._depthColor(prim.depthVizZ) : prim.fill;
      const a = this.depthViz ? 255 : prim.a;
      for (const [v0,v1,v2] of prim.tris) {
        this.raster.fillTriangle(
          {x:v0.x, y:v0.y, z:v0.z + prim.depthBias},
          {x:v1.x, y:v1.y, z:v1.z + prim.depthBias},
          {x:v2.x, y:v2.y, z:v2.z + prim.depthBias},
          r, g, b, a
        );
      }
    }
    if(prim.type==='stroke_path'||prim.type==='stroke_polygon') {
      const pts=prim.pts;
      let [r,g,b,a]=this.depthViz?this._depthColor(prim.avgZ):prim.stroke;
      a=Math.round((prim.opacity??1)*(a??255));
      for(let i=0;i<pts.length-(prim.type==='stroke_path'?1:0);i++){
        const p0=pts[i],p1=pts[(i+1)%pts.length];
        if(this.depthViz){
          [r,g,b,a]=this._depthColor((p0.z+p1.z)/2);
          a=255;
        }
        this.raster.drawLine(p0.x,p0.y,p0.z+prim.depthBias,p1.x,p1.y,p1.z+prim.depthBias,r,g,b,a,prim.strokeWidth,0);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════
//  PUBLIC API
// ═══════════════════════════════════════════════════════════════

const SVGZ = {
  /**
   * Parse and render a SVG-Z source string to a canvas element.
   * Returns the SVGZRenderer instance so the caller can attach
   * orbit interaction, change AA mode, etc.
   *
   * @param {HTMLCanvasElement} canvas
   * @param {string} source  — SVG-Z XML string
   * @param {object} [opts]
   * @param {string} [opts.aaMode]  — 'tsaa'|'msaa2'|'msaa4'|'off'  (default: 'tsaa')
   * @param {boolean} [opts.interactive]  — attach orbit/zoom/pan controls (default: true)
   * @param {boolean} [opts.autoRotate]   — start with auto-rotation (default: false)
   * @returns {SVGZRenderer}
   */
  render(canvas, source, opts = {}) {
    const { aaMode = 'tsaa', interactive = true, autoRotate = false } = opts;
    const renderer = new SVGZRenderer(canvas, { interactive });
    renderer.raster.setMode(aaMode);
    renderer.load(source);
    renderer._resetTSAA();

    let lastTime = performance.now(), frameCount = 0;
    const loop = (time) => {
      requestAnimationFrame(loop);
      const inMotion = autoRotate || renderer._drag !== null || renderer._scrolling;
      if (inMotion) {
        if (autoRotate) renderer.orbit.theta += 0.008;
        renderer.dirty = true;
        renderer.dirtyFrames = renderer.TSAA_TAPS;
      }
      if (renderer.dirtyFrames <= 0) return;
      renderer.dirtyFrames--;
      if (renderer.dirtyFrames === 0) renderer.dirty = false;
      renderer.render(inMotion);
    };
    loop(performance.now());
    return renderer;
  },

  /**
   * Auto-discover every <svgz> tag in the document and render it.
   * Replaces the tag with a <canvas> of the same dimensions.
   * Call after DOMContentLoaded, or at the end of <body>.
   *
   * @param {object} [opts]  — same options as SVGZ.render()
   */
  init(opts = {}) {
    document.querySelectorAll('svgz').forEach(tag => {
      const w = parseInt(tag.getAttribute('width'))  || 500;
      const h = parseInt(tag.getAttribute('height')) || 500;
      const canvas = document.createElement('canvas');
      canvas.width  = w;
      canvas.height = h;
      canvas.style.display = 'block';
      tag.replaceWith(canvas);
      SVGZ.render(canvas, tag.outerHTML.replace(/^<canvas[^>]*>.*<\/canvas>$/, '') || new XMLSerializer().serializeToString(tag), opts);
    });
  },

  /**
   * Parse a SVG-Z source string and return the scene graph
   * without rendering. Useful for inspecting or transforming scenes.
   *
   * @param {string} source
   * @returns {object}  scene graph
   */
  parse(source) {
    return new SVGZParser().parse(source);
  },

  // Expose classes for advanced use
  SVGZRenderer,
  SVGZParser,
  ZBufferRenderer,
  Vec3,
  Mat4,
};

// ESM export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SVGZ;
} else if (typeof define === 'function' && define.amd) {
  define([], () => SVGZ);
} else {
  window.SVGZ = SVGZ;
}
