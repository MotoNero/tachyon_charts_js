#version 300 es
// Instanced glyph quads, from text.wgsl of the .NET version.

precision highp float;
precision highp int;

layout(std140) uniform Params {
    vec2 target_size;
};

layout(location = 0) in vec2 glyph_position;
layout(location = 1) in vec2 glyph_size;
layout(location = 2) in vec2 uv_min;
layout(location = 3) in vec2 uv_max;
layout(location = 4) in vec4 color;
layout(location = 5) in float distance_scale;
layout(location = 6) in float rotation;
layout(location = 7) in vec2 pivot;

out vec2 v_uv;
out vec4 v_color;
flat out float v_distance_scale;

const vec2 corners[6] = vec2[6](
    vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(1.0, 1.0),
    vec2(0.0, 0.0), vec2(1.0, 1.0), vec2(0.0, 1.0)
);

void main() {
    vec2 corner = corners[gl_VertexID];
    vec2 offset = glyph_position + glyph_size * corner - pivot;
    vec2 turn = vec2(cos(rotation), sin(rotation));
    vec2 position = pivot + vec2(offset.x * turn.x - offset.y * turn.y, offset.x * turn.y + offset.y * turn.x);
    vec2 ndc = position / target_size * 2.0 - 1.0;

    gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
    v_uv = uv_min + (uv_max - uv_min) * corner;
    v_color = color;
    v_distance_scale = distance_scale;
}
