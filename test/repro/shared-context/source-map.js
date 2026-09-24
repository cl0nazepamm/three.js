{

	const source = new URL( '../../../src/', location.href );
	const imports = {
		three: new URL( 'Three.WebGPU.js', source ).href,
		'three/webgpu': new URL( 'Three.WebGPU.js', source ).href,
		'three/tsl': new URL( 'Three.TSL.js', source ).href,
		'three/addons/': new URL( '../../../examples/jsm/', location.href ).href
	};
	if ( new URLSearchParams( location.search ).get( 'mode' ) !== 'patched' ) {

		imports[ new URL( 'nodes/core/NodeBuilder.js', source ).href ] = new URL( 'nodes/core/NodeBuilder.stock.js', source ).href;

	}

	const map = document.createElement( 'script' );
	map.type = 'importmap';
	map.textContent = JSON.stringify( { imports } );
	document.head.appendChild( map );

}
