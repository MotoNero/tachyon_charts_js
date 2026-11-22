#version 300 es
// One instanced quad per scatter point, from marker.wgsl of the .NET version.

precision highp float;
precision highp int;

layout(std140) uniform Params {
    vec2 target_size;
    float border_width;
    vec4 border_color;
    vec2 scale;
    vec2 offset;
    float size_scale;
    uint shape;
    vec4 unused_a;
    vec4 unused_b;
    vec4 unused_c;
    vec4 unused_d;
    vec4 turn;
};

layout(location = 0) in vec2 marker_position;
layout(location = 1) in float marker_size;
layout(location = 2) in vec4 color;

out vec2 v_local;
out vec4 v_color;
flat out float v_half_size;

const vec2 corners[6] = vec2[6](
    vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(1.0, 1.0),
    vec2(-1.0, -1.0), vec2(1.0, 1.0), vec2(-1.0, 1.0)
);

// A quarter turn clockwise for a chart whose X axis runs down: (x, y) lands at (sum - y, x).
vec2 turned(vec2 point) {
    if (turn.x > 0.5) {
        return vec2(turn.y - point.y, point.x);
    }
    return point;
}

void main() {
    float half_size = marker_size * size_scale * 0.5;
    vec2 local = corners[gl_VertexID];
    vec2 pixel = marker_position * scale + offset + local * (half_size + 1.0);
    vec2 ndc = turned(pixel) / target_size * 2.0 - 1.0;

    gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
    v_local = local * (1.0 + 1.0 / max(half_size, 0.001));
    v_color = color;
    v_half_size = half_size;
}
