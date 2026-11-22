#version 300 es
// The glow around a line segment, from fs_glow of polyline.wgsl of the .NET version. Drawn with a maximum blend:
// neighboring segments overlap, and their glow must not add up.

precision highp float;
precision highp int;

layout(std140) uniform Params {
    vec2 target_size;
    float width;
    vec4 color;
    vec2 scale;
    vec2 offset;
    float glow_radius;
    float glow_intensity;
    vec4 unused_a;
    vec4 unused_b;
    vec4 unused_c;
    vec4 unused_d;
    vec4 turn;
};

in vec2 v_local;
flat in float v_segment_length;

out vec4 fragment;

float segment_distance() {
    float nearest = clamp(v_local.x, 0.0, v_segment_length);
    return length(vec2(v_local.x - nearest, v_local.y));
}

void main() {
    float reach = segment_distance() / glow_radius;
    float alpha = color.a * glow_intensity * exp(-2.0 * reach * reach);
    fragment = vec4(color.rgb * alpha, alpha);
}
