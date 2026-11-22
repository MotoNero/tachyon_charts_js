#version 300 es
// The coverage of a line segment, from fs_main of polyline.wgsl of the .NET version.

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

float half_width() {
    return max(width, 1.0) * 0.5;
}

float segment_distance() {
    float nearest = clamp(v_local.x, 0.0, v_segment_length);
    return length(vec2(v_local.x - nearest, v_local.y));
}

void main() {
    float distance = segment_distance();
    float coverage = clamp(half_width() + 0.5 - distance, 0.0, 1.0) * min(width, 1.0);
    fragment = vec4(color.rgb, color.a * coverage);
}
