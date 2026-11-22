#version 300 es
// Solid triangles with per-vertex color, from flat.wgsl of the .NET version. Positions are pixels relative to the top
// left of the target.

precision highp float;
precision highp int;

layout(std140) uniform Params {
    vec2 target_size;
};

layout(location = 0) in vec2 position;
layout(location = 1) in vec4 color;

out vec4 v_color;

void main() {
    vec2 ndc = position / target_size * 2.0 - 1.0;
    gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
    v_color = color;
}
