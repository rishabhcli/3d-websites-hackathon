/**
 * postfx.js — minimal HDR bloom + filmic composite, written by hand so the
 * bloom pulse on station arrival is directly controllable.
 *
 * scene -> HDR target -> bright pass (1/2) -> separable blur (1/2 and 1/4)
 *       -> composite (tone map + vignette + grain + gamma) -> canvas
 */
import * as THREE from 'three';

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const BRIGHT = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform float uThreshold;
uniform float uKnee;
void main() {
  vec3 c = texture2D(tSrc, vUv).rgb;
  float l = max(c.r, max(c.g, c.b));
  float soft = clamp(l - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-5);
  float contrib = max(soft, l - uThreshold) / max(l, 1e-5);
  gl_FragColor = vec4(c * contrib, 1.0);
}`;

const BLUR = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uDir;
void main() {
  vec3 sum = texture2D(tSrc, vUv).rgb * 0.2270270270;
  sum += texture2D(tSrc, vUv + uDir * 1.3846153846).rgb * 0.3162162162;
  sum += texture2D(tSrc, vUv - uDir * 1.3846153846).rgb * 0.3162162162;
  sum += texture2D(tSrc, vUv + uDir * 3.2307692308).rgb * 0.0702702703;
  sum += texture2D(tSrc, vUv - uDir * 3.2307692308).rgb * 0.0702702703;
  gl_FragColor = vec4(sum, 1.0);
}`;

const COMPOSITE = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tScene;
uniform sampler2D tBloomA;
uniform sampler2D tBloomB;
uniform float uBloom;
uniform float uExposure;
uniform float uTime;
uniform float uVignette;
void main() {
  vec3 c = texture2D(tScene, vUv).rgb;
  vec3 b = texture2D(tBloomA, vUv).rgb + texture2D(tBloomB, vUv).rgb * 1.35;
  c += b * uBloom;
  c *= uExposure;
  c = vec3(1.0) - exp(-c);                       // filmic-ish roll-off
  vec2 d = vUv - 0.5;
  float vig = 1.0 - uVignette * dot(d, d) * 1.5;
  c *= clamp(vig, 0.0, 1.0);
  float g = fract(sin(dot(vUv * 1024.0 + uTime, vec2(12.9898, 78.233))) * 43758.5453);
  c += (g - 0.5) * 0.016;
  gl_FragColor = vec4(pow(max(c, 0.0), vec3(1.0 / 2.2)), 1.0);
}`;

function quadMesh(material) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  return new THREE.Mesh(g, material);
}

export class Post {
  constructor(renderer) {
    this.renderer = renderer;
    this.quadScene = new THREE.Scene();
    this.quadCam = new THREE.Camera();

    let type = THREE.HalfFloatType;
    const gl = renderer.getContext();
    if (!gl.getExtension('EXT_color_buffer_half_float') && !gl.getExtension('EXT_color_buffer_float')) {
      type = THREE.UnsignedByteType;
    }
    this.hdrType = type;

    const rt = (w, h, depth) =>
      new THREE.WebGLRenderTarget(w, h, {
        type,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: !!depth,
        stencilBuffer: false,
        generateMipmaps: false,
      });

    this.rtScene = rt(2, 2, true);
    this.rtBright = rt(2, 2, false);
    this.rtA = rt(2, 2, false);
    this.rtB = rt(2, 2, false);
    this.rtC = rt(2, 2, false);
    this.rtD = rt(2, 2, false);

    this.mBright = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: BRIGHT,
      uniforms: { tSrc: { value: null }, uThreshold: { value: 0.62 }, uKnee: { value: 0.35 } },
      depthTest: false,
      depthWrite: false,
    });
    this.mBlur = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: BLUR,
      uniforms: { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } },
      depthTest: false,
      depthWrite: false,
    });
    this.mComp = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: COMPOSITE,
      uniforms: {
        tScene: { value: null },
        tBloomA: { value: null },
        tBloomB: { value: null },
        uBloom: { value: 1.0 },
        uExposure: { value: 1.0 },
        uTime: { value: 0 },
        uVignette: { value: 0.95 },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.quad = quadMesh(this.mBright);
    this.quadScene.add(this.quad);
  }

  setSize(w, h) {
    const hw = Math.max(1, Math.floor(w / 2));
    const hh = Math.max(1, Math.floor(h / 2));
    const qw = Math.max(1, Math.floor(w / 4));
    const qh = Math.max(1, Math.floor(h / 4));
    this.rtScene.setSize(w, h);
    this.rtBright.setSize(hw, hh);
    this.rtA.setSize(hw, hh);
    this.rtB.setSize(hw, hh);
    this.rtC.setSize(qw, qh);
    this.rtD.setSize(qw, qh);
    this.size = { w, h, hw, hh, qw, qh };
  }

  _pass(material, target) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.clear(true, true, true);
    this.renderer.render(this.quadScene, this.quadCam);
  }

  render(scene, camera, { bloom = 1, exposure = 1, time = 0 } = {}) {
    const r = this.renderer;
    const { hw, hh, qw, qh } = this.size;

    r.setRenderTarget(this.rtScene);
    r.clear(true, true, true);
    r.render(scene, camera);

    this.mBright.uniforms.tSrc.value = this.rtScene.texture;
    this._pass(this.mBright, this.rtBright);

    this.mBlur.uniforms.tSrc.value = this.rtBright.texture;
    this.mBlur.uniforms.uDir.value.set(1 / hw, 0);
    this._pass(this.mBlur, this.rtA);
    this.mBlur.uniforms.tSrc.value = this.rtA.texture;
    this.mBlur.uniforms.uDir.value.set(0, 1 / hh);
    this._pass(this.mBlur, this.rtB);

    this.mBlur.uniforms.tSrc.value = this.rtB.texture;
    this.mBlur.uniforms.uDir.value.set(2 / qw, 0);
    this._pass(this.mBlur, this.rtC);
    this.mBlur.uniforms.tSrc.value = this.rtC.texture;
    this.mBlur.uniforms.uDir.value.set(0, 2 / qh);
    this._pass(this.mBlur, this.rtD);

    this.mComp.uniforms.tScene.value = this.rtScene.texture;
    this.mComp.uniforms.tBloomA.value = this.rtB.texture;
    this.mComp.uniforms.tBloomB.value = this.rtD.texture;
    this.mComp.uniforms.uBloom.value = bloom;
    this.mComp.uniforms.uExposure.value = exposure;
    this.mComp.uniforms.uTime.value = time;
    this._pass(this.mComp, null);
  }
}
