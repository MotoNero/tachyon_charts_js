#version 300 es
// Marker shapes and their inward borders as analytic signed distance fields, from marker.wgsl of the .NET version,
// so their edges stay smooth without MSAA.

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

in vec2 v_local;
in vec4 v_color;
flat in float v_half_size;

out vec4 fragment;

float box_distance(vec2 point, vec2 half_extent) {
    vec2 delta = abs(point) - half_extent;
    return length(max(delta, vec2(0.0))) + min(max(delta.x, delta.y), 0.0);
}

float plus_distance(vec2 point) {
    return min(box_distance(point, vec2(0.34, 1.0)), box_distance(point, vec2(1.0, 0.34)));
}

float triangle_distance(vec2 value) {
    float root_three = 1.7320508;
    vec2 point = vec2(abs(value.x) - 1.0, value.y + 0.57735027);
    if (point.x + root_three * point.y > 0.0) {
        point = vec2(point.x - root_three * point.y, -root_three * point.x - point.y) * 0.5;
    }
    point.x = point.x - clamp(point.x, -2.0, 0.0);
    return -length(point) * sign(point.y);
}

float shape_distance(vec2 point) {
    switch (shape) {
        case 0u: return length(point) - 1.0;
        case 1u: return box_distance(point, vec2(1.0));
        case 2u: return triangle_distance(vec2(point.x, -point.y));
        case 3u: return (abs(point.x) + abs(point.y) - 1.0) * 0.70710678;
        case 4u: return plus_distance(vec2(point.x + point.y, point.y - point.x) * 0.70710678);
        default: return plus_distance(point);
    }
}

void main() {
    if (v_half_size <= 0.0) {
        discard;
    }

    float distance_pixels = shape_distance(v_local) * v_half_size;
    float outer_coverage = clamp(0.5 - distance_pixels, 0.0, 1.0);
    float fill_coverage = clamp(0.5 - distance_pixels - border_width, 0.0, 1.0);
    float border_coverage = outer_coverage - fill_coverage;
    float alpha = v_color.a * fill_coverage + border_color.a * border_coverage;
    vec3 rgb = alpha > 0.0
        ? (v_color.rgb * v_color.a * fill_coverage + border_color.rgb * border_color.a * border_coverage) / alpha
        : vec3(0.0);
    fragment = vec4(rgb, alpha);
}
