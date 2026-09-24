import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { createServer } from '../../../utils/server.js';

const root = fileURLToPath( new URL( '../../../', import.meta.url ) );
const serve = process.argv.includes( '--serve' );
const server = createServer( { root } );
server.listen( serve ? Number( process.env.PORT || 8094 ) : 0, '127.0.0.1' );
await once( server, 'listening' );
const base = `http://127.0.0.1:${ server.address().port }/test/repro/shared-context/`;
if ( serve ) {

	console.log( `Shared-context preview: ${ base }` );

} else {

	let browser;
	const report = { baseRevision: '1c4264a6392a5625bad4b0ad0559cfa24b73b2eb', cases: [] };
	const output = path.join( root, 'test/e2e/output-screenshots/shared-context' );
	await mkdir( output, { recursive: true } );
	try {

		browser = await puppeteer.launch( { headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, args: [ '--enable-unsafe-webgpu', '--ignore-gpu-blocklist' ], defaultViewport: { width: 720, height: 540, deviceScaleFactor: 1 } } );
		report.browser = await browser.version();
		const selection = process.argv.find( value => value.startsWith( '--profile=' ) )?.split( '=' )[ 1 ];
		const profiles = selection ? [ selection ] : [ 'ssgi-dof', 'minimal-loop', 'minimal-if', 'minimal-direct', 'ssgi-only', 'dof-only' ];
		for ( const profile of profiles ) for ( const mode of [ 'stock', 'patched' ] ) {

			const page = await browser.newPage();
			const errors = [];
			page.on( 'pageerror', error => errors.push( error.message ) );
			await page.goto( `${ base }frame.html?profile=${ profile }&mode=${ mode }`, { waitUntil: 'networkidle0' } );
			await page.waitForFunction( () => [ 'rendered', 'guarded', 'error' ].includes( window.contextReproResult?.status ), { timeout: 30000 } );
			const result = await page.evaluate( () => window.contextReproResult );
			result.browserErrors = errors; report.cases.push( result );
			await page.screenshot( { path: path.join( output, `${ profile }-${ mode }.png` ) } );
			console.log( `${ profile } ${ mode }: ${ result.status }, stack ${ result.maxStack }, duplicate insertions ${ result.maxDuplicates }, ${ result.leakedContexts } leaked contexts, ${ result.frames } frames${ result.message ? '; ' + result.message : '' }` );
			await page.close();
			await writeFile( path.join( output, 'results.json' ), JSON.stringify( report, null, 2 ) + '\n' );

		}

		for ( const result of report.cases ) {

			assert.deepEqual( result.browserErrors, [] ); assert.deepEqual( result.gpuErrors, [] );
			if ( result.mode === 'patched' || result.profile !== 'ssgi-dof' ) {

				assert.equal( result.status, 'rendered', `${ result.profile } ${ result.mode }: ${ result.message }` );
				assert.equal( result.frames, 12 );

			} else assert.equal( result.status, 'guarded', `${ result.profile }: reproduce stock runaway growth` );
			if ( result.mode === 'patched' ) assert.equal( result.leakedContexts, 0 );
			if ( result.mode === 'stock' && [ 'minimal-loop', 'minimal-if', 'ssgi-dof' ].includes( result.profile ) ) assert.ok( result.leakedContexts > 0, 'Stock must carry flow state into the child material' );

		}

		console.log( `PASS: ${ report.cases.length } WebGPU runs.` );

	} finally {

		await browser?.close(); server.close();

	}

}
