#version 300 es
// One instanced quad per line segment, from polyline.wgsl of the .NET version. The fragment shader computes the
// distance to the segment, which gives analytic anti-aliasing and round joins and caps without MSAA.

precision highp float;
precision highp int;

// The layout of the uniforms is the one of the WGSL shaders, so that both backends fill them alike.
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

layout(location = 0) in vec2 start;
layout(location = 1) in vec2 end;

// Position in the segment frame: x along the segment from its start, y across it.
out vec2 v_local;
flat out float v_segment_length;

const vec2 corners[6] = vec2[6](
    vec2(0.0, -1.0), vec2(1.0, -1.0), vec2(1.0, 1.0),
    vec2(0.0, -1.0), vec2(1.0, 1.0), vec2(0.0, 1.0)
);

// A quarter turn clockwise for a chart whose X axis runs down: (x, y) lands at (sum - y, x).
vec2 turned(vec2 point) {
    if (turn.x > 0.5) {
        return vec2(turn.y - point.y, point.x);
    }
    return point;
}

// Lines below one pixel render one pixel wide with reduced coverage.
float half_width() {
    return max(width, 1.0) * 0.5;
}

void main() {
    // A gap point interrupts the line. All corners collapse, so the quad covers nothing.
    if (start.x >= 1e30 || end.x >= 1e30) {
        gl_Position = vec4(0.0, 0.0, 0.0, 1.0);
        v_local = vec2(0.0);
        v_segment_length = 0.0;
        return;
    }

    vec2 first = start * scale + offset;
    vec2 segment = (end - start) * scale;
    float segment_length = length(segment);
    vec2 direction = segment_length > 0.0 ? segment / segment_length : vec2(1.0, 0.0);
    vec2 normal = vec2(-direction.y, direction.x);

    // One extra pixel leaves room for the anti-aliased edge and the round caps.
    float extent = half_width() + 1.0 + glow_radius;
    vec2 corner = corners[gl_VertexID];
    float along = corner.x * (segment_length + 2.0 * extent) - extent;
    float across = corner.y * extent;

    vec2 position = first + direction * along + normal * across;
    vec2 ndc = turned(position) / target_size * 2.0 - 1.0;

    gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
    v_local = vec2(along, across);
    v_segment_length = segment_length;
}
