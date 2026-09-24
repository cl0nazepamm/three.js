import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
import { createServer } from '../../../utils/server.js';

const root = fileURLToPath( new URL( '../../../', import.meta.url ) );
const args = process.argv.slice( 2 );
const serve = args.includes( '--serve' );
const expected = args.includes( '--expect=fixed' ) ? 'fixed' : 'affected';
const server = createServer( { root } );
server.listen( serve ? Number( process.env.PORT || 8092 ) : 0, '127.0.0.1' );
await once( server, 'listening' );
const url = `http://127.0.0.1:${ server.address().port }/test/repro/shadow-pipeline/`;

if ( serve ) {

	console.log( `Shadow pipeline repro: ${ url }` );
	console.log( 'Serving source directly. Press Ctrl+C to stop.' );
	process.on( 'SIGINT', () => server.close() );

} else {

	let browser;
	try {

		browser = await puppeteer.launch( {
			headless: true,
			executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
			args: [ '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--disable-background-timer-throttling' ],
			defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 1 }
		} );
		const page = await browser.newPage();
		const errors = [];
		page.on( 'pageerror', error => errors.push( error.message ) );
		page.on( 'console', message => {

			if ( message.type() === 'error' ) errors.push( message.text() );

		} );
		await page.goto( `${ url }?autorun=0&renderer=${ expected === 'fixed' ? 'patched' : 'stock' }`, { waitUntil: 'networkidle0' } );
		await page.waitForFunction( () => window.shadowRepro !== undefined );
		const output = path.join( root, 'test/e2e/output-screenshots/shadow-pipeline' );
		await mkdir( output, { recursive: true } );
		const results = [];
		const images = new Map();
		for ( const id of await page.evaluate( () => window.shadowRepro.profiles ) ) {

			const result = await page.evaluate( id => window.shadowRepro.run( id ), id );
			results.push( result );
			console.log( `${ id }: ${ result.shadowPerFrame } shadow pipelines/frame, ${ result.shaders } shader modules, ${ result.errors.length } GPU errors` );
			if ( [ 'mixed', 'keyed', 'shadow-override', 'shadow-override-keyed' ].includes( id ) ) {

				const canvas = await page.$( 'canvas' );
				images.set( id, PNG.sync.read( Buffer.from( await canvas.screenshot( { path: path.join( output, `${ id }.png` ) } ) ) ) );
				await page.screenshot( { path: path.join( output, `${ id }-page.png` ) } );

			}

		}

		const comparisons = [];
		for ( const [ stock, keyed ] of [[ 'mixed', 'keyed' ], [ 'shadow-override', 'shadow-override-keyed' ]] ) {

			const a = images.get( stock );
			const b = images.get( keyed );
			assert.equal( a.width, b.width );
			assert.equal( a.height, b.height );
			let differingPixels = 0;
			for ( let i = 0; i < a.data.length; i += 4 ) {

				if ( a.data[ i ] !== b.data[ i ] || a.data[ i + 1 ] !== b.data[ i + 1 ] || a.data[ i + 2 ] !== b.data[ i + 2 ] || a.data[ i + 3 ] !== b.data[ i + 3 ] ) differingPixels ++;

			}

			comparisons.push( { stock, keyed, differingPixels, pixels: a.width * a.height } );

		}

		await writeFile( path.join( output, 'results.json' ), JSON.stringify( { expected, browser: await browser.version(), results, comparisons, errors }, null, 2 ) + '\n' );
		assert.deepEqual( errors, [], 'Browser errors' );
		for ( const result of results ) {

			const affectedCase = result.id === 'mixed' || result.id === 'shadow-override';
			const pipelinesPerFrame = expected === 'affected' && affectedCase ? 2 : 0;
			assert.deepEqual( result.errors, [], `${ result.id }: GPU errors` );
			assert.equal( result.groups.length, 2, 'The caster must have two geometry groups' );
			assert.equal( result.shadowSync, pipelinesPerFrame * result.frames, `${ result.id }: synchronous shadow pipelines` );
			assert.equal( result.shadowAsync, 0, `${ result.id }: asynchronous shadow pipelines` );
			assert.equal( result.other, 0, `${ result.id }: non-shadow pipelines must remain stable` );
			assert.equal( result.shaders, 0, `${ result.id }: shader modules must remain stable` );
			assert.ok( result.perFrame.every( count => count === pipelinesPerFrame ), `${ result.id }: per-frame pipeline counts` );

		}

		for ( const comparison of comparisons ) {

			assert.equal( comparison.differingPixels, 0, `${ comparison.stock }: workaround must preserve the rendered image` );

		}

		console.log( `PASS (${ expected }): seven cases; both workaround comparisons pixel-identical.\nEvidence: ${ output }` );

	} finally {

		await browser?.close();
		server.close();

	}

}
