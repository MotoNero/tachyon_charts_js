#version 300 es
// Values colored by a table, from raster.wgsl of the .NET version. texelFetch picks the nearest texel, as textureLoad
// does there. One change: the reduction reports whether it found a value instead of returning NaN, because GLSL
// compilers may assume there is no NaN.

precision highp float;
precision highp int;
precision highp sampler2D;

layout(std140) uniform Params {
    vec2 target_size;
    float is_interpolated;
    // x: 0 nearest, 1 mean, 2 maximum.
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
    // A negative alpha stands for the end of the table.
    vec4 below_color;
    vec4 above_color;
    vec4 turn;
};

uniform sampler2D values;
uniform sampler2D colormap;

in vec2 v_section;

out vec4 fragment;

vec4 table_color(float position) {
    int last = textureSize(colormap, 0).x - 1;
    int index = clamp(int(floor(position * float(last) + 0.5)), 0, last);
    return texelFetch(colormap, ivec2(index, 0), 0);
}

float load_value(ivec2 position, ivec2 size) {
    ivec2 texel = clamp(position, ivec2(0), size - 1);
    texel.y = int((uint(texel.y) + row_shift) % uint(size.y));
    return texelFetch(values, texel, 0).r;
}

// A comparison could be optimized away, because shaders may assume that there is no NaN.
bool is_nan(float value) {
    return (floatBitsToUint(value) & 0x7fffffffu) > 0x7f800000u;
}

// Reads up to this many texels per direction, spread over the pixel.
const int max_samples = 8;

bool reduce_value(vec2 section, ivec2 size, out float result) {
    vec2 footprint = abs(section_size) * vec2(size) / scale;
    ivec2 samples = clamp(ivec2(ceil(footprint)), ivec2(1), ivec2(max_samples));
    vec2 start = section * vec2(size) - footprint * 0.5;
    vec2 spacing = footprint / vec2(samples);
    float sum = 0.0;
    float highest = 0.0;
    int found = 0;
    for (int y = 0; y < max_samples; y++) {
        if (y >= samples.y) {
            break;
        }
        for (int x = 0; x < max_samples; x++) {
            if (x >= samples.x) {
                break;
            }
            vec2 position = start + (vec2(float(x), float(y)) + 0.5) * spacing;
            float value = load_value(ivec2(floor(position)), size);
            if (!is_nan(value)) {
                highest = found == 0 ? value : max(highest, value);
                sum += value;
                found += 1;
            }
        }
    }
    result = reduction.x > 1.5 ? highest : sum / float(max(found, 1));
    return found > 0;
}

vec4 colored(float value) {
    if (value < value_min || (is_log > 0.5 && value <= 0.0)) {
        return below_color.a >= 0.0 ? below_color : table_color(0.0);
    }
    if (value > value_max) {
        return above_color.a >= 0.0 ? above_color : table_color(1.0);
    }
    float position = (value - value_min) / (value_max - value_min);
    if (is_log > 0.5) {
        position = log(value / value_min) / log(value_max / value_min);
    }
    return table_color(position);
}

void main() {
    ivec2 size = textureSize(values, 0);
    if (is_interpolated > 0.5) {
        vec2 position = v_section * vec2(size) - 0.5;
        ivec2 cell = ivec2(floor(position));
        vec2 part = position - floor(position);
        float a = load_value(cell, size);
        float b = load_value(cell + ivec2(1, 0), size);
        float c = load_value(cell + ivec2(0, 1), size);
        float d = load_value(cell + ivec2(1, 1), size);
        if (is_nan(a) || is_nan(b) || is_nan(c) || is_nan(d)) {
            fragment = missing_color;
            return;
        }
        fragment = colored(mix(mix(a, b, part.x), mix(c, d, part.x), part.y));
        return;
    }

    float value;
    if (reduction.x > 0.5) {
        if (!reduce_value(v_section, size, value)) {
            fragment = missing_color;
            return;
        }
    } else {
        value = load_value(ivec2(floor(v_section * vec2(size))), size);
        if (is_nan(value)) {
            fragment = missing_color;
            return;
        }
    }
    fragment = colored(value);
}
