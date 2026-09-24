import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
import { createServer } from '../../../utils/server.js';

const root = fileURLToPath( new URL( '../../../', import.meta.url ) );
const baselineSource = await readFile( process.env.SHADOW_BASELINE_FILE || path.join( root, 'src/renderers/common/Renderer.stock.js' ), 'utf8' );
const forceWebGL = process.argv.includes( '--webgl' );
const output = path.join( root, 'test/e2e/output-screenshots/shadow-pipeline', forceWebGL ? 'regression-webgl' : 'regression' );
await mkdir( output, { recursive: true } );
const cases = [
	{ id: 'pcf-mixed' },
	{ id: 'vsm-mixed', vsm: true },
	{ id: 'pcf-transparent', transparent: true },
	{ id: 'vsm-transparent', transparent: true, vsm: true },
	{ id: 'pcf-explicit', explicit: true },
	{ id: 'vsm-explicit', explicit: true, vsm: true },
	{ id: 'dynamic-side', dynamic: 'side' },
	{ id: 'dynamic-shadow-side', dynamic: 'shadowSide' },
	{ id: 'custom-pass-ids', custom: true },
	{ id: 'before-render-side', beforeRender: true },
	{ id: 'precompile', compile: true },
	{ id: 'two-shadow-lights', twoLights: true },
	{ id: 'same-side', uniform: true },
	{ id: 'mixed-transparency', uniform: true, mixedTransparency: true }
];
const server = createServer( { root } );
server.listen( 0, '127.0.0.1' );
await once( server, 'listening' );
const url = `http://127.0.0.1:${ server.address().port }/test/repro/shadow-pipeline/index.html?autorun=0&renderer=patched`;
const report = { backend: forceWebGL ? 'WebGL2' : 'WebGPU', cases: [], errors: [], comparisons: [] };
let browser;

try {

	browser = await puppeteer.launch( {
		headless: true,
		executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
		args: [ '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--disable-background-timer-throttling' ],
		defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 1 }
	} );
	report.browser = await browser.version();
	for ( const mode of [ 'baseline', 'patched' ] ) {

		const page = await browser.newPage();
		page.on( 'pageerror', error => report.errors.push( `${ mode }: ${ error.message }` ) );
		page.on( 'console', message => {

			if ( message.type() === 'error' ) report.errors.push( `${ mode }: ${ message.text() }` );

		} );
		if ( mode === 'baseline' ) {

			await page.setRequestInterception( true );
			page.on( 'request', request => {

				if ( new URL( request.url() ).pathname === '/src/renderers/common/Renderer.js' ) {

					request.respond( { status: 200, contentType: 'application/javascript', body: baselineSource } );

				} else {

					request.continue();

				}

			} );

		}

		await page.goto( url, { waitUntil: 'networkidle0' } );
		await page.waitForFunction( () => window.shadowRepro !== undefined );
		for ( const spec of cases ) {

			const result = await page.evaluate( async ( spec, forceWebGL ) => {

				const THREE = await import( 'three/webgpu' );
				const { createScene } = await import( './repro.js' );
				const fixture = await createScene( { uniform: spec.uniform, forceWebGL } );
				window.regressionFixture = fixture;
				const { renderer, scene, camera, probe } = fixture;
				const caster = scene.children.find( object => object.isMesh && object.castShadow );
				const materials = caster.material;
				const finish = async () => {

					if ( forceWebGL ) {

						const gl = renderer.backend.gl;
						gl.finish();
						const error = gl.getError();
						if ( error !== gl.NO_ERROR ) probe.errors.push( `WebGL error: ${ error }` );

					} else await renderer.backend.device.queue.onSubmittedWorkDone();

				};
				if ( spec.mixedTransparency ) {

					materials[ 1 ].transparent = true;
					materials[ 1 ].opacity = 0.5;

				}
				if ( spec.vsm ) renderer.shadowMap.type = THREE.VSMShadowMap;
				if ( spec.transparent ) for ( const material of materials ) {

					material.transparent = true;
					material.opacity = 0.5;

				}

				if ( spec.explicit ) {

					materials[ 0 ].shadowSide = THREE.FrontSide;
					materials[ 1 ].shadowSide = THREE.BackSide;

				}

				if ( spec.twoLights ) {

					const extra = scene.children.find( object => object.isDirectionalLight ).clone();
					extra.position.set( 4, 6, - 3 );
					scene.add( extra );
					window.extraRegressionLight = extra;

				}

				if ( spec.beforeRender ) {

					caster.onBeforeRender = ( renderer, scene, camera, geometry, material, group ) => {

						if ( scene.overrideMaterial?.isShadowPassMaterial ) material.shadowSide = group.materialIndex === 0 ? THREE.FrontSide : THREE.DoubleSide;

					};

				}

				const customIds = new Set();
				if ( spec.custom ) {

					const renderObject = renderer.renderObject;
					renderer.renderObject = function ( object, scene, camera, geometry, material, group, lightsNode, clippingContext, passId = null ) {

						if ( scene.overrideMaterial?.isShadowPassMaterial && object === caster ) passId = `user-shadow-${ group.materialIndex }`;
						return renderObject.call( this, object, scene, camera, geometry, material, group, lightsNode, clippingContext, passId );

					};

					const direct = renderer._renderObjectDirect;
					renderer._renderObjectDirect = function ( object, material, scene, camera, lightsNode, group, clippingContext, passId ) {

						if ( material.isShadowPassMaterial && object === caster ) customIds.add( passId );
						return direct.call( this, object, material, scene, camera, lightsNode, group, clippingContext, passId );

					};

				}

				if ( spec.compile ) await renderer.compileAsync( scene, camera );
				const nextFrame = () => new Promise( resolve => requestAnimationFrame( resolve ) );
				const phases = [];
				const states = spec.dynamic ? [[ 0, 2 ], [ 1, 0 ], [ 2, 1 ], [ 0, 2 ], [ 1, 0 ], [ 2, 1 ], [ 0, 2 ]] : [ null ];
				for ( const state of states ) {

					if ( state ) for ( let i = 0; i < materials.length; i ++ ) {

						materials[ i ][ spec.dynamic ] = state[ i ];
						materials[ i ].needsUpdate = true;

					}

					for ( let frame = 0; frame < 12; frame ++ ) {

						await nextFrame();
						fixture.draw();

					}

					await finish();
					const before = { ...probe.counters };
					const perFrame = [];
					const frames = spec.dynamic ? 30 : 120;
					for ( let frame = 0; frame < frames; frame ++ ) {

						await nextFrame();
						const beforeFrame = probe.counters.shadowSync + probe.counters.shadowAsync;
						fixture.draw();
						perFrame.push( probe.counters.shadowSync + probe.counters.shadowAsync - beforeFrame );

					}

					await finish();
					phases.push( {
						state, frames, perFrame,
						counts: Object.fromEntries( Object.keys( before ).map( key => [ key, probe.counters[ key ] - before[ key ] ] ) ),
						shadowRenderObjects: [ ...renderer._objects._renderObjects ].filter( object => object.object === caster && object.material.isShadowPassMaterial ).length,
						pipelines: renderer._pipelines.caches.size
					} );

				}

				return { id: spec.id, revision: THREE.REVISION, phases, customIds: [ ...customIds ], errors: [ ...probe.errors ] };

			}, spec, forceWebGL );
			result.mode = mode;
			const canvas = await page.$( 'canvas' );
			await canvas.screenshot( { path: path.join( output, `${ mode }-${ spec.id }.png` ) } );
			result.cleanup = await page.evaluate( async () => {

				const fixture = window.regressionFixture;
				const caster = fixture.scene.children.find( object => object.isMesh && object.castShadow );
				const objects = fixture.renderer._objects;
				const pipelines = fixture.renderer._pipelines;
				for ( const material of caster.material ) material.dispose();
				const remainingCasterObjects = [ ...objects._renderObjects ].filter( object => object.object === caster ).length;
				window.extraRegressionLight?.dispose();
				window.extraRegressionLight = null;
				await fixture.dispose();
				return { remainingCasterObjects, renderObjects: objects._renderObjects.size, pipelines: pipelines.caches.size };

			} );
			report.cases.push( result );
			console.log( `${ mode } ${ spec.id }: ${ result.phases.map( phase => phase.counts.shadowSync / phase.frames ).join( ', ' ) } shadow pipelines/frame; cleanup ${ JSON.stringify( result.cleanup ) }` );

		}

		await page.close();

	}

	for ( const spec of cases ) {

		const a = PNG.sync.read( await readFile( path.join( output, `baseline-${ spec.id }.png` ) ) );
		const b = PNG.sync.read( await readFile( path.join( output, `patched-${ spec.id }.png` ) ) );
		assert.equal( a.width, b.width );
		assert.equal( a.height, b.height );
		let differingPixels = 0;
		for ( let i = 0; i < a.data.length; i += 4 ) {

			if ( a.data[ i ] !== b.data[ i ] || a.data[ i + 1 ] !== b.data[ i + 1 ] || a.data[ i + 2 ] !== b.data[ i + 2 ] || a.data[ i + 3 ] !== b.data[ i + 3 ] ) differingPixels ++;

		}

		report.comparisons.push( { id: spec.id, differingPixels } );

	}

	await writeFile( path.join( output, 'results.json' ), JSON.stringify( report, null, 2 ) + '\n' );
	assert.deepEqual( report.errors, [], 'Browser errors' );
	for ( const result of report.cases ) {

		assert.deepEqual( result.errors, [], `${ result.mode } ${ result.id }: GPU errors` );
		assert.deepEqual( result.cleanup, { remainingCasterObjects: 0, renderObjects: 0, pipelines: 0 }, `${ result.mode } ${ result.id }: cleanup` );
		if ( result.id === 'custom-pass-ids' ) assert.deepEqual( result.customIds.sort(), [ 'user-shadow-0', 'user-shadow-1' ] );
		if ( result.mode === 'patched' ) for ( const phase of result.phases ) {

			const expected = result.id === 'mixed-transparency' && ! forceWebGL ? phase.frames * 2 : 0;
			assert.deepEqual( phase.counts, { shadowSync: expected, shadowAsync: 0, other: 0, shaders: 0 }, `${ result.id }: steady-state pipelines and shaders` );
			assert.ok( phase.shadowRenderObjects <= ( result.id === 'two-shadow-lights' ? 6 : 3 ), `${ result.id }: bounded shadow cache` );

		}

	}

	for ( const comparison of report.comparisons ) assert.equal( comparison.differingPixels, 0, `${ comparison.id }: rendered image changed` );
	console.log( `PASS: ${ cases.length } cases on baseline and patched ${ report.backend }, identical images, expected scoped churn, complete cleanup.` );

} finally {

	await browser?.close();
	server.close();

}
