#version 300 es
// Glyphs sampled from a multi-channel signed distance field, from text.wgsl of the .NET version. The median of the
// channels restores sharp corners that a single distance channel would round off.

precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D atlas;

in vec2 v_uv;
in vec4 v_color;
flat in float v_distance_scale;

out vec4 fragment;

float median(float a, float b, float c) {
    return max(min(a, b), min(max(a, b), c));
}

// Bilinear in the shader: hardware filters differ in precision and the field amplifies every difference.
vec3 sample_atlas(vec2 uv) {
    ivec2 size = textureSize(atlas, 0);
    vec2 position = uv * vec2(size) - 0.5;
    ivec2 base = clamp(ivec2(floor(position)), ivec2(0), size - 1);
    ivec2 next = min(base + 1, size - 1);
    vec2 weight = clamp(position - vec2(base), vec2(0.0), vec2(1.0));

    vec3 upper = mix(texelFetch(atlas, base, 0).rgb, texelFetch(atlas, ivec2(next.x, base.y), 0).rgb, weight.x);
    vec3 lower = mix(texelFetch(atlas, ivec2(base.x, next.y), 0).rgb, texelFetch(atlas, next, 0).rgb, weight.x);
    return mix(upper, lower, weight.y);
}

// Small text gets slightly stronger strokes, as in text.wgsl: the em size in pixels is the distance scale times 5.
float embolden(float distance_scale) {
    float em_pixels = distance_scale * 5.0;
    return clamp((16.0 - em_pixels) / 8.0, 0.0, 1.0) * 0.15;
}

void main() {
    vec3 distance = sample_atlas(v_uv);
    float signed_distance = median(distance.r, distance.g, distance.b) - 0.5;
    float coverage = clamp(signed_distance * v_distance_scale + 0.5 + embolden(v_distance_scale), 0.0, 1.0);
    fragment = vec4(v_color.rgb, v_color.a * coverage);
}
