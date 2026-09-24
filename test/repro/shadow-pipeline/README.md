# Shadow pipeline churn

A multi-material shadow caster with mixed effective shadow sides recreates two
WebGPU pipelines every frame, even while the scene is stationary. Separating the
shadow render-object cache by effective side eliminates the churn without
changing the rendered image.

## Hosted reproduction

The page is static and can be served directly through raw.githack.com after the
repro branch is pushed to a public Three.js fork. Use the full commit hash to pin
both the page and all renderer source imports to the same revision:

```text
https://raw.githack.com/<owner>/three.js/<commit>/test/repro/shadow-pipeline/index.html
```

Open the page in a WebGPU-capable browser, wait for the first measurement, then
select **Mixed sides · side-key workaround** and run again, or use **Compare all**.
The first case should report 2 shadow pipelines/frame; the workaround should
report 0. No server-side code, npm installation, or downloaded assets are needed
to use the hosted page. The first visit loads the renderer's source modules.

## Local reproduction

From the Three.js repository root, with its existing npm dependencies installed:

```powershell
node test/repro/shadow-pipeline/run.js --serve
```

Open <http://127.0.0.1:8092/test/repro/shadow-pipeline/> in a WebGPU-capable browser.
The page imports `src/` directly, so edits to `Renderer.js` take effect on reload;
no build or max.js assets are needed. Set `PORT` to change the port.

The first case runs automatically. Use **Compare all** for the seven-case matrix.
Each case creates a fresh renderer, renders 12 warm-up frames, measures 120 frames,
and stops. Orbiting after a run does not change the saved measurement.

| Case | Effective shadow sides | Expected pipelines/frame on affected source |
|---|---|---:|
| Mixed sides, stock | Back / Double | 2 |
| Mixed sides, side-key workaround | Back / Double | 0 |
| Same source sides | Back / Back | 0 |
| Equal explicit shadowSide | Back / Back | 0 |
| Mixed explicit shadowSide, stock | Back / Double | 2 |
| Mixed explicit shadowSide, workaround | Back / Double | 0 |
| Shadows off | No shadow pass | 0 |

The local wrapper only supplies a side-derived `passId` for shadow override draws
without an existing pass ID. It leaves visible sides and shadow sides unchanged.
It is an experimental comparison, not a core renderer patch. The equal-shadowSide
control deliberately changes shadow semantics and is not the proposed fix.

## Automated verification

```powershell
node test/repro/shadow-pipeline/run.js
# After applying a real fix to the renderer:
node test/repro/shadow-pipeline/run.js --expect=fixed
```

The runner uses this repository's Puppeteer dependency and its installed browser.
To use installed Edge instead:

```powershell
$env:PUPPETEER_EXECUTABLE_PATH = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
node test/repro/shadow-pipeline/run.js
```

It starts a temporary loopback server, runs all cases, checks every measured frame,
and compares canvas pixels for both stock/workaround pairs. It closes its browser
and server on completion. Affected mode asserts the bug is reproduced; fixed mode
requires zero pipeline creation in every case. WebGL fallback is rejected.

Evidence is written to the already ignored directory
`test/e2e/output-screenshots/shadow-pipeline/`: `results.json`, canvas screenshots,
and full-page screenshots. The report includes the runtime revision, browser,
source material sides, geometry groups, per-frame counts, and GPU errors.

Counters wrap the renderer's actual GPU device methods (`createRenderPipeline`,
`createRenderPipelineAsync`, `createShaderModule`). Shadow calls are identified
from the backend's `isShadowPassMaterial`, not their labels. Both internally
scoped and uncaptured GPU errors are recorded. No fake GPU or mocked cache is used.

The visual scene has one caster containing two boxes as two geometry groups, one
receiver, and one directional shadow light. The test covers opaque materials and
PCF shadows. Transparent double-pass materials, VSM, custom pass IDs, and material
changes in `onBeforeRender` are outside this repro's validation scope.

Verified 2026-09-24 on `186dev`, checkout `4d26905461`, using Edge
`153.0.4234.48`: both stock mixed-side cases produced 240 synchronous shadow
pipelines over 120 frames; all five other cases produced zero. Every case had
zero new shader modules and zero GPU errors. Both stock/workaround canvas pairs
were pixel-identical. ESLint also passed for the repro files.

Rechecked the same day against fresh upstream `dev` at
`1c4264a6392a5625bad4b0ad0559cfa24b73b2eb` (`187dev`) and the head of related
open PR #34104 at `e0c20484c4cde3d13109413c7b6104388c07f8fd`. Both still
reproduce the same 240/120-frame churn and pass all seven affected-mode checks,
including pixel equality. Their reports are saved beside the original evidence
as `upstream-dev-results.json` and `pr-34104-results.json`.
