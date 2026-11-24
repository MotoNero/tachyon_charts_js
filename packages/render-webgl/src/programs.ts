// The shader programs of the 2D commands, made once per device, and the layout of their vertex data, as the
// pipelines of the WebGPU package.
import {
  flatFrag,
  flatVert,
  imageFrag,
  imageVert,
  markerFrag,
  markerVert,
  polylineFrag,
  polylineGlowFrag,
  polylineVert,
  rasterFrag,
  rasterVert,
  textFrag,
  textVert,
} from './generated/shaders';

/** Bytes of the uniforms of one command: the Params of the shaders, the quarter turn at 128 included. */
export const paramsSize = 144;

/** Bytes of one corner of a flat triangle: x, y as floats and the color as four bytes. */
export const flatVertexSize = 12;

/** Bytes of one point of a line. */
export const pointSize = 8;

/** Bytes of one marker: x, y, size as floats and the color as four bytes. */
export const markerSize = 16;

/** Bytes of one glyph: position, size, two corners in the atlas, color, distance scale, rotation, pivot. */
export const glyphSize = 52;

/** A vertex attribute: location, number of components, whether it is four normalized bytes, offset in its record. */
export interface Attribute {
  readonly location: number;
  readonly size: number;
  readonly bytes: boolean;
  readonly offset: number;
}

/** A linked program with the array of its vertex attributes. */
export interface Program {
  readonly program: WebGLProgram;
  readonly vertexArray: WebGLVertexArrayObject;
  readonly attributes: readonly Attribute[];
  readonly stride: number;
}

export interface Programs {
  readonly flat: Program;
  readonly polyline: Program;
  readonly glow: Program;
  readonly marker: Program;
  readonly text: Program;
  readonly raster: Program;
  /** Pixels of an RGBA texture on a rectangle. */
  readonly image: Program;
}

// The glyph fields in order, as the vertex buffer layout of the WebGPU text pipeline.
const glyphAttributes: Attribute[] = [
  { location: 0, size: 2, bytes: false, offset: 0 },
  { location: 1, size: 2, bytes: false, offset: 8 },
  { location: 2, size: 2, bytes: false, offset: 16 },
  { location: 3, size: 2, bytes: false, offset: 24 },
  { location: 4, size: 4, bytes: true, offset: 32 },
  { location: 5, size: 1, bytes: false, offset: 36 },
  { location: 6, size: 1, bytes: false, offset: 40 },
  { location: 7, size: 2, bytes: false, offset: 44 },
];

/** Compiles and links all programs; throws with the log of the driver when a shader does not compile. */
export function createPrograms(gl: WebGL2RenderingContext): Programs {
  const make = (
    name: string,
    vertex: string,
    fragment: string,
    attributes: Attribute[],
    stride: number,
    samplers: readonly string[] = [],
  ): Program => {
    const program = link(gl, name, vertex, fragment);
    const block = gl.getUniformBlockIndex(program, 'Params');
    if (block !== gl.INVALID_INDEX) {
      gl.uniformBlockBinding(program, block, 0);
    }
    gl.useProgram(program);
    samplers.forEach((sampler, unit) => {
      gl.uniform1i(gl.getUniformLocation(program, sampler), unit);
    });
    gl.useProgram(null);
    const vertexArray = gl.createVertexArray();
    gl.bindVertexArray(vertexArray);
    for (const attribute of attributes) {
      gl.enableVertexAttribArray(attribute.location);
    }
    gl.bindVertexArray(null);
    return { program, vertexArray, attributes, stride };
  };
  const segment: Attribute[] = [
    { location: 0, size: 2, bytes: false, offset: 0 },
    { location: 1, size: 2, bytes: false, offset: pointSize },
  ];
  return {
    flat: make(
      'flat',
      flatVert,
      flatFrag,
      [
        { location: 0, size: 2, bytes: false, offset: 0 },
        { location: 1, size: 4, bytes: true, offset: 8 },
      ],
      flatVertexSize,
    ),
    polyline: make('polyline', polylineVert, polylineFrag, segment, pointSize),
    glow: make('polyline glow', polylineVert, polylineGlowFrag, segment, pointSize),
    marker: make(
      'marker',
      markerVert,
      markerFrag,
      [
        { location: 0, size: 2, bytes: false, offset: 0 },
        { location: 1, size: 1, bytes: false, offset: 8 },
        { location: 2, size: 4, bytes: true, offset: 12 },
      ],
      markerSize,
    ),
    text: make('text', textVert, textFrag, glyphAttributes, glyphSize, ['atlas']),
    raster: make('raster', rasterVert, rasterFrag, [], 0, ['values', 'colormap']),
    image: make('image', imageVert, imageFrag, [], 0, ['image']),
  };
}

/**
 * Points the attributes of a program at a buffer, from `base` bytes on. `instanced` steps them once per instance,
 * else once per vertex.
 */
export function pointAttributes(
  gl: WebGL2RenderingContext,
  program: Program,
  buffer: WebGLBuffer,
  base: number,
  instanced: boolean,
): void {
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  for (const attribute of program.attributes) {
    gl.vertexAttribPointer(
      attribute.location,
      attribute.size,
      attribute.bytes ? gl.UNSIGNED_BYTE : gl.FLOAT,
      attribute.bytes,
      program.stride,
      base + attribute.offset,
    );
    gl.vertexAttribDivisor(attribute.location, instanced ? 1 : 0);
  }
}

function link(gl: WebGL2RenderingContext, name: string, vertexSource: string, fragmentSource: string): WebGLProgram {
  const program = gl.createProgram();
  const shaders = [
    compile(gl, name, gl.VERTEX_SHADER, vertexSource),
    compile(gl, name, gl.FRAGMENT_SHADER, fragmentSource),
  ];
  for (const shader of shaders) {
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  for (const shader of shaders) {
    gl.deleteShader(shader);
  }
  if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
    throw new Error(`The ${name} program does not link: ${gl.getProgramInfoLog(program) ?? ''}`);
  }
  return program;
}

function compile(gl: WebGL2RenderingContext, name: string, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error(`The ${name} shader cannot be created; the context may be lost.`);
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const stage = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
    throw new Error(`The ${stage} shader of ${name} does not compile: ${gl.getShaderInfoLog(shader) ?? ''}`);
  }
  return shader;
}
