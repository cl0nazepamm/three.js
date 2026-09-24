import * as THREE from 'three/webgpu';
import { Fn, If, Loop, uniform, vec3, vec4, uv, convertToTexture, pass, mrt, output, normalView, diffuseColor, packNormalToRGB, unpackRGBToNormal, sample } from 'three/tsl';
import { ssgi } from 'three/addons/tsl/display/SSGINode.js';
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';
import NodeBuilder from '../../../src/nodes/core/NodeBuilder.js';
import StackNode from '../../../src/nodes/core/StackNode.js';

const parameters = new URLSearchParams( location.search );
const mode = parameters.get( 'mode' ) === 'patched' ? 'patched' : 'stock';
const profile = parameters.get( 'profile' ) || 'ssgi-dof';
const guardLimit = Math.min( 16384, Math.max( 256, Number( parameters.get( 'limit' ) ) || 4096 ) );
const result = { mode, profile, revision: THREE.REVISION, guardLimit, status: 'initializing', frames: 0, maxStack: 0, maxDuplicates: 0, sharedContexts: [], growth: [], gpuErrors: [] };
const resources = [];
let renderer, pipeline, activeBuilder;
const started = performance.now();
function publish() {

	window.contextReproResult = result;
	parent.postMessage( { kind: 'shared-context-result', result }, location.origin );

}

const originalShared = NodeBuilder.prototype.getSharedContext;
NodeBuilder.prototype.getSharedContext = function () {

	const shared = originalShared.call( this );
	if ( result.sharedContexts.length < 40 ) result.sharedContexts.push( {
		material: this.material?.name || this.material?.type || 'unknown',
		parentLoop: Boolean( this.context.nodeLoop ), parentBlock: Boolean( this.context.nodeBlock ),
		sharedLoop: Boolean( shared.nodeLoop ), sharedBlock: Boolean( shared.nodeBlock )
	} );
	return shared;

};

const originalBuild = StackNode.prototype.build;
StackNode.prototype.build = function ( builder, ...args ) {

	const previous = activeBuilder;
	activeBuilder = builder;
	try {

		return originalBuild.call( this, builder, ...args );

	} finally {

		activeBuilder = previous;

	}

};

const originalAdd = StackNode.prototype.addToStack;
const additions = new WeakMap();
StackNode.prototype.addToStack = function ( node, ...args ) {

	const value = originalAdd.call( this, node, ...args );
	let counts = additions.get( this );
	if ( ! counts ) {

		counts = new Map(); additions.set( this, counts );

	}

	const count = ( counts.get( node ) || 0 ) + 1;
	counts.set( node, count );
	result.maxStack = Math.max( result.maxStack, this.nodes.length );
	result.maxDuplicates = Math.max( result.maxDuplicates, count );
	if ( [ 64, 256, 1024, guardLimit ].includes( this.nodes.length ) && result.growth.length < 30 ) result.growth.push( {
		size: this.nodes.length, uniqueNodes: new Set( this.nodes ).size,
		material: activeBuilder?.material?.name || activeBuilder?.material?.type || 'unknown'
	} );
	if ( this.nodes.length >= guardLimit ) {

		result.guard = {
			material: activeBuilder?.material?.name || activeBuilder?.material?.type || 'unknown',
			node: node.name || node.constructor.name, additionsOfSameNode: count,
			uniqueNodes: new Set( this.nodes ).size, stage: activeBuilder?.buildStage,
			nodeLoop: Boolean( activeBuilder?.context.nodeLoop ), nodeBlock: Boolean( activeBuilder?.context.nodeBlock )
		};
		const error = new Error( `Build stopped at ${ guardLimit.toLocaleString() } stack entries; repeated variable insertion detected.` );
		error.name = 'BuildGrowthGuard';
		throw error;

	}

	return value;

};

function minimal( kind ) {

	const color = vec3( uv(), 0.45 ).toVar( 'childColor' );
	const child = vec4( color, 1 );
	const texture = convertToTexture( child );
	resources.push( texture );
	if ( kind === 'minimal-direct' ) return texture;
	return Fn( () => {

		const accumulated = vec4( 0 ).toVar( 'accumulated' );
		if ( kind === 'minimal-loop' ) {

			Loop( 2, () => {

				accumulated.addAssign( texture.sample( uv() ) );

			} );
			return accumulated.div( 2 );

		}

		If( uniform( 1 ).greaterThan( 0 ), () => {

			accumulated.assign( texture.sample( uv() ) );

		} );
		return accumulated;

	} )();

}

function room( kind ) {

	const scene = new THREE.Scene();
	scene.background = new THREE.Color( 0x000000 );
	const camera = new THREE.PerspectiveCamera( 43, 1.5, 0.1, 50 );
	camera.position.set( 0, 3.5, 10.5 );
	camera.lookAt( 0, 2.2, - 1 );
	const white = new THREE.MeshStandardMaterial( { color: 0xd8d5cc, roughness: 0.7 } );
	const red = new THREE.MeshStandardMaterial( { color: 0xd74345, roughness: 0.8 } );
	const teal = new THREE.MeshStandardMaterial( { color: 0x2faca4, roughness: 0.8 } );
	function box( dimensions, position, material, rotation = 0 ) {

		const mesh = new THREE.Mesh( new THREE.BoxGeometry( ...dimensions ), material );
		mesh.position.set( ...position ); mesh.rotation.y = rotation; scene.add( mesh );
		resources.push( mesh.geometry ); return mesh;

	}

	box( [ 8, 0.2, 10 ], [ 0, - 0.1, - 1 ], white );
	box( [ 8, 6, 0.2 ], [ 0, 3, - 5 ], white );
	box( [ 0.2, 6, 10 ], [ - 4, 3, - 1 ], red );
	box( [ 0.2, 6, 10 ], [ 4, 3, - 1 ], teal );
	box( [ 1.8, 3, 1.8 ], [ - 1.3, 1.5, - 2 ], white, 0.3 );
	box( [ 1.6, 1.6, 1.6 ], [ 1.5, 0.8, 1 ], white, - 0.25 );
	const ball = new THREE.Mesh( new THREE.SphereGeometry( 0.85, 32, 24 ), new THREE.MeshStandardMaterial( { color: 0xe7b960, roughness: 0.35 } ) );
	ball.position.set( 0.5, 0.85, - 2.5 ); scene.add( ball );
	resources.push( white, red, teal, ball.geometry, ball.material );
	scene.add( new THREE.HemisphereLight( 0xc8deff, 0x332418, 0.6 ) );
	const light = new THREE.PointLight( 0xffe6c2, 85 );
	light.position.set( 0, 5, 1 ); scene.add( light );
	const scenePass = pass( scene, camera );
	resources.push( scenePass );
	scenePass.setMRT( mrt( { output, diffuseColor, normal: packNormalToRGB( normalView ) } ) );
	const beauty = scenePass.getTextureNode( 'output' );
	if ( kind === 'dof-only' ) {

		const blur = dof( beauty, scenePass.getViewZNode(), 12, 3, 1.5 );
		resources.push( blur ); return blur;

	}

	const normalTexture = scenePass.getTextureNode( 'normal' );
	const normal = sample( coord => unpackRGBToNormal( normalTexture.sample( coord ) ) );
	const gi = ssgi( beauty, scenePass.getTextureNode( 'depth' ), normal, camera );
	gi.sliceCount.value = 2; gi.stepCount.value = 4; gi.radius.value = 3;
	resources.push( gi );
	const composite = vec4( beauty.rgb.mul( gi.getAONode() ).add( scenePass.getTextureNode( 'diffuseColor' ).rgb.mul( gi.getGINode().rgb ) ), beauty.a );
	if ( kind === 'ssgi-only' ) return composite;
	const blur = dof( composite, scenePass.getViewZNode(), 12, 3, 1.5 );
	resources.push( blur, blur.textureNode ); return blur;

}

async function run() {

	try {

		renderer = new THREE.WebGPURenderer( { antialias: false } );
		renderer.setPixelRatio( 1 ); renderer.setSize( 480, 320 );
		await renderer.init();
		if ( ! renderer.backend.isWebGPUBackend ) throw new Error( 'This test requires WebGPU.' );
		const device = renderer.backend.device;
		const createPipeline = renderer.backend.createRenderPipeline;
		renderer.backend.createRenderPipeline = function ( ...args ) {

			// TSL can catch a setup exception. Stop before compiling the incomplete shader.
			if ( result.guard ) {

				const error = new Error( `Build stopped at ${ guardLimit.toLocaleString() } stack entries; repeated variable insertion detected.` );
				error.name = 'BuildGrowthGuard'; throw error;

			}

			return createPipeline.apply( this, args );

		};

		device.addEventListener( 'uncapturederror', event => result.gpuErrors.push( event.error.message ) );
		const pop = device.popErrorScope;
		device.popErrorScope = async function () {

			const error = await pop.call( this ); if ( error ) result.gpuErrors.push( error.message ); return error;

		};

		renderer.onDeviceLost = info => result.gpuErrors.push( `Device lost: ${ info.message }` );
		document.body.appendChild( renderer.domElement );
		pipeline = new THREE.RenderPipeline( renderer );
		pipeline.outputNode = profile.startsWith( 'minimal-' ) ? minimal( profile ) : room( profile );
		result.status = 'building'; publish();
		const buildStarted = performance.now();
		pipeline.render();
		await device.queue.onSubmittedWorkDone();
		result.firstFrameMs = performance.now() - buildStarted; result.frames ++;
		for ( let i = 0; i < 11; i ++ ) {

			pipeline.render(); await device.queue.onSubmittedWorkDone(); result.frames ++;

		}

		result.status = result.gpuErrors.length ? 'error' : 'rendered';

	} catch ( error ) {

		result.status = error.name === 'BuildGrowthGuard' ? 'guarded' : 'error';
		result.message = error.message;
		if ( result.status === 'error' ) {

			result.stack = error.stack; console.error( error );

		}

	}

	result.totalMs = performance.now() - started;
	result.leakedContexts = result.sharedContexts.filter( context => context.sharedLoop || context.sharedBlock ).length;
	document.body.dataset.state = result.status;
	document.getElementById( 'notice' ).textContent = result.message || result.status;
	if ( result.status === 'guarded' ) renderer.domElement.style.display = 'none';
	publish();

}

window.addEventListener( 'pagehide', () => {

	for ( const resource of new Set( resources ) ) resource.dispose?.();
	pipeline?.dispose(); renderer?.dispose();

} );
run();
