// The targets of weighted transparency, as EncodeTransparent of Renderer3D in the .NET version.

/** @internal The format of the summed colors of see-through surfaces. */
export const accumulationFormat: GPUTextureFormat = 'rgba16float';
/** @internal The format of how much of the picture still shows through. */
export const revealFormat: GPUTextureFormat = 'r8unorm';

/** @internal The targets of a pipeline that draws see-through: summed colors and what still shows through. */
export function transparentTargets(): GPUColorTargetState[] {
  return [
    {
      format: accumulationFormat,
      blend: {
        color: { operation: 'add', srcFactor: 'one', dstFactor: 'one' },
        alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'one' },
      },
    },
    {
      format: revealFormat,
      blend: {
        color: { operation: 'add', srcFactor: 'zero', dstFactor: 'one-minus-src' },
        alpha: { operation: 'add', srcFactor: 'zero', dstFactor: 'one-minus-src' },
      },
    },
  ];
}
