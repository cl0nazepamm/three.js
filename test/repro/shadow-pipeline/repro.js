import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const parameters = new URLSearchParams( location.search );
const rendererMode = parameters.get( 'renderer' ) === 'patched' ? 'patched' : 'stock';
const profiles = {
	mixed: { title: 'Mixed sides · no wrapper', description: `FrontSide + DoubleSide shadows. ${ rendererMode === 'stock' ? 'Stock upstream: expect two new shadow pipelines per frame.' : 'Patched renderer: expect zero new shadow pipelines after warm-up.' }` },
	keyed: { title: 'Mixed sides · side-key workaround', keyed: true, description: 'Same materials and shadows. A local renderObject wrapper separates the shadow cache by effective side.' },
	uniform: { title: 'Same sides · control', uniform: true, description: 'Both source materials use FrontSide. Expected: zero new pipelines after warm-up.' },
	explicit: { title: 'Equal shadowSide · control', explicit: 'equal', description: 'Mixed visible sides, both shadowSide = BackSide. This changes shadow semantics; it is only a control.' },
	'shadow-override': { title: 'Mixed shadowSide · no wrapper', uniform: true, explicit: 'mixed', description: 'Both visible sides are FrontSide; explicit shadowSide values differ. Stock should churn; patched should stay quiet.' },
	'shadow-override-keyed': { title: 'Mixed shadowSide · workaround', uniform: true, explicit: 'mixed', keyed: true, description: 'Checks that the wrapper honors explicit shadowSide, keeping its two shadow cache entries separate.' },
	'off': { title: 'Shadows off · control', off: true, description: 'Same mixed-side mesh, shadows disabled. Expected: zero new pipelines after warm-up.' }
};

const $ = id => document.getElementById( id );
const viewport = $( 'viewport' );
const nextFrame = () => new Promise( resolve => requestAnimationFrame( resolve ) );
const shadowSides = [ THREE.BackSide, THREE.FrontSide, THREE.DoubleSide ];
let current;
let busy = false;

for ( const [ id, profile ] of Object.entries( profiles ) ) {

	$( 'profile' ).add( new Option( profile.title, id ) );

}

$( 'revision' ).textContent = `r${ THREE.REVISION } source`;
$( 'renderer' ).value = rendererMode;
$( 'renderer' ).addEventListener( 'change', () => {

	const url = new URL( location.href );
	url.searchParams.set( 'renderer', $( 'renderer' ).value );
	url.searchParams.set( 'profile', $( 'profile' ).value );
	url.searchParams.delete( 'autorun' );
	location.href = url.href;

} );

function instrument( renderer ) {

	const device = renderer.backend.device;
	const counters = { shadowSync: 0, shadowAsync: 0, other: 0, shaders: 0 };
	const errors = [];
	const labels = new Set();
	const restore = [];
	let shadowPass = false;

	function wrap( object, name, factory ) {

		const original = object[ name ];
		const own = Object.getOwnPropertyDescriptor( object, name );
		object[ name ] = factory( original );
		restore.push( () => {

			if ( own ) Object.defineProperty( object, name, own );
			else delete object[ name ];

		} );

	}

	// Use the backend's actual material to classify calls, not a fragile label match.
	wrap( renderer.backend, 'createRenderPipeline', original => function ( renderObject, promises ) {

		const previous = shadowPass;
		shadowPass = renderObject.material.isShadowPassMaterial === true;
		try {

			return original.call( this, renderObject, promises );

		} finally {

			shadowPass = previous;

		}

	} );

	if ( renderer.backend.isWebGLBackend === true ) {

		const gl = renderer.backend.gl;
		wrap( gl, 'createProgram', original => function ( ...args ) {

			counters[ shadowPass ? 'shadowSync' : 'other' ] ++;
			return original.apply( this, args );

		} );
		wrap( gl, 'createShader', original => function ( ...args ) {

			counters.shaders ++;
			return original.apply( this, args );

		} );
		return { counters, errors, labels, restore() { for ( const undo of restore.reverse() ) undo(); } };

	}

	for ( const [ name, key ] of [[ 'createRenderPipeline', 'shadowSync' ], [ 'createRenderPipelineAsync', 'shadowAsync' ]] ) {

		wrap( device, name, original => function ( descriptor ) {

			counters[ shadowPass ? key : 'other' ] ++;
			if ( shadowPass ) labels.add( descriptor.label );
			return original.call( this, descriptor );

		} );

	}

	wrap( device, 'createShaderModule', original => function ( descriptor ) {

		counters.shaders ++;
		return original.call( this, descriptor );

	} );

	// Three.js scopes pipeline validation errors internally; also record those.
	wrap( device, 'popErrorScope', original => function () {

		return original.call( this ).then( error => {

			if ( error ) errors.push( error.message );
			return error;

		} );

	} );

	const onError = event => errors.push( event.error.message );
	device.addEventListener( 'uncapturederror', onError );
	renderer.onDeviceLost = info => errors.push( `Device lost: ${ info.message }` );

	return {
		counters, errors, labels,
		restore() {

			device.removeEventListener( 'uncapturederror', onError );
			for ( const undo of restore.reverse() ) undo();

		}
	};

}

function installSideKey( renderer ) {

	const original = renderer.renderObject;
	renderer.renderObject = function ( object, scene, camera, geometry, material, group, lightsNode, clippingContext = null, passId = null ) {

		if ( passId === null && material.allowOverride === true && scene.overrideMaterial?.isShadowPassMaterial === true ) {

			const side = material.shadowSide ?? ( this.shadowMap.type === THREE.VSMShadowMap ? material.side : shadowSides[ material.side ] );
			passId = `shadow-side-${ side }`;

		}

		return original.call( this, object, scene, camera, geometry, material, group, lightsNode, clippingContext, passId );

	};

}

export async function createScene( profile ) {

	const renderer = new THREE.WebGPURenderer( { antialias: true, forceWebGL: profile.forceWebGL === true } );
	renderer.setPixelRatio( 1 );
	renderer.setSize( viewport.clientWidth, viewport.clientHeight );
	renderer.shadowMap.enabled = ! profile.off;
	renderer.shadowMap.type = THREE.PCFShadowMap;
	await renderer.init();
	if ( profile.forceWebGL ? renderer.backend.isWebGLBackend !== true : renderer.backend.isWebGPUBackend !== true ) {

		renderer.dispose();
		throw new Error( 'WebGPU is required; a WebGL fallback cannot measure this issue.' );

	}

	const probe = instrument( renderer );
	if ( profile.keyed ) installSideKey( renderer );
	viewport.replaceChildren( renderer.domElement );

	const scene = new THREE.Scene();
	scene.background = new THREE.Color( 0x111923 );
	const camera = new THREE.PerspectiveCamera( 42, viewport.clientWidth / viewport.clientHeight, 0.1, 50 );
	camera.position.set( 7, 6, 10 );
	const controls = new OrbitControls( camera, renderer.domElement );
	controls.target.set( 0, 1, 0 );
	controls.update();
	scene.add( new THREE.HemisphereLight( 0xcce4ff, 0x41352d, 2 ) );
	const light = new THREE.DirectionalLight( 0xffe6ca, 4 );
	light.position.set( - 3, 7, 4 );
	light.castShadow = true;
	light.shadow.mapSize.set( 1024, 1024 );
	Object.assign( light.shadow.camera, { left: - 6, right: 6, top: 6, bottom: - 6, near: 0.1, far: 25 } );
	light.shadow.normalBias = 0.025;
	scene.add( light );

	const materials = [
		new THREE.MeshStandardMaterial( { color: 0xe58b48, roughness: 0.6, side: THREE.FrontSide } ),
		new THREE.MeshStandardMaterial( { color: 0x49b9d1, roughness: 0.6, side: profile.uniform ? THREE.FrontSide : THREE.DoubleSide } )
	];
	if ( profile.explicit ) {

		materials[ 0 ].shadowSide = THREE.BackSide;
		materials[ 1 ].shadowSide = profile.explicit === 'equal' ? THREE.BackSide : THREE.DoubleSide;

	}

	const left = new THREE.BoxGeometry( 1.7, 2.7, 1.7 ).translate( - 1.3, 1.6, 0 );
	const right = new THREE.BoxGeometry( 1.7, 1.8, 1.7 ).translate( 1.3, 1.15, 0 );
	// mergeGeometries(..., true) creates exactly two groups in ONE mesh.
	const geometry = mergeGeometries( [ left, right ], true );
	left.dispose();
	right.dispose();
	const caster = new THREE.Mesh( geometry, materials );
	caster.castShadow = true;
	scene.add( caster );
	const ground = new THREE.Mesh( new THREE.PlaneGeometry( 200, 200 ), new THREE.MeshStandardMaterial( { color: 0x536577, roughness: 1 } ) );
	ground.rotation.x = - Math.PI / 2;
	ground.receiveShadow = true;
	scene.add( ground );

	const draw = () => renderer.render( scene, camera );
	const onChange = () => {

		if ( ! busy ) draw();

	};

	controls.addEventListener( 'change', onChange );

	return {
		renderer, scene, camera, probe, draw,
		materials: materials.map( material => ( { side: material.side, shadowSide: material.shadowSide } ) ),
		groups: geometry.groups,
		async dispose() {

			controls.dispose();
			geometry.dispose();
			ground.geometry.dispose();
			ground.material.dispose();
			for ( const material of materials ) material.dispose();
			light.dispose();
			probe.restore();
			await renderer.dispose();

		}
	};

}

function showResult( result ) {

	for ( const key of [ 'shadowSync', 'shadowAsync', 'other', 'shaders' ] ) $( key ).textContent = result[ key ];
	$( 'frames' ).textContent = result.frames;
	$( 'rate' ).textContent = result.shadowPerFrame.toFixed( 2 );
	$( 'errors' ).textContent = result.errors.length;
	$( 'status' ).dataset.state = result.errors.length ? 'error' : result.shadowPerFrame > 0 ? 'churn' : 'quiet';
	$( 'status' ).textContent = result.errors.length ? result.errors.join( '\n' ) : result.shadowPerFrame > 0 ? 'Churn detected after warm-up.' : 'Quiet after warm-up: no shadow pipeline creation.';

}

async function measure( id ) {

	const profile = profiles[ id ];
	if ( ! profile ) throw new Error( `Unknown profile: ${ id }` );
	$( 'profile' ).value = id;
	$( 'description' ).textContent = profile.description;
	$( 'status' ).dataset.state = '';
	$( 'status' ).textContent = 'Creating a fresh renderer…';
	await current?.dispose();
	current = null;
	current = await createScene( profile );
	const { probe, renderer } = current;
	const warmupFrames = 12;
	const frames = 120;
	$( 'status' ).textContent = `Warming up ${ warmupFrames } frames…`;
	for ( let i = 0; i < warmupFrames; i ++ ) {

		await nextFrame();
		current.draw();

	}

	await renderer.backend.device.queue.onSubmittedWorkDone();
	const before = { ...probe.counters };
	probe.labels.clear();
	const perFrame = [];
	for ( let i = 0; i < frames; i ++ ) {

		await nextFrame();
		const start = probe.counters.shadowSync + probe.counters.shadowAsync;
		current.draw();
		perFrame.push( probe.counters.shadowSync + probe.counters.shadowAsync - start );
		$( 'status' ).textContent = `Measuring frame ${ i + 1 } / ${ frames }…`;

	}

	await renderer.backend.device.queue.onSubmittedWorkDone();
	await nextFrame();
	const measured = Object.fromEntries( Object.keys( before ).map( key => [ key, probe.counters[ key ] - before[ key ] ] ) );
	const result = {
		id, rendererMode, revision: THREE.REVISION, backend: 'WebGPU', frames, warmupFrames, ...measured,
		shadowPerFrame: ( measured.shadowSync + measured.shadowAsync ) / frames,
		perFrame, errors: [ ...probe.errors ], labels: [ ...probe.labels ],
		materials: current.materials, groups: current.groups, keyed: profile.keyed === true,
		userAgent: navigator.userAgent
	};
	showResult( result );
	window.shadowRepro.lastResult = result;
	return result;

}

function setBusy( value ) {

	busy = value;
	for ( const id of [ 'run', 'compare', 'profile' ] ) $( id ).disabled = value;

}

async function run( id = $( 'profile' ).value ) {

	if ( busy ) throw new Error( 'A measurement is already running.' );
	setBusy( true );
	try {

		return await measure( id );

	} finally {

		setBusy( false );

	}

}

async function compare() {

	if ( busy ) throw new Error( 'A measurement is already running.' );
	setBusy( true );
	$( 'results' ).replaceChildren();
	$( 'comparison' ).hidden = false;
	const results = [];
	try {

		for ( const id of Object.keys( profiles ) ) {

			const result = await measure( id );
			results.push( result );
			const row = $( 'results' ).insertRow();
			row.insertCell().textContent = profiles[ id ].title;
			row.insertCell().textContent = result.errors.length ? 'GPU error' : result.shadowPerFrame.toFixed( 2 );

		}

		return results;

	} finally {

		setBusy( false );

	}

}

function reportError( error ) {

	$( 'status' ).dataset.state = 'error';
	$( 'status' ).textContent = error.message;
	console.error( error );

}

window.addEventListener( 'resize', () => {

	if ( ! current || busy ) return;
	current.renderer.setSize( viewport.clientWidth, viewport.clientHeight );
	current.camera.aspect = viewport.clientWidth / viewport.clientHeight;
	current.camera.updateProjectionMatrix();
	current.draw();

} );
window.addEventListener( 'pagehide', () => current?.dispose() );
$( 'profile' ).addEventListener( 'change', () => {

	$( 'description' ).textContent = profiles[ $( 'profile' ).value ].description;

} );
$( 'run' ).addEventListener( 'click', () => run().catch( reportError ) );
$( 'compare' ).addEventListener( 'click', () => compare().catch( reportError ) );
window.shadowRepro = { run, compare, profiles: Object.keys( profiles ), lastResult: null };
setBusy( false );
if ( parameters.get( 'autorun' ) !== '0' ) run( profiles[ parameters.get( 'profile' ) ] ? parameters.get( 'profile' ) : 'mixed' ).catch( reportError );
