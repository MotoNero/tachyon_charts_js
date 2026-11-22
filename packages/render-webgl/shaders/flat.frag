#version 300 es
// Solid triangles with per-vertex color, from flat.wgsl of the .NET version.

precision highp float;
precision highp int;

in vec4 v_color;

out vec4 fragment;

void main() {
    fragment = v_color;
}
