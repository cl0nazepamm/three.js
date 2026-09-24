import { WebGPURenderer } from 'three/webgpu';

const probe = window.exampleProbe = { renderers: [], counters: { sync: 0, async: 0, shaders: 0 }, errors: [], timings: [], frames: 0 };
const instrumented = new WeakSet();
const init = WebGPURenderer.prototype.init;
WebGPURenderer.prototype.init = async function ( ...args ) {

	const result = await init.apply( this, args );
	if ( ! instrumented.has( this ) ) {

		instrumented.add( this );
		probe.renderers.push( this );
		this.domElement.setAttribute( 'data-shadow-validation', '' );
		if ( window.validationForceWebGL ) {

			if ( this.backend.isWebGLBackend !== true || ! ( this.backend.gl instanceof WebGL2RenderingContext ) ) throw new Error( 'Expected WebGL2 backend' );
			const gl = this.backend.gl;
			for ( const [ method, key ] of [[ 'createProgram', 'sync' ], [ 'createShader', 'shaders' ]] ) {

				const original = gl[ method ];
				gl[ method ] = function ( ...args ) {

					probe.counters[ key ] ++;
					return original.apply( this, args );

				};

			}
			return result;

		}
		if ( this.backend.isWebGPUBackend !== true ) throw new Error( 'Expected WebGPU backend' );
		const device = this.backend.device;
		for ( const [ method, key ] of [[ 'createRenderPipeline', 'sync' ], [ 'createRenderPipelineAsync', 'async' ], [ 'createShaderModule', 'shaders' ]] ) {

			const original = device[ method ];
			device[ method ] = function ( ...args ) {

				probe.counters[ key ] ++;
				return original.apply( this, args );

			};

		}

		const pop = device.popErrorScope;
		device.popErrorScope = async function () {

			const error = await pop.call( this );
			if ( error ) probe.errors.push( error.message );
			return error;

		};

		device.addEventListener( 'uncapturederror', event => probe.errors.push( event.error.message ) );
		this.onDeviceLost = info => probe.errors.push( `Device lost: ${ info.message }` );

	}

	return result;

};

const render = WebGPURenderer.prototype.render;
let renderDepth = 0;
WebGPURenderer.prototype.render = function ( ...args ) {

	const outermost = renderDepth ++ === 0;
	const start = window.validationRealNow();
	try {

		return render.apply( this, args );

	} finally {

		renderDepth --;
		if ( outermost ) {

			probe.timings.push( window.validationRealNow() - start );
			probe.frames ++;
			probe.scene = args[ 0 ];

		}

	}

};
