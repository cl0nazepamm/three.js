import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rollup } from 'rollup';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
import builds from '../../../utils/build/rollup.config.js';
import { createServer } from '../../../utils/server.js';

const root = fileURLToPath( new URL( '../../../', import.meta.url ) );
const forceWebGL = process.argv.includes( '--webgl' );
const repeat = process.argv.includes( '--repeat' );
const evidenceRoot = path.join( root, 'test/e2e/output-screenshots/shadow-pipeline' );
const output = path.join( evidenceRoot, ( forceWebGL ? 'example-validation-webgl' : 'example-validation' ) + ( repeat ? '-repeat' : '' ) );
await mkdir( output, { recursive: true } );
const selectedExample = process.argv.find( arg => arg.startsWith( '--example=' ) )?.split( '=' )[ 1 ];
const examples = [ 'webgpu_shadowmap', 'webgpu_shadowmap_vsm', 'webgpu_shadowmap_pointlight', 'webgpu_shadowmap_opacity', 'webgpu_shadowmap_csm', 'webgpu_shadowmap_array' ].filter( example => ! selectedExample || example === selectedExample );
assert.ok( examples.length > 0 );
const modes = repeat ? [ 'stock', 'stock-repeat', 'patched', 'patched-repeat' ] : [ 'stock', 'patched' ];
const baseline = await readFile( path.join( root, 'src/renderers/common/Renderer.stock.js' ), 'utf8' );
const buildDirectories = { stock: path.join( evidenceRoot, 'example-validation/stock-build' ), patched: path.join( root, 'build' ) };

if ( ! process.argv.includes( '--skip-build' ) ) for ( const mode of [ 'stock', 'patched' ] ) {

	for ( const config of builds ) {

		const plugins = [ ...( config.plugins || [] ) ];
		if ( mode === 'stock' ) plugins.unshift( {
			name: 'upstream-renderer-baseline',
			load( id ) {

				if ( id.replaceAll( '\\', '/' ).endsWith( '/src/renderers/common/Renderer.js' ) ) return baseline;

			}
		} );
		const bundle = await rollup( { ...config, plugins } );
		for ( const settings of config.output ) await bundle.write( { ...settings, dir: buildDirectories[ mode ] } );
		await bundle.close();

	}

	console.log( `Built ${ mode } using upstream Rollup configuration.` );

}

const server = createServer( { root } );
server.listen( 0, '127.0.0.1' );
await once( server, 'listening' );
const origin = `http://127.0.0.1:${ server.address().port }`;
const report = { revision: '1c4264a6392a5625bad4b0ad0559cfa24b73b2eb', backend: forceWebGL ? 'WebGL2' : 'WebGPU', cases: [], comparisons: [] };
let browser;
try {

	browser = await puppeteer.launch( {
		headless: true,
		executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
		args: [ '--enable-unsafe-webgpu', '--ignore-gpu-blocklist' ],
		defaultViewport: { width: 960, height: 600, deviceScaleFactor: 1 }
	} );
	report.browser = await browser.version();
	for ( const example of examples ) for ( const mode of modes ) {

		const page = await browser.newPage();
		const errors = [];
		const warnings = [];
		page.on( 'pageerror', error => errors.push( error.message ) );
		page.on( 'console', message => {

			if ( message.type() === 'error' ) errors.push( message.text() );
			if ( message.type() === 'warn' ) warnings.push( message.text() );

		} );
		page.on( 'response', response => {

			if ( response.status() >= 400 ) errors.push( `${ response.status() }: ${ response.url() }` );

		} );
		await page.setRequestInterception( true );
		page.on( 'request', async request => {

			const pathname = new URL( request.url() ).pathname;
			try {

				if ( pathname === '/favicon.ico' ) {

					await request.respond( { status: 200, contentType: 'image/x-icon', body: await readFile( path.join( root, 'files/favicon.ico' ) ) } );

				} else if ( pathname.startsWith( '/build/' ) ) {

					await request.respond( { status: 200, contentType: 'application/javascript', body: await readFile( path.join( buildDirectories[ mode.startsWith( 'stock' ) ? 'stock' : 'patched' ], path.basename( pathname ) ) ) } );

				} else if ( pathname === `/examples/${ example }.html` ) {

					let html = await readFile( path.join( root, pathname ), 'utf8' );
					if ( forceWebGL ) {

						const constructor = 'new THREE.WebGPURenderer( { antialias: true } )';
						assert.equal( html.split( constructor ).length, 2, 'Expected one renderer constructor' );
						html = html.replace( constructor, 'new THREE.WebGPURenderer( { antialias: true, forceWebGL: true } )' );

					}
					html = html.replace( '<script type="module">', '<script type="module" src="/test/repro/shadow-pipeline/example-probe.js"></script>\n<script type="module">' );
					await request.respond( { status: 200, contentType: 'text/html', body: html } );

				} else {

					await request.continue();

				}

			} catch ( error ) {

				errors.push( error.message );
				await request.abort();

			}

		} );
		await page.evaluateOnNewDocument( forceWebGL => {

			window.validationForceWebGL = forceWebGL;
			window.validationRealNow = performance.now.bind( performance );
			let seed = Math.PI / 4;
			Math.random = () => {

				const value = Math.sin( seed ++ ) * 10000;
				return value - Math.floor( value );

			};

			let time = 0;
			let nextId = 0;
			const callbacks = new Map();
			performance.now = () => time;
			Date.now = () => time;
			Date.prototype.getTime = () => time;
			window.requestAnimationFrame = callback => {

				callbacks.set( ++ nextId, callback );
				return nextId;

			};

			window.cancelAnimationFrame = id => callbacks.delete( id );
			window.validationStep = async frames => {

				for ( let i = 0; i < frames; i ++ ) {

					time += 1000 / 60;
					const pending = [ ...callbacks.values() ];
					callbacks.clear();
					for ( const callback of pending ) await callback( time );
					for ( const renderer of window.exampleProbe.renderers ) {

						if ( forceWebGL ) {

							const gl = renderer.backend.gl;
							gl.finish();
							const error = gl.getError();
							if ( error !== gl.NO_ERROR ) window.exampleProbe.errors.push( `WebGL error: ${ error }` );

						} else await renderer.backend.device.queue.onSubmittedWorkDone();

					}

				}

			};

		}, forceWebGL );
		try {

			await page.goto( `${ origin }/examples/${ example }.html`, { waitUntil: 'networkidle0' } );
			await page.waitForFunction( () => window.exampleProbe?.renderers.length > 0, { polling: 100 } );
			const result = await page.evaluate( async () => {

				await window.validationStep( 24 );
				const probe = window.exampleProbe;
				const before = { ...probe.counters };
				const beforeFrames = probe.frames;
				probe.timings = [];
				await window.validationStep( 120 );
				const sorted = [ ...probe.timings ].sort( ( a, b ) => a - b );
				let casters = 0;
				probe.scene.traverse( object => {

					if ( object.isMesh && object.castShadow ) casters ++;

				} );
				return {
					frames: probe.frames - beforeFrames, casters,
					counts: Object.fromEntries( Object.keys( before ).map( key => [ key, probe.counters[ key ] - before[ key ] ] ) ),
					gpuErrors: [ ...probe.errors ],
					renderSubmitMedianMs: sorted[ Math.floor( sorted.length * .5 ) ],
					renderSubmitP95Ms: sorted[ Math.floor( sorted.length * .95 ) ],
					pipelines: probe.renderers[ 0 ]._pipelines.caches.size,
					backend: probe.renderers[ 0 ].backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2'
				};

			} );
			const canvas = await page.$( 'canvas[data-shadow-validation]' );
			await canvas.screenshot( { path: path.join( output, `${ example }-${ mode }.png` ) } );
			report.cases.push( { example, mode, ...result, errors, warnings } );
			console.log( `${ example } ${ mode }: ${ result.frames } frames, ${ result.casters } casters, ${ JSON.stringify( result.counts ) }, ${ result.gpuErrors.length + errors.length } errors` );

		} catch ( error ) {

			report.cases.push( { example, mode, errors: [ ...errors, error.stack ], warnings } );
			console.log( `FAILED ${ example } ${ mode }: ${ error.message }` );

		} finally {

			await page.close();
			await writeFile( path.join( output, 'results.json' ), JSON.stringify( report, null, 2 ) + '\n' );

		}

	}

	const pairs = repeat ? [ [ 'stock', 'stock-repeat' ], [ 'patched', 'patched-repeat' ], [ 'stock', 'patched' ] ] : [ [ 'stock', 'patched' ] ];
	for ( const example of examples ) for ( const [ left, right ] of pairs ) {

		const a = PNG.sync.read( await readFile( path.join( output, `${ example }-${ left }.png` ) ) );
		const b = PNG.sync.read( await readFile( path.join( output, `${ example }-${ right }.png` ) ) );
		assert.equal( a.width, b.width );
		assert.equal( a.height, b.height );
		let differingPixels = 0;
		let maxChannelDelta = 0;
		for ( let i = 0; i < a.data.length; i += 4 ) {

			if ( a.data[ i ] !== b.data[ i ] || a.data[ i + 1 ] !== b.data[ i + 1 ] || a.data[ i + 2 ] !== b.data[ i + 2 ] || a.data[ i + 3 ] !== b.data[ i + 3 ] ) differingPixels ++;
			for ( let channel = 0; channel < 4; channel ++ ) maxChannelDelta = Math.max( maxChannelDelta, Math.abs( a.data[ i + channel ] - b.data[ i + channel ] ) );

		}

		report.comparisons.push( { example, left, right, differingPixels, maxChannelDelta, pixels: a.width * a.height } );

	}

	await writeFile( path.join( output, 'results.json' ), JSON.stringify( report, null, 2 ) + '\n' );
	for ( const result of report.cases ) {

		assert.deepEqual( result.errors, [], `${ result.example } ${ result.mode }: browser errors` );
		assert.deepEqual( result.gpuErrors, [], `${ result.example } ${ result.mode }: GPU errors` );
		assert.equal( result.frames, 120 );
		assert.equal( result.backend, report.backend );
		assert.ok( result.casters > 0, 'Example must render actual shadow casters' );

	}

	for ( const comparison of report.comparisons ) assert.equal( comparison.differingPixels, 0, `${ comparison.example }: image changed` );
	console.log( `PASS: ${ examples.length } upstream examples; identical comparison images; no browser or GPU errors.` );

} finally {

	await browser?.close();
	server.close();

}
