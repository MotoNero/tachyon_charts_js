#version 300 es
// The pixels of an RGBA texture, from image.wgsl of the .NET version: texelFetch picks the nearest texel, as
// textureLoad does there.

precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D image;

in vec2 v_uv;
out vec4 color_out;

void main() {
    ivec2 size = textureSize(image, 0);
    ivec2 texel = clamp(ivec2(v_uv * vec2(size)), ivec2(0), size - 1);
    color_out = texelFetch(image, texel, 0);
}
