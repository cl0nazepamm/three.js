// Install the selected source before any module is loaded. The stock file is a
// byte-identical copy of upstream Renderer.js, beside it for relative imports.
{

	const patched = new URLSearchParams( location.search ).get( 'renderer' ) === 'patched';
	const source = new URL( '../../../src/', location.href );
	const imports = {
		three: new URL( 'Three.WebGPU.js', source ).href,
		'three/webgpu': new URL( 'Three.WebGPU.js', source ).href,
		'three/tsl': new URL( 'Three.TSL.js', source ).href,
		'three/addons/': new URL( '../../../examples/jsm/', location.href ).href
	};

	if ( ! patched ) {

		imports[ new URL( 'renderers/common/Renderer.js', source ).href ] = new URL( 'renderers/common/Renderer.stock.js', source ).href;

	}

	const map = document.createElement( 'script' );
	map.type = 'importmap';
	map.textContent = JSON.stringify( { imports } );
	document.head.appendChild( map );

}
