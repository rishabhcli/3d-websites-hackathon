# 3D Websites Hackathon: Winning Idea Dossier

> **Status:** One idea selected; no product name assigned; no implementation started.
> **Deadline:** August 31, 2026 at 3:00 PM PT.
> **Ground truth:** [`HACKATHON.md`](./HACKATHON.md) is authoritative for rules and submission fields.

## Final decision

Create an immersive web gallery of **multi-view anamorphic sculptures**: one static cloud of luminous fragments forms a completely different recognizable silhouette from each marked viewpoint. From the front it may read as a seed, from the side as a bird, and from above as an open hand. Between those viewpoints, the illusion breaks into a beautiful three-dimensional constellation. Users orbit, move lights, pass through the sculpture, and can generate a small three-view piece from their own simple drawings.

No product name is proposed. “Multi-view anamorphic sculpture gallery” is only a description.

## One-line version

A single 3D sculpture tells three different stories depending on where you stand, and the impossible part is that nothing in the sculpture moves.

## Why this can win this specific event

The page explicitly says technical difficulty is not the goal; the goal is the **most memorable experience possible**. Its criteria are **Visual Design**, **Creativity & Originality**, and **User Experience & Interactivity**. This idea produces a reveal judges understand without narration:

1. the camera settles at one viewpoint and a perfect image appears;
2. the user drags sideways and sees that image disintegrate into spatial fragments;
3. the camera reaches a second viewpoint and an entirely different image resolves;
4. the sculpture itself never changed.

The 3D is load-bearing. A 2D version cannot preserve the central illusion. The website is not a product configurator, portfolio room, floating card deck, solar-system menu, generic game environment, or downloaded model with bloom. It is an authored spatial experience native to WebGL/WebGPU.

### Common concepts deliberately rejected

- **3D portfolio room:** overrepresented and judges must read before feeling anything.
- **Product showroom:** technically clean but indistinguishable from agency demos.
- **Space/planet navigation:** familiar visual language and weak interaction beyond orbiting.
- **AI-generated dream world:** model output substitutes for art direction.
- **Infinite procedural terrain:** impressive for ten seconds, emotionally empty.
- **Physics playground:** fun but lacks a singular visual identity.
- **Museum with framed images:** 3D is decorative navigation around 2D content.
- **Heavy narrative game:** twenty-two days is insufficient for both content and polish.

## Experience outline

### Opening, 0-15 seconds

The page opens on black, then a narrow beam of warm light reveals thousands of suspended fragments. The camera is deliberately off-axis, so the sculpture looks abstract. One short line appears: “Stand where the mark is.”

As the user drags toward a glowing floor marker, the fragments align in perspective. At the exact viewpoint, depth-of-field relaxes, ambient noise resolves into a chord, and the first silhouette appears with razor clarity.

No loading dashboard, hero copy, feature cards, or tutorial modal appears before this moment.

### Gallery movement

A curved orbit rail contains three marked observation points. Dragging, pointer movement, touch, arrow keys, or A/D moves the camera smoothly along it. The camera can temporarily detach and float through the sculpture, but a “find the view” control always restores the nearest authored path.

At each observation point:

- the relevant silhouette aligns;
- a short caption appears as typography in world space;
- the light changes to reinforce the composition;
- a subtle outline shows the target only after the user has found it once;
- the URL hash updates so a viewpoint can be shared.

### Light as an instrument

The pointer can grab and rotate a directional light around the sculpture. Fragments cast moving shadows onto a translucent volume behind them. At the authored angle, the shadow and direct projection briefly agree, creating a second reveal.

### User-generated piece

A compact “make one” mode offers three 64×64 canvases corresponding to front, side, and top. Users draw simple monochrome silhouettes. A worker solves for a sparse volumetric arrangement and previews an approximate sculpture. Generation is explicitly bounded to simple shapes and reports projection error for each view rather than pretending every trio is compatible.

The curated gallery remains the submission's primary experience. The generator proves the underlying method is real and adds replay value; it must not delay the visual polish of the authored pieces.

## Curated chapters

Build three finished sculptures, not twenty rough ones.

### Chapter 1: Transformation

Three silhouettes form a legible progression such as seed, sprout, and bird. Material: translucent amber shards. Environment: nearly black with dust and a thin horizon.

Purpose: teach the mechanic with bold, low-frequency shapes.

### Chapter 2: Contradiction

Three silhouettes carry opposing meanings, such as cage, key, and open hand. Material: brushed metal rods with narrow rim lights. The negative space matters as much as occupancy.

Purpose: demonstrate that the sculpture is composed, not merely a point-cloud trick.

### Chapter 3: Participation

The user's three drawings become a rough sculpture beside a polished exemplar. The site visualizes residual error and lets the user trade fidelity for sparsity with one slider.

Purpose: turn the illusion into an interaction without covering the page in controls.

The exact silhouettes and art direction should be selected only after quick projection tests. They are content, not product names.

## Scope boundary

### Build

- Three curated sculptures with three authored viewpoints each.
- One constrained camera path plus optional free-look.
- Dynamic lighting, depth cues, particles, and responsive sound.
- A simple three-canvas generator with honest compatibility/error feedback.
- Desktop and mobile WebGL fallback; WebGPU acceleration where available.
- Keyboard, touch, reduced-motion, low-power, and 2D accessible alternatives.
- Public website, source, three or more screenshots, and a short demo.

### Do not build

1. No accounts, social feed, marketplace, or saved cloud gallery.
2. No arbitrary image upload in version one; simple drawings avoid copyright, privacy, and solver abuse.
3. No VR headset requirement.
4. No general-purpose 3D editor.
5. No generative-image API.
6. No photorealistic human models.
7. No more than three curated chapters.
8. No full game mechanics, scoring, inventory, or dialogue.

## Visual language

### Composition

The silhouette views must occupy roughly 65% of the viewport and remain readable at thumbnail scale. Off-axis views should still look intentional: fragments follow coherent arcs, density gradients, and depth layers instead of appearing as random voxels.

### Material

Use instanced geometry with two or three fragment families: thin rods, beveled shards, and dust points. Variation is seeded. Materials share a restrained palette and physically plausible roughness. Bloom is low; silhouettes should emerge from alignment, not glow saturation.

### Lighting

- One controllable key light.
- One fixed rim light per viewpoint.
- Soft volumetric cone or fog for depth.
- Shadow map budget reserved for the hero sculpture only.
- Tone mapping tested on ordinary laptop screens, not just HDR.

### Typography

One display face and one neutral UI face. Captions never compete with the sculpture. World-space text appears only at stable viewpoints and has an HTML accessible mirror.

### Motion

Movement uses critically damped springs and respects pointer velocity. Snap assistance begins only near an authored view, avoiding the feeling of a locked carousel. Reduced-motion mode crossfades between pre-rendered viewpoint states instead of orbiting.

### Sound

A sparse generative score maps projection error to harmonic dissonance. As the view aligns, partials converge into a stable chord. Sound starts only after user interaction and has a visible mute control.

## Technical architecture

```text
Curated silhouette masks / user drawings
                    |
                    v
Volume solver worker
  soft occupancy grid + projection loss
                    |
          +---------+----------+
          |                    |
          v                    v
sparse fragments         error metrics
positions/materials      per target view
          |
          v
Three.js / React Three Fiber scene
  instancing, camera rail, lights, fog, post FX
          |
    +-----+------+----------------+
    |            |                |
    v            v                v
interaction   Web Audio       accessibility mirror
pointer/touch projection      captions/2D views
                    |
                    v
quality governor: WebGPU/WebGL2/mobile/low-power
```

### Recommended stack

- TypeScript, Vite, React.
- React Three Fiber and Drei or direct Three.js if tighter control is preferable.
- WebGPU compute when available; WebGL2/worker CPU fallback for small user sculptures.
- GLSL/WGSL custom material for fragment shimmer and projection emphasis.
- Web Workers for optimization.
- GSAP or spring-based camera transitions.
- Web Audio API for procedural sound.
- Playwright plus screenshot-diff tests at fixed camera poses.
- Blender only for optional authored fragment meshes, not for pre-rendering the whole experience.

## Hard technical core

### 1. Multi-view volume reconstruction

Each target is a binary or soft silhouette mask `T_v(u,w)` associated with a fixed camera projection `P_v`. The sculpture is a 3D occupancy field `O(x,y,z)`.

A differentiable soft projection for view `v` can be defined as:

```text
S_v(pixel) = 1 - product over samples on ray (1 - sigmoid(O_i))
```

Optimize:

```text
L = sum_v BCE(S_v, T_v)
    + lambda_sparse * mean(sigmoid(O))
    + lambda_tv * totalVariation(O)
    + lambda_float * disconnectedPenalty(O)
```

- Projection loss makes each authored view match its target.
- Sparsity prevents a solid visual-hull block.
- Total variation reduces noisy isolated voxels.
- Connectivity support discourages fragments with no relationship to the composition.

For curated scenes, run a higher-resolution solve offline and commit only the resulting sparse positions plus target masks. For user mode, solve a 32³ or 48³ field in a worker for a fixed iteration budget, then convert occupied cells into instances.

### 2. Compatibility and honest error

Not every three silhouettes share a feasible volume. The generator reports per-view IoU/SSIM-like projection scores and marks pixels impossible to satisfy jointly. The single “fidelity vs air” slider adjusts projection and sparsity weights. It never claims perfection when one view sacrifices another.

A fast initial estimate comes from intersecting back-projected silhouette cones, followed by continuous optimization. If the intersection is empty or overly dense, the UI says the drawings conflict and highlights the problem regions.

### 3. Turning voxels into sculpture

Raw voxel cubes look like a technical demo. Convert the field into designed fragments:

1. sample occupied cells with blue-noise spacing;
2. estimate local density gradient;
3. orient rods/shards along the tangent of that gradient;
4. retain a subset that preserves projection coverage;
5. add sparse support arcs outside important silhouette edges;
6. assign seeded scale/material variation;
7. validate all authored camera projections after stylization.

The curated pieces may use manual art-direction passes, but projection accuracy remains regression-tested.

### 4. Camera calibration

Every target view is a full camera transform, projection matrix, and viewport-safe framing. The rail is a spline in position/quaternion space. Near a marker, measure projection error between the current and target camera; use this value for snap force, audio convergence, and silhouette-outline opacity.

Resize and mobile aspect ratio cannot move the camera arbitrarily. Recompute distance or FOV to preserve the target silhouette's safe frame while keeping its projection matrix consistent.

### 5. Performance

- All fragments render through instancing, not one mesh per shard.
- Level of detail reduces shard geometry before reducing silhouette-defining instances.
- Dynamic resolution scales between 0.65 and 1.0 based on a rolling GPU-frame budget.
- Expensive shadows render only near authored views.
- Mobile disables volumetric passes before reducing art density.
- User optimization runs outside the render thread and can be canceled.
- Curated scene binary payload stays small enough for a meaningful first reveal within a few seconds.

Targets: stable 60 fps on the development Mac, 30+ fps on a mid-range phone, no interaction-blocking compilation after the opening reveal.

## Validation

### Projection regression tests

At each authored camera and three viewport sizes:

- render a monochrome mask;
- compare against target;
- require declared IoU threshold;
- verify framing and no caption overlap;
- save screenshot diffs in CI.

### Experience tests

With at least eight testers, observe without narrating:

- time until first silhouette is found;
- whether they realize the sculpture remains static;
- whether they intentionally seek the second marker;
- time spent interacting after the third view;
- generator completion and abandonment rate;
- motion discomfort or control confusion.

Success: seven of eight find two silhouettes within 90 seconds, six articulate the illusion without explanation, and median session time exceeds three minutes.

### Device matrix

- Chrome and Safari desktop.
- Chrome/Safari mobile.
- WebGL2 without WebGPU.
- reduced-motion preference.
- keyboard-only.
- muted and audio-enabled.
- integrated-GPU low-power mode.

## Accessibility

- Arrow keys/A-D and visible controls mirror dragging.
- “Next viewpoint” button moves directly without requiring spatial precision.
- Reduced-motion mode uses static cuts and dissolves.
- A 2D gallery presents each silhouette and an alt description of the three-dimensional relationship.
- Captions and target descriptions exist in semantic HTML outside the canvas.
- High-contrast focus indicators and minimum 44px touch targets.
- No meaning relies solely on color.
- Sound is supplementary, never required.
- Pause motion and reset camera are always available.

## First 48-hour kill test

The risky assumption is that one static occupancy field can yield three legible, visually unrelated silhouettes without becoming an ugly solid block.

Within 48 hours:

1. create three 32×32 test masks;
2. build the back-projection/soft-projection solver;
3. render the resulting volume as instanced points;
4. orbit between the exact three camera poses;
5. measure projection IoU;
6. test on a laptop and phone;
7. show it to three people with no explanation.

Kill or reformulate if:

- any view needs verbal explanation to recognize;
- the volume is so dense that off-axis space has no beauty;
- optimization exceeds 20 seconds for the small user mode;
- maintaining one view destroys the others;
- mobile instancing cannot hold 30 fps;
- the effect is only visible after an outline is overlaid.

The fallback should be fewer silhouettes per sculpture, not moving fragments. Motion would weaken the “nothing moves” promise.

## Build order

### August 9-10: impossible-shape proof

Solver, three toy masks, exact camera views, instanced point render. Decide whether the idea lives.

### August 11-13: first curated sculpture

Higher-resolution solve, fragment stylization, orbit rail, projection regression harness.

### August 14-16: visual system

Materials, lighting, fog, camera springs, opening reveal, responsive framing.

### August 17-18: second sculpture

A contrasting material language and more ambitious negative space. No new engine systems.

### August 19-20: interaction and sound

Light manipulation, viewpoint URL state, projection-error audio, mute behavior.

### August 21-22: user generator

Three drawing canvases, bounded solver worker, error visualization, fidelity/sparsity slider.

### August 23: third chapter

Integrate generated piece beside one polished exemplar. Cut if it harms the main gallery.

### August 24-25: mobile and quality governor

WebGPU/WebGL fallback, dynamic resolution, LOD, loading behavior.

### August 26: accessibility

Keyboard, direct viewpoint controls, reduced motion, semantic mirror, 2D gallery.

### August 27: blind testing

Eight sessions. Fix finding, camera, readability, and performance failures only.

### August 28: feature freeze

No new scenes or controls. Final color, lighting, typography, and sound pass.

### August 29: submission assets

At least three screenshots, architecture image, source cleanup, README, Devpost copy.

### August 30: record and deploy

Record 1-3 minute demo, deploy, test clean profile and mobile.

### August 31 before noon PT

Final smoke test and submit three hours before the 3:00 PM deadline.

## Demo storyboard, 1:45

- **0:00-0:08:** Abstract fragments in darkness, off-axis. No title card.
- **0:08-0:20:** Camera glides to the first marker. A crisp seed silhouette resolves.
- **0:20-0:34:** Orbit away; the image dissolves into real depth while the sculpture remains static.
- **0:34-0:47, winning moment:** Camera reaches the side marker and the same fragments become a bird. Hold the view without narration.
- **0:47-1:00:** Top view resolves into the third image; one continuous take proves nothing moved.
- **1:00-1:15:** User rotates the light and travels through the structure; sound converges near a view.
- **1:15-1:32:** Draw three simple silhouettes; generation runs; projection-error scores appear honestly.
- **1:32-1:42:** Quick mobile, keyboard, and reduced-motion views.
- **1:42-1:45:** Return to the off-axis sculpture and end on one line: “Meaning depends on where you stand.”

## Rubric map

### Visual Design

- Three authored material/lighting compositions rather than downloaded scenes.
- Strong silhouette framing, controlled palette, responsive typography, sound, and polished camera behavior.
- Off-axis views remain intentionally sculptural.
- Performance and mobile quality are treated as visual requirements.

### Creativity & Originality

- A static sculpture encodes multiple incompatible-looking images.
- The interaction is viewpoint and perception, not clicking floating cards.
- User drawings expose the underlying visual logic without relying on generated assets.

### User Experience & Interactivity

- Immediate guided reveal followed by free exploration.
- Camera rail, direct viewpoint controls, touch, keyboard, light manipulation, URL sharing, and generator.
- Honest errors, cancelable generation, reset controls, low-power mode, and accessibility alternatives.

## Submission checklist

- Publicly accessible website link.
- Public source code.
- Description explains the perceptual idea and inspiration without leading with optimization math.
- At least three screenshots; use all three curated viewpoints plus one off-axis view and generator.
- Optional video should still be submitted because continuous camera motion proves the illusion.
- Technologies/tools list includes Three.js/R3F, WebGL/WebGPU, TypeScript, Web Workers, GLSL/WGSL, Web Audio, and Blender only if actually used.
- 3:2 thumbnail shows two viewpoints of the same sculpture side by side.
- All content appropriate for all audiences.
- README includes controls, browser support, performance modes, accessibility, local setup, and solver explanation.

## Repository plan

```text
/
├── README.md
├── LICENSE
├── src/
│   ├── gallery/
│   ├── scenes/
│   │   ├── chapter-one/
│   │   ├── chapter-two/
│   │   └── generated/
│   ├── solver/
│   │   ├── projections.ts
│   │   ├── occupancy.ts
│   │   ├── losses.ts
│   │   ├── worker.ts
│   │   └── sparsify.ts
│   ├── sculpture/
│   │   ├── fragments.ts
│   │   ├── materials/
│   │   └── instancing.ts
│   ├── camera/
│   ├── lighting/
│   ├── audio/
│   ├── generator/
│   ├── quality/
│   └── accessibility/
├── public/
│   ├── masks/
│   ├── audio/
│   └── fallback/
├── tests/
│   ├── projections/
│   ├── screenshots/
│   └── e2e/
└── docs/
    ├── architecture.svg
    ├── art-direction.md
    └── performance-matrix.md
```

## What would make this lose anyway

1. **It looks like random particles with bloom.** Manual art direction after optimization is mandatory.
2. **The silhouette needs an outline to be recognizable.** The sculpture has failed its central promise.
3. **The camera fights the user.** Snap only near a target and always offer reset/next-view controls.
4. **The generator consumes the schedule.** Curated gallery wins; generator is cut first.
5. **Mobile runs poorly.** Quality reduction must preserve the silhouette before preserving effects.
6. **The opening explains instead of reveals.** First recognizable shape inside twenty seconds.
7. **The sculpture morphs between views.** That is easier and less original; static geometry is non-negotiable.
8. **Three chapters share one look.** Material and emotional contrast create a gallery, not three demos.
9. **Technical writeup dominates the Devpost page.** The algorithm supports the wonder; it is not the pitch.

The winning submission is a site judges remember as an experience, not a renderer they respect.