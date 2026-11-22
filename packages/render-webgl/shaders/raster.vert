#version 300 es
// A texture of values on a rectangle, from raster.wgsl of the .NET version: six corners from the vertex index.

precision highp float;
precision highp int;

layout(std140) uniform Params {
    vec2 target_size;
    float is_interpolated;
    vec4 reduction;
    vec2 scale;
    vec2 offset;
    float is_log;
    uint row_shift;
    float value_min;
    float value_max;
    vec2 section_origin;
    vec2 section_size;
    vec4 missing_color;
    vec4 below_color;
    vec4 above_color;
    vec4 turn;
};

out vec2 v_section;

const vec2 corners[6] = vec2[6](
    vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(1.0, 1.0),
    vec2(0.0, 0.0), vec2(1.0, 1.0), vec2(0.0, 1.0)
);

// A quarter turn clockwise for a chart whose X axis runs down: (x, y) lands at (sum - y, x).
vec2 turned(vec2 point) {
    if (turn.x > 0.5) {
        return vec2(turn.y - point.y, point.x);
    }
    return point;
}

void main() {
    vec2 corner = corners[gl_VertexID];
    vec2 position = offset + scale * corner;
    vec2 ndc = turned(position) / target_size * 2.0 - 1.0;

    gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
    v_section = section_origin + section_size * corner;
}
