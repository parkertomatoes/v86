const VOODOO1_TRIANGLE_PARAM_SIZE = 224;
const VOODOO1_TRIANGLE_PARAM_STRIDE = 256;
const VOODOO1_TRIANGLE_BATCH_SIZE = 1024;

/**
 * WebGPU resources owned by a Voodoo Graphics device.
 *
 * This module deliberately has no DOM access. The browser adapter creates the
 * canvas and passes it in during asynchronous emulator startup.
 *
 * @constructor
 * @param {!Object} adapter
 * @param {!Object} device
 * @param {!Object} context
 * @param {string} canvas_format
 * @param {!Object} fbi_buffer
 * @param {!Object} tmu_buffer
 * @param {!Object} smoke_pipeline
 * @param {!Object} triangle_pipeline
 * @param {!Object} triangle_params
 * @param {!Object} triangle_bind_group
 * @param {!Object} texture_palette
 * @param {!Object} readback_buffer
 * @param {!Object} scanout_pipeline
 * @param {!Object} scanout_params
 * @param {!Object} scanout_bind_group
 * @param {!Object} bus
 */
export function Voodoo1WebGPU(adapter, device, context, canvas_format,
    fbi_buffer, tmu_buffer, smoke_pipeline, triangle_pipeline,
    triangle_params, triangle_bind_group, texture_palette,
    readback_buffer, scanout_pipeline,
    scanout_params, scanout_bind_group, bus)
{
    this.adapter = adapter;
    this.device = device;
    this.context = context;
    this.canvas_format = canvas_format;
    this.fbi_buffer = fbi_buffer;
    this.tmu_buffer = tmu_buffer;
    this.smoke_pipeline = smoke_pipeline;
    this.triangle_pipeline = triangle_pipeline;
    this.triangle_params = triangle_params;
    this.triangle_bind_group = triangle_bind_group;
    this.texture_palette = texture_palette;
    this.readback_buffer = readback_buffer;
    this.scanout_pipeline = scanout_pipeline;
    this.scanout_params = scanout_params;
    this.scanout_bind_group = scanout_bind_group;
    this.bus = bus;
    this.destroyed = false;
    this.readback_pending = null;
    /** @type {?Object} */
    this.triangle_batch_encoder = null;
    /** @type {?Object} */
    this.triangle_batch_pass = null;
    this.triangle_batch_count = 0;
    this.triangle_staging = new Uint8Array(
        VOODOO1_TRIANGLE_PARAM_STRIDE * VOODOO1_TRIANGLE_BATCH_SIZE);
    this.triangle_words = new Uint32Array(56);
    this.triangle_signed_words = new Int32Array(this.triangle_words.buffer);
    this.triangle_float_words = new Float32Array(this.triangle_words.buffer);
    this.triangle_bytes = new Uint8Array(this.triangle_words.buffer);

    device["lost"].then(info =>
    {
        if(!this.destroyed)
        {
            this.bus.send("voodoo1-device-lost", {
                reason: String(info["reason"] || "unknown"),
                message: String(info["message"] || "WebGPU device lost"),
            });
        }
    });
}

/**
 * @param {!HTMLCanvasElement} canvas
 * @param {!Object} bus
 * @return {!Promise<!Voodoo1WebGPU>}
 */
Voodoo1WebGPU.create = async function(canvas, bus)
{
    const navigator_object = globalThis["navigator"];
    const gpu = navigator_object && navigator_object["gpu"];

    if(!gpu)
    {
        throw new Error("Voodoo Graphics requires WebGPU, but navigator.gpu is unavailable");
    }

    const adapter = await gpu["requestAdapter"]({
        "powerPreference": "high-performance",
        "forceFallbackAdapter": false,
    });

    if(!adapter)
    {
        throw new Error("Voodoo Graphics requires a non-fallback WebGPU adapter");
    }
    const adapter_info = adapter["info"];
    const is_fallback = adapter_info && adapter_info["isFallbackAdapter"] !== undefined ?
        adapter_info["isFallbackAdapter"] : adapter["isFallbackAdapter"];
    if(is_fallback !== false)
    {
        throw new Error("Voodoo Graphics could not verify a non-fallback WebGPU adapter");
    }

    const memory_size = 2 * 1024 * 1024;
    const limits = adapter["limits"];
    if(limits["maxBufferSize"] < memory_size ||
        limits["maxStorageBufferBindingSize"] < memory_size)
    {
        throw new Error("The WebGPU adapter cannot expose the required 2 MiB Voodoo memory buffers");
    }

    const device = await adapter["requestDevice"]({
        "requiredLimits": {
            "maxBufferSize": memory_size,
            "maxStorageBufferBindingSize": memory_size,
        },
    });

    const context = canvas.getContext("webgpu");
    if(!context)
    {
        device["destroy"]();
        throw new Error("Voodoo Graphics could not create a WebGPU canvas context");
    }

    const canvas_format = gpu["getPreferredCanvasFormat"]();
    context["configure"]({
        "device": device,
        "format": canvas_format,
        "alphaMode": "opaque",
    });

    const buffer_usage = globalThis["GPUBufferUsage"];
    if(!buffer_usage)
    {
        context["unconfigure"]();
        device["destroy"]();
        throw new Error("Voodoo Graphics found an incomplete WebGPU implementation");
    }

    let fbi_buffer;
    let tmu_buffer;
    let triangle_params;
    let texture_palette;
    let readback_buffer;
    let scanout_params;
    try
    {
        const usage = buffer_usage["STORAGE"] | buffer_usage["COPY_SRC"] | buffer_usage["COPY_DST"];
        fbi_buffer = device["createBuffer"]({
            "label": "Voodoo Graphics FBI RAM",
            "size": memory_size,
            "usage": usage,
        });
        tmu_buffer = device["createBuffer"]({
            "label": "Voodoo Graphics TMU RAM",
            "size": memory_size,
            "usage": usage,
        });

        const shader = device["createShaderModule"]({
            "label": "Voodoo Graphics startup smoke shader",
            "code": "@compute @workgroup_size(1) fn main() {}",
        });
        const smoke_pipeline = await device["createComputePipelineAsync"]({
            "label": "Voodoo Graphics startup smoke pipeline",
            "layout": "auto",
            "compute": { "module": shader, "entryPoint": "main" },
        });

        triangle_params = device["createBuffer"]({
            "label": "Voodoo Graphics triangle parameters",
            "size": VOODOO1_TRIANGLE_PARAM_STRIDE * VOODOO1_TRIANGLE_BATCH_SIZE,
            "usage": buffer_usage["UNIFORM"] | buffer_usage["COPY_DST"],
        });
        texture_palette = device["createBuffer"]({
            "label": "Voodoo Graphics texture lookup tables",
            "size": 3 * 256 * 4,
            "usage": buffer_usage["STORAGE"] | buffer_usage["COPY_DST"],
        });
        readback_buffer = device["createBuffer"]({
            "label": "Voodoo Graphics FBI readback",
            "size": memory_size,
            "usage": buffer_usage["MAP_READ"] | buffer_usage["COPY_DST"],
        });
        const triangle_shader = device["createShaderModule"]({
            "label": "Voodoo Graphics fixed triangle shader",
            "code": `
struct TriangleParams {
    ax: i32,
    ay: i32,
    bx: i32,
    by: i32,
    cx: i32,
    cy: i32,
    width: u32,
    height: u32,
    row_pixels: u32,
    base: u32,
    color: u32,
    fbz_mode: u32,
    padding0: u32,
    padding1: u32,
    fbz_color_path: u32,
    texture_mode: u32,
    texture_base: u32,
    texture_width: u32,
    texture_height: u32,
    texture_row_bytes: u32,
    start_s: f32,
    start_t: f32,
    dsdx: f32,
    dtdx: f32,
    dsdy: f32,
    dtdy: f32,
    min_x: u32,
    min_y: u32,
    color0: u32,
    start_r: f32,
    start_g: f32,
    start_b: f32,
    start_a: f32,
    drdx: f32,
    dgdx: f32,
    dbdx: f32,
    dadx: f32,
    drdy: f32,
    dgdy: f32,
    dbdy: f32,
    dady: f32,
    start_w: f32,
    dwdx: f32,
    dwdy: f32,
    alpha_mode: u32,
    chroma_key: u32,
    za_color: u32,
    auxiliary_base: u32,
    start_z: f32,
    dzdx: f32,
    dzdy: f32,
    command: u32,
    padding5: u32,
    padding6: u32,
    padding7: u32,
    padding8: u32,
}

@group(0) @binding(0) var<storage, read_write> fbi: array<u32>;
@group(0) @binding(1) var<uniform> params: TriangleParams;
@group(0) @binding(2) var<storage, read> tmu: array<u32>;
@group(0) @binding(3) var<storage, read> palette: array<u32>;

const DITHER = array<u32, 16>(
    0u, 8u, 2u, 10u,
    12u, 4u, 14u, 6u,
    3u, 11u, 1u, 9u,
    15u, 7u, 13u, 5u);

fn edge(ax: i32, ay: i32, bx: i32, by: i32, px: i32, py: i32) -> i32 {
    return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
}

fn covered(x: u32, y: u32) -> bool {
    let px = i32(x * 16u + 8u);
    let py = i32(y * 16u + 8u);
    let area = edge(params.ax, params.ay, params.bx, params.by,
        params.cx, params.cy);
    if(area == 0) {
        return false;
    }
    let ab = edge(params.ax, params.ay, params.bx, params.by, px, py);
    let bc = edge(params.bx, params.by, params.cx, params.cy, px, py);
    let ca = edge(params.cx, params.cy, params.ax, params.ay, px, py);
    return select(ab <= 0 && bc <= 0 && ca <= 0,
        ab >= 0 && bc >= 0 && ca >= 0, area > 0);
}

fn quantize(value: u32, levels: u32, dither: u32) -> u32 {
    let scaled = value * levels;
    let base = scaled / 255u;
    let remainder = scaled - base * 255u;
    let increment = select(0u, 1u,
        remainder * 16u > dither * 255u + 127u);
    return min(base + increment, levels);
}

fn unpack_color(color: u32) -> vec4f {
    return vec4f(f32((color >> 16u) & 255u),
        f32((color >> 8u) & 255u), f32(color & 255u),
        f32((color >> 24u) & 255u));
}

fn texture_texel(input_s: i32, input_t: i32) -> vec4f {
    var s = input_s;
    var t = input_t;
    if((params.texture_mode & 0x40u) != 0u) {
        s = clamp(s, 0, i32(params.texture_width) - 1);
    }
    else {
        s = s & (i32(params.texture_width) - 1);
    }
    if((params.texture_mode & 0x80u) != 0u) {
        t = clamp(t, 0, i32(params.texture_height) - 1);
    }
    else {
        t = t & (i32(params.texture_height) - 1);
    }
    let format = (params.texture_mode >> 8u) & 15u;
    let texel_bytes = select(1u, 2u, format >= 8u);
    let address = (params.texture_base + u32(t) * params.texture_row_bytes +
        u32(s) * texel_bytes) & 0x1fffffu;
    let pair = tmu[address >> 2u];
    var texel = pair >> ((address & 3u) * 8u);
    if(texel_bytes == 2u) {
        texel = texel & 0xffffu;
    }
    else {
        texel = texel & 0xffu;
    }

    if(format == 10u) {
        let red = (texel >> 11u) & 31u;
        let green = (texel >> 5u) & 63u;
        let blue = texel & 31u;
        let red8 = (red << 3u) | (red >> 2u);
        let green8 = (green << 2u) | (green >> 4u);
        let blue8 = (blue << 3u) | (blue >> 2u);
        return vec4f(f32(red8), f32(green8), f32(blue8), 255.0);
    }
    if(format == 1u || format == 9u) {
        let table = (params.texture_mode >> 5u) & 1u;
        var color = unpack_color(palette[256u + table * 256u +
            (texel & 255u)] | 0xff000000u);
        if(format == 9u) { color.a = f32(texel >> 8u); }
        return color;
    }
    if(format == 3u) {
        let intensity = texel & 0xffu;
        return vec4f(vec3f(f32(intensity)), 255.0);
    }
    if(format == 5u) {
        return unpack_color(palette[texel & 0xffu] | 0xff000000u);
    }
    if(format == 0u) {
        let red = (texel >> 5u) & 7u;
        let green = (texel >> 2u) & 7u;
        let blue = texel & 3u;
        let red8 = (red << 5u) | (red << 2u) | (red >> 1u);
        let green8 = (green << 5u) | (green << 2u) | (green >> 1u);
        return vec4f(f32(red8), f32(green8), f32(blue * 85u), 255.0);
    }
    if(format == 2u) {
        let alpha = f32(texel & 255u);
        return vec4f(alpha);
    }
    if(format == 4u) {
        let alpha = f32(((texel >> 4u) & 15u) * 17u);
        let intensity = f32((texel & 15u) * 17u);
        return vec4f(vec3f(intensity), alpha);
    }
    if(format == 8u) {
        let color = texel & 255u;
        let red = ((color >> 5u) & 7u) * 255u / 7u;
        let green = ((color >> 2u) & 7u) * 255u / 7u;
        let blue = (color & 3u) * 85u;
        return vec4f(f32(red), f32(green), f32(blue), f32(texel >> 8u));
    }
    if(format == 11u) {
        let red = ((texel >> 10u) & 31u) * 255u / 31u;
        let green = ((texel >> 5u) & 31u) * 255u / 31u;
        let blue = (texel & 31u) * 255u / 31u;
        let alpha = select(0.0, 255.0, (texel & 0x8000u) != 0u);
        return vec4f(f32(red), f32(green), f32(blue), alpha);
    }
    if(format == 12u) {
        return vec4f(f32((texel >> 8u) & 15u) * 17.0,
            f32((texel >> 4u) & 15u) * 17.0,
            f32(texel & 15u) * 17.0,
            f32((texel >> 12u) & 15u) * 17.0);
    }
    if(format == 13u) {
        let intensity = f32(texel & 255u);
        return vec4f(vec3f(intensity), f32(texel >> 8u));
    }
    if(format == 14u) {
        var color = unpack_color(palette[texel & 255u]);
        color.a = f32(texel >> 8u);
        return color;
    }
    return vec4f(0.0);
}

fn chroma_texel(color: vec4f) -> vec4f {
    let rgb = (u32(color.r + 0.5) << 16u) |
        (u32(color.g + 0.5) << 8u) | u32(color.b + 0.5);
    if((params.fbz_mode & 2u) != 0u &&
        rgb == (params.chroma_key & 0xffffffu)) {
        return vec4f(0.0);
    }
    return color;
}

fn iterator_delta(x: u32, y: u32) -> vec2f {
    return vec2f(f32(x) + 0.5 - f32(params.ax) / 16.0,
        f32(y) + 0.5 - f32(params.ay) / 16.0);
}

fn iterated_color(x: u32, y: u32) -> vec4f {
    let delta = iterator_delta(x, y);
    return clamp(vec4f(
        params.start_r + params.drdx * delta.x + params.drdy * delta.y,
        params.start_g + params.dgdx * delta.x + params.dgdy * delta.y,
        params.start_b + params.dbdx * delta.x + params.dbdy * delta.y,
        params.start_a + params.dadx * delta.x + params.dady * delta.y),
        vec4f(0.0), vec4f(255.0));
}

fn texture_color(x: u32, y: u32) -> vec4f {
    let delta = iterator_delta(x, y);
    var s = params.start_s + params.dsdx * delta.x + params.dsdy * delta.y;
    var t = params.start_t + params.dtdx * delta.x + params.dtdy * delta.y;
    let w = params.start_w + params.dwdx * delta.x + params.dwdy * delta.y;
    if((params.texture_mode & 1u) != 0u && abs(w) > 0.0000001) {
        s = s / w;
        t = t / w;
    }
    if((params.texture_mode & 8u) != 0u && w < 0.0) {
        s = 0.0;
        t = 0.0;
    }
    if((params.texture_mode & 6u) == 0u) {
        return chroma_texel(texture_texel(i32(floor(s)), i32(floor(t))));
    }
    // SST texture coordinates address texel centers at half-integers. Glide's
    // 1:1 setup therefore maps the first pixel center to S,T ~= 0.5. Shift to
    // corner coordinates before selecting the four bilinear samples.
    let bilinear_s = s - 0.5;
    let bilinear_t = t - 0.5;
    let s0 = i32(floor(bilinear_s));
    let t0 = i32(floor(bilinear_t));
    let fraction = vec2f(fract(bilinear_s), fract(bilinear_t));
    let c00 = chroma_texel(texture_texel(s0, t0));
    let c10 = chroma_texel(texture_texel(s0 + 1, t0));
    let c01 = chroma_texel(texture_texel(s0, t0 + 1));
    let c11 = chroma_texel(texture_texel(s0 + 1, t0 + 1));
    let weights = vec4f((1.0 - fraction.x) * (1.0 - fraction.y),
        fraction.x * (1.0 - fraction.y),
        (1.0 - fraction.x) * fraction.y, fraction.x * fraction.y);
    let coverage = dot(vec4f(c00.a, c10.a, c01.a, c11.a) / 255.0, weights);
    var rgb = (c00.rgb * (c00.a / 255.0) * weights.x +
        c10.rgb * (c10.a / 255.0) * weights.y +
        c01.rgb * (c01.a / 255.0) * weights.z +
        c11.rgb * (c11.a / 255.0) * weights.w);
    if(coverage > 0.0001) {
        rgb = rgb / coverage;
    }
    let format = (params.texture_mode >> 8u) & 15u;
    var alpha = coverage * 255.0;
    // Chroma key is a pixel-invalidation test, not an alpha source. Opaque
    // texture formats must therefore retain opaque alpha at a filtered edge;
    // using key coverage as alpha causes dark fringes when blending is on.
    if(format == 0u || format == 1u || format == 3u || format == 5u ||
        format == 10u) {
        alpha = select(0.0, 255.0, coverage > 0.0001);
    }
    return vec4f(rgb, alpha);
}

fn texture_combine(local: vec4f) -> vec4f {
    var other = vec4f(0.0);
    if((params.texture_mode & 0x1000u) != 0u) {
        other = vec4f(0.0);
    }
    let selector = (params.texture_mode >> 14u) & 7u;
    var factor = vec3f(0.0);
    if(selector == 1u) { factor = local.rgb / 255.0; }
    else if(selector == 2u) { factor = vec3f(other.a / 255.0); }
    else if(selector == 3u) { factor = vec3f(local.a / 255.0); }
    if((params.texture_mode & 0x20000u) == 0u) {
        factor = vec3f(1.0) - factor;
    }
    var color = (other.rgb - select(vec3f(0.0), local.rgb,
        (params.texture_mode & 0x2000u) != 0u)) * factor;
    if((params.texture_mode & 0x40000u) != 0u) { color += local.rgb; }
    if((params.texture_mode & 0x80000u) != 0u) { color += vec3f(local.a); }
    color = clamp(color, vec3f(0.0), vec3f(255.0));
    if((params.texture_mode & 0x100000u) != 0u) {
        color = vec3f(255.0) - color;
    }
    return vec4f(color, local.a);
}

fn color_combine(iterated: vec4f, texture: vec4f) -> vec4f {
    let selection = params.fbz_color_path & 3u;
    var other = iterated;
    if(selection == 1u) { other = texture; }
    else if(selection == 2u) { other = unpack_color(params.color); }
    if((params.fbz_color_path & 0x100u) != 0u) { other = vec4f(0.0); }

    var local = iterated;
    var use_color0 = (params.fbz_color_path & 0x10u) != 0u;
    if((params.fbz_color_path & 0x80u) != 0u) {
        use_color0 = (u32(texture.a) & 0x80u) != 0u;
    }
    if(use_color0) { local = unpack_color(params.color0); }

    let selector = (params.fbz_color_path >> 10u) & 7u;
    var factor = vec3f(0.0);
    if(selector == 1u) { factor = local.rgb / 255.0; }
    else if(selector == 2u) { factor = vec3f(other.a / 255.0); }
    else if(selector == 3u) { factor = vec3f(local.a / 255.0); }
    else if(selector == 4u) { factor = vec3f(texture.a / 255.0); }
    if((params.fbz_color_path & 0x2000u) == 0u) {
        factor = vec3f(1.0) - factor;
    }
    var color = (other.rgb - select(vec3f(0.0), local.rgb,
        (params.fbz_color_path & 0x200u) != 0u)) * factor;
    if((params.fbz_color_path & 0x4000u) != 0u) { color += local.rgb; }
    if((params.fbz_color_path & 0x8000u) != 0u) { color += vec3f(local.a); }
    color = clamp(color, vec3f(0.0), vec3f(255.0));
    if((params.fbz_color_path & 0x10000u) != 0u) {
        color = vec3f(255.0) - color;
    }
    let alpha_selection = (params.fbz_color_path >> 2u) & 3u;
    var alpha_other = iterated.a;
    if(alpha_selection == 1u) { alpha_other = texture.a; }
    else if(alpha_selection == 2u) { alpha_other = f32(params.color >> 24u); }
    if((params.fbz_color_path & 0x20000u) != 0u) { alpha_other = 0.0; }
    let alpha_local_selection = (params.fbz_color_path >> 5u) & 3u;
    var alpha_local = iterated.a;
    if(alpha_local_selection == 1u) { alpha_local = f32(params.color0 >> 24u); }
    let alpha_factor_selection = (params.fbz_color_path >> 19u) & 7u;
    var alpha_factor = 0.0;
    if(alpha_factor_selection == 1u || alpha_factor_selection == 3u) {
        alpha_factor = alpha_local / 255.0;
    }
    else if(alpha_factor_selection == 2u) { alpha_factor = alpha_other / 255.0; }
    else if(alpha_factor_selection == 4u) { alpha_factor = texture.a / 255.0; }
    if((params.fbz_color_path & 0x400000u) == 0u) {
        alpha_factor = 1.0 - alpha_factor;
    }
    var alpha = (alpha_other - select(0.0, alpha_local,
        (params.fbz_color_path & 0x40000u) != 0u)) * alpha_factor;
    if((params.fbz_color_path & 0x800000u) != 0u) { alpha += alpha_local; }
    if((params.fbz_color_path & 0x1000000u) != 0u) { alpha += alpha_local; }
    alpha = clamp(alpha, 0.0, 255.0);
    if((params.fbz_color_path & 0x2000000u) != 0u) { alpha = 255.0 - alpha; }
    return vec4f(color, alpha);
}

fn pack_rgb565(source: vec3f, x: u32, y: u32) -> u32 {
    let red = u32(clamp(source.r + 0.5, 0.0, 255.0));
    let green = u32(clamp(source.g + 0.5, 0.0, 255.0));
    let blue = u32(clamp(source.b + 0.5, 0.0, 255.0));
    if((params.fbz_mode & 0x100u) != 0u) {
        let dither = DITHER[(y & 3u) * 4u + (x & 3u)];
        return (quantize(red, 31u, dither) << 11u) |
            (quantize(green, 63u, dither) << 5u) |
            quantize(blue, 31u, dither);
    }
    return ((red >> 3u) << 11u) | ((green >> 2u) << 5u) | (blue >> 3u);
}

fn unpack_rgb565(pixel: u32) -> vec3f {
    return vec3f(f32((pixel >> 11u) & 31u) * (255.0 / 31.0),
        f32((pixel >> 5u) & 63u) * (255.0 / 63.0),
        f32(pixel & 31u) * (255.0 / 31.0));
}

fn comparison_pass(source: u32, destination: u32, function: u32) -> bool {
    if(function == 0u) { return false; }
    if(function == 1u) { return source < destination; }
    if(function == 2u) { return source == destination; }
    if(function == 3u) { return source <= destination; }
    if(function == 4u) { return source > destination; }
    if(function == 5u) { return source != destination; }
    if(function == 6u) { return source >= destination; }
    return true;
}

fn iterated_depth(x: u32, y: u32) -> u32 {
    let delta = iterator_delta(x, y);
    var depth: f32;
    if((params.fbz_mode & 8u) != 0u) {
        let reciprocal_w = params.start_w + params.dwdx * delta.x +
            params.dwdy * delta.y;
        if(reciprocal_w <= 0.0) {
            depth = 65535.0;
        }
        else {
            // SST-1 normalizes 1/W into an inverted 4.12 floating depth.
            // Increasing 1/W (closer geometry) must therefore decrease the
            // stored value so the ordinary LESS comparison remains valid.
            let exponent = clamp(floor(-log2(reciprocal_w)), 0.0, 15.0);
            let normalized = reciprocal_w * exp2(exponent + 1.0);
            let mantissa = clamp((2.0 - normalized) * 4096.0, 0.0, 4095.0);
            depth = exponent * 4096.0 + mantissa;
        }
    }
    else {
        depth = params.start_z + params.dzdx * delta.x + params.dzdy * delta.y;
    }
    if((params.fbz_mode & 0x10000u) != 0u) {
        depth += f32(i32(params.za_color << 16u) >> 16);
    }
    return u32(clamp(depth, 0.0, 65535.0));
}

fn blend_factor(selector: u32, source: vec4f, destination: vec4f,
    source_factor: bool) -> vec3f {
    if(selector == 0u) { return vec3f(0.0); }
    if(selector == 1u) { return vec3f(source.a / 255.0); }
    if(selector == 2u) {
        return select(source.rgb, destination.rgb, source_factor) / 255.0;
    }
    if(selector == 3u) { return vec3f(destination.a / 255.0); }
    if(selector == 4u) { return vec3f(1.0); }
    if(selector == 5u) { return vec3f(1.0 - source.a / 255.0); }
    if(selector == 6u) {
        return vec3f(1.0) - select(source.rgb, destination.rgb, source_factor) / 255.0;
    }
    if(selector == 7u) { return vec3f(1.0 - destination.a / 255.0); }
    if(selector == 15u && source_factor) {
        return vec3f(min(source.a, 255.0 - destination.a) / 255.0);
    }
    return vec3f(0.0);
}

struct PixelResult {
    color: u32,
    depth: u32,
    write_color: u32,
    write_depth: u32,
}

fn shade_pixel(x: u32, y: u32, old_color: u32, old_depth: u32) -> PixelResult {
    var result = PixelResult(old_color, old_depth, 0u, 0u);
    if(params.command == 1u) {
        if((params.fbz_mode & 0x200u) != 0u) {
            result.color = pack_rgb565(unpack_color(params.color).rgb, x, y);
            result.write_color = 1u;
        }
        if((params.fbz_mode & 0x400u) != 0u) {
            result.depth = params.za_color & 0xffffu;
            result.write_depth = 1u;
        }
        return result;
    }
    let iterated = iterated_color(x, y);
    let texture_lookup = texture_color(x, y);
    let texture = texture_combine(texture_lookup);
    var chroma_source = iterated;
    let rgb_selection = params.fbz_color_path & 3u;
    if(rgb_selection == 1u) { chroma_source = texture; }
    else if(rgb_selection == 2u) { chroma_source = unpack_color(params.color); }
    let chroma = (u32(chroma_source.r + 0.5) << 16u) |
        (u32(chroma_source.g + 0.5) << 8u) | u32(chroma_source.b + 0.5);
    if((params.fbz_mode & 2u) != 0u) {
        if((params.fbz_color_path & 0x8000000u) != 0u &&
            texture_lookup.a < 0.5) {
            return result;
        }
        if(chroma == (params.chroma_key & 0xffffffu)) {
            return result;
        }
    }

    var source = color_combine(iterated, texture);
    if((params.fbz_mode & 0x2000u) != 0u && (u32(source.a) & 1u) == 0u) {
        return result;
    }
    if((params.alpha_mode & 1u) != 0u && !comparison_pass(u32(source.a + 0.5),
        params.alpha_mode >> 24u, (params.alpha_mode >> 1u) & 7u)) {
        return result;
    }

    let depth = iterated_depth(x, y);
    let comparison_depth = select(depth, params.za_color & 0xffffu,
        (params.fbz_mode & 0x100000u) != 0u);
    if((params.fbz_mode & 0x10u) != 0u && !comparison_pass(comparison_depth,
        old_depth, (params.fbz_mode >> 5u) & 7u)) {
        return result;
    }

    if((params.alpha_mode & 0x10u) != 0u) {
        let destination = vec4f(unpack_rgb565(old_color),
            select(255.0, f32(old_depth & 255u),
                (params.fbz_mode & 0x40000u) != 0u));
        let source_factor = blend_factor((params.alpha_mode >> 8u) & 15u,
            source, destination, true);
        let destination_factor = blend_factor((params.alpha_mode >> 12u) & 15u,
            source, destination, false);
        source = vec4f(clamp(source.rgb * source_factor +
            destination.rgb * destination_factor, vec3f(0.0), vec3f(255.0)),
            source.a);
    }

    if((params.fbz_mode & 0x200u) != 0u) {
        result.color = pack_rgb565(source.rgb, x, y);
        result.write_color = 1u;
    }
    if((params.fbz_mode & 0x400u) != 0u) {
        result.depth = select(depth, u32(source.a + 0.5),
            (params.fbz_mode & 0x40000u) != 0u);
        result.write_depth = 1u;
    }
    return result;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let x = params.min_x + id.x * 2u;
    let y = params.min_y + id.y;
    if(x >= params.width || y >= params.height) {
        return;
    }

    let address_y = select(y, params.height - 1u - y,
        (params.fbz_mode & 0x20000u) != 0u);
    let byte_address = (params.base +
        (address_y * params.row_pixels + x) * 2u) & 0x1fffffu;
    let word_index = byte_address >> 2u;
    let auxiliary_address = (params.auxiliary_base +
        (address_y * params.row_pixels + x) * 2u) & 0x1fffffu;
    let auxiliary_index = auxiliary_address >> 2u;
    var pixels = fbi[word_index];
    var depths = fbi[auxiliary_index];
    if(covered(x, y)) {
        let result = shade_pixel(x, y, pixels & 0xffffu, depths & 0xffffu);
        if(result.write_color != 0u) {
            pixels = (pixels & 0xffff0000u) | result.color;
        }
        if(result.write_depth != 0u) {
            depths = (depths & 0xffff0000u) | (result.depth & 0xffffu);
        }
    }
    if(x + 1u < params.width && covered(x + 1u, y)) {
        let result = shade_pixel(x + 1u, y, pixels >> 16u, depths >> 16u);
        if(result.write_color != 0u) {
            pixels = (pixels & 0xffffu) | (result.color << 16u);
        }
        if(result.write_depth != 0u) {
            depths = (depths & 0xffffu) | (result.depth << 16u);
        }
    }
    fbi[word_index] = pixels;
    fbi[auxiliary_index] = depths;
}`,
        });
        const shader_stage = globalThis["GPUShaderStage"];
        if(!shader_stage)
        {
            throw new Error("Voodoo Graphics found incomplete WebGPU shader support");
        }
        const triangle_bind_group_layout = device["createBindGroupLayout"]({
            "label": "Voodoo Graphics fixed triangle bind group layout",
            "entries": [
                {
                    "binding": 0,
                    "visibility": shader_stage["COMPUTE"],
                    "buffer": { "type": "storage" },
                },
                {
                    "binding": 1,
                    "visibility": shader_stage["COMPUTE"],
                    "buffer": {
                        "type": "uniform",
                        "hasDynamicOffset": true,
                        "minBindingSize": VOODOO1_TRIANGLE_PARAM_SIZE,
                    },
                },
                {
                    "binding": 2,
                    "visibility": shader_stage["COMPUTE"],
                    "buffer": { "type": "read-only-storage" },
                },
                {
                    "binding": 3,
                    "visibility": shader_stage["COMPUTE"],
                    "buffer": { "type": "read-only-storage" },
                },
            ],
        });
        const triangle_pipeline_layout = device["createPipelineLayout"]({
            "label": "Voodoo Graphics fixed triangle pipeline layout",
            "bindGroupLayouts": [triangle_bind_group_layout],
        });
        const triangle_pipeline = await device["createComputePipelineAsync"]({
            "label": "Voodoo Graphics fixed triangle pipeline",
            "layout": triangle_pipeline_layout,
            "compute": { "module": triangle_shader, "entryPoint": "main" },
        });
        const triangle_bind_group = device["createBindGroup"]({
            "label": "Voodoo Graphics fixed triangle bindings",
            "layout": triangle_bind_group_layout,
            "entries": [
                { "binding": 0, "resource": { "buffer": fbi_buffer } },
                {
                    "binding": 1,
                    "resource": {
                        "buffer": triangle_params,
                        "size": VOODOO1_TRIANGLE_PARAM_SIZE,
                    },
                },
                { "binding": 2, "resource": { "buffer": tmu_buffer } },
                { "binding": 3, "resource": { "buffer": texture_palette } },
            ],
        });

        scanout_params = device["createBuffer"]({
            "label": "Voodoo Graphics scanout parameters",
            "size": 16,
            "usage": buffer_usage["UNIFORM"] | buffer_usage["COPY_DST"],
        });
        const scanout_shader = device["createShaderModule"]({
            "label": "Voodoo Graphics RGB565 scanout shader",
            "code": `
struct ScanoutParams {
    width: u32,
    height: u32,
    row_pixels: u32,
    base: u32,
}

@group(0) @binding(0) var<storage, read> fbi: array<u32>;
@group(0) @binding(1) var<uniform> params: ScanoutParams;

@vertex
fn vertex_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
    let x = f32((index << 1u) & 2u);
    let y = f32(index & 2u);
    return vec4f(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
}

@fragment
fn fragment_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
    let x = min(u32(position.x), params.width - 1u);
    let y = min(u32(position.y), params.height - 1u);
    let byte_address = (params.base + (y * params.row_pixels + x) * 2u) & 0x1fffffu;
    let pair = fbi[byte_address >> 2u];
    let pixel = select(pair & 0xffffu, pair >> 16u, (byte_address & 2u) != 0u);
    let red = f32((pixel >> 11u) & 31u) / 31.0;
    let green = f32((pixel >> 5u) & 63u) / 63.0;
    let blue = f32(pixel & 31u) / 31.0;
    return vec4f(red, green, blue, 1.0);
}`,
        });
        const scanout_pipeline = await device["createRenderPipelineAsync"]({
            "label": "Voodoo Graphics RGB565 scanout pipeline",
            "layout": "auto",
            "vertex": { "module": scanout_shader, "entryPoint": "vertex_main" },
            "fragment": {
                "module": scanout_shader,
                "entryPoint": "fragment_main",
                "targets": [{ "format": canvas_format }],
            },
            "primitive": { "topology": "triangle-list" },
        });
        const scanout_bind_group = device["createBindGroup"]({
            "label": "Voodoo Graphics RGB565 scanout bindings",
            "layout": scanout_pipeline["getBindGroupLayout"](0),
            "entries": [
                { "binding": 0, "resource": { "buffer": fbi_buffer } },
                { "binding": 1, "resource": { "buffer": scanout_params } },
            ],
        });

        bus.send("voodoo1-webgpu-ready", {
            vendor: String(adapter_info && adapter_info["vendor"] || ""),
            architecture: String(adapter_info && adapter_info["architecture"] || ""),
            device: String(adapter_info && adapter_info["device"] || ""),
            description: String(adapter_info && adapter_info["description"] || ""),
            canvas_format,
        });

        return new Voodoo1WebGPU(adapter, device, context, canvas_format,
            fbi_buffer, tmu_buffer, smoke_pipeline, triangle_pipeline,
            triangle_params, triangle_bind_group, texture_palette,
            readback_buffer, scanout_pipeline,
            scanout_params, scanout_bind_group, bus);
    }
    catch(error)
    {
        fbi_buffer && fbi_buffer["destroy"]();
        tmu_buffer && tmu_buffer["destroy"]();
        triangle_params && triangle_params["destroy"]();
        texture_palette && texture_palette["destroy"]();
        readback_buffer && readback_buffer["destroy"]();
        scanout_params && scanout_params["destroy"]();
        context["unconfigure"]();
        device["destroy"]();
        throw error;
    }
};

Voodoo1WebGPU.prototype.destroy = function()
{
    if(this.destroyed)
    {
        return;
    }

    this.destroyed = true;
    this.fbi_buffer["destroy"]();
    this.tmu_buffer["destroy"]();
    this.triangle_params["destroy"]();
    this.texture_palette["destroy"]();
    this.readback_buffer["destroy"]();
    this.scanout_params["destroy"]();
    this.context["unconfigure"]();
    this.device["destroy"]();
};

/**
 * @param {!Uint8Array} fbi_memory
 * @param {!Uint8Array} tmu_memory
 */
Voodoo1WebGPU.prototype.upload_memory = function(fbi_memory, tmu_memory)
{
    this.flush_commands();
    this.device["queue"]["writeBuffer"](this.fbi_buffer, 0, fbi_memory);
    this.device["queue"]["writeBuffer"](this.tmu_buffer, 0, tmu_memory);
};

/**
 * @param {!Uint8Array} memory
 * @param {number} start
 * @param {number} end
 */
Voodoo1WebGPU.prototype.upload_fbi_range = function(memory, start, end)
{
    this.flush_commands();
    start &= ~3;
    end = end + 3 & ~3;
    this.device["queue"]["writeBuffer"](
        this.fbi_buffer, start, memory.subarray(start, end));
};

/**
 * @param {!Uint8Array} memory
 * @param {number} start
 * @param {number} end
 */
Voodoo1WebGPU.prototype.upload_tmu_range = function(memory, start, end)
{
    this.flush_commands();
    start &= ~3;
    end = end + 3 & ~3;
    this.device["queue"]["writeBuffer"](
        this.tmu_buffer, start, memory.subarray(start, end));
};

/** @param {!Uint32Array} palette */
Voodoo1WebGPU.prototype.upload_palette = function(palette)
{
    this.flush_commands();
    this.device["queue"]["writeBuffer"](this.texture_palette, 0, palette);
};

/** @param {!Uint32Array} ncc */
Voodoo1WebGPU.prototype.upload_ncc = function(ncc)
{
    this.flush_commands();
    this.device["queue"]["writeBuffer"](this.texture_palette, 256 * 4, ncc);
};

Voodoo1WebGPU.prototype.flush_commands = function()
{
    if(!this.triangle_batch_pass)
    {
        return;
    }

    const encoder = /** @type {!Object} */ (this.triangle_batch_encoder);
    this.triangle_batch_pass["end"]();
    this.device["queue"]["writeBuffer"](this.triangle_params, 0,
        this.triangle_staging.subarray(0,
            this.triangle_batch_count * VOODOO1_TRIANGLE_PARAM_STRIDE));
    this.device["queue"]["submit"]([
        encoder["finish"](),
    ]);
    this.triangle_batch_encoder = null;
    this.triangle_batch_pass = null;
    this.triangle_batch_count = 0;
};

/** @return {!Promise<undefined>} */
Voodoo1WebGPU.prototype.wait_for_idle = function()
{
    this.flush_commands();
    return this.device["queue"]["onSubmittedWorkDone"]();
};

/**
 * Submit one fixed-coordinate triangle to the FBI compute rasterizer.
 * Coordinates are signed 12.4 values, matching the SST-1 register interface.
 *
 * @param {{ax: number, ay: number, bx: number, by: number,
 *     cx: number, cy: number, width: number, height: number,
 *     row_pixels: number, base: number, color: number, color0: number,
 *     fbz_mode: number,
 *     fbz_color_path: number, texture_mode: number, texture_base: number,
 *     texture_width: number, texture_height: number, texture_row_bytes: number,
 *     start_s: number, start_t: number, dsdx: number, dtdx: number,
 *     dsdy: number, dtdy: number, start_w: number, dwdx: number,
 *     dwdy: number, start_r: number, start_g: number, start_b: number,
 *     start_a: number, drdx: number, dgdx: number, dbdx: number,
 *     dadx: number, drdy: number, dgdy: number, dbdy: number,
 *     dady: number, start_z: number, dzdx: number, dzdy: number,
 *     alpha_mode: number, chroma_key: number, za_color: number,
 *     auxiliary_base: number, fastfill: boolean}} state
 * @return {boolean}
 */
Voodoo1WebGPU.prototype.render_triangle = function(state)
{
    if(this.destroyed || state.width < 1 || state.width > 1024 ||
        state.height < 1 || state.height > 1024 ||
        state.row_pixels < state.width || state.row_pixels > 2048)
    {
        return false;
    }

    const words = this.triangle_words;
    const signed_words = this.triangle_signed_words;
    const float_words = this.triangle_float_words;
    signed_words[0] = state.ax;
    signed_words[1] = state.ay;
    signed_words[2] = state.bx;
    signed_words[3] = state.by;
    signed_words[4] = state.cx;
    signed_words[5] = state.cy;
    words[6] = state.width;
    words[7] = state.height;
    words[8] = state.row_pixels;
    words[9] = state.base & 0x1FFFFF;
    words[10] = state.color;
    words[11] = state.fbz_mode;
    words[14] = state.fbz_color_path;
    words[15] = state.texture_mode;
    words[16] = state.texture_base;
    words[17] = state.texture_width;
    words[18] = state.texture_height;
    words[19] = state.texture_row_bytes;
    float_words[20] = state.start_s;
    float_words[21] = state.start_t;
    float_words[22] = state.dsdx;
    float_words[23] = state.dtdx;
    float_words[24] = state.dsdy;
    float_words[25] = state.dtdy;
    const min_x = Math.max(0, Math.floor(
        Math.min(state.ax, state.bx, state.cx) / 16)) & ~1;
    const max_x = Math.min(state.width, Math.ceil(
        Math.max(state.ax, state.bx, state.cx) / 16));
    const min_y = Math.max(0, Math.floor(
        Math.min(state.ay, state.by, state.cy) / 16));
    const max_y = Math.min(state.height, Math.ceil(
        Math.max(state.ay, state.by, state.cy) / 16));
    if(max_x <= min_x || max_y <= min_y)
    {
        return true;
    }
    words[26] = min_x;
    words[27] = min_y;
    words[28] = state.color0;
    float_words[29] = state.start_r;
    float_words[30] = state.start_g;
    float_words[31] = state.start_b;
    float_words[32] = state.start_a;
    float_words[33] = state.drdx;
    float_words[34] = state.dgdx;
    float_words[35] = state.dbdx;
    float_words[36] = state.dadx;
    float_words[37] = state.drdy;
    float_words[38] = state.dgdy;
    float_words[39] = state.dbdy;
    float_words[40] = state.dady;
    float_words[41] = state.start_w;
    float_words[42] = state.dwdx;
    float_words[43] = state.dwdy;
    words[44] = state.alpha_mode;
    words[45] = state.chroma_key;
    words[46] = state.za_color;
    words[47] = state.auxiliary_base & 0x1FFFFF;
    float_words[48] = state.start_z;
    float_words[49] = state.dzdx;
    float_words[50] = state.dzdy;
    words[51] = state.fastfill ? 1 : 0;
    if(this.triangle_batch_count >= VOODOO1_TRIANGLE_BATCH_SIZE)
    {
        this.flush_commands();
    }
    if(!this.triangle_batch_pass)
    {
        this.triangle_batch_encoder = this.device["createCommandEncoder"]({
            "label": "Voodoo Graphics triangle batch",
        });
        this.triangle_batch_pass =
            this.triangle_batch_encoder["beginComputePass"]();
        this.triangle_batch_pass["setPipeline"](this.triangle_pipeline);
    }

    const parameter_offset =
        this.triangle_batch_count * VOODOO1_TRIANGLE_PARAM_STRIDE;
    this.triangle_staging.set(this.triangle_bytes, parameter_offset);
    this.triangle_batch_pass["setBindGroup"](0, this.triangle_bind_group,
        [parameter_offset]);
    this.triangle_batch_pass["dispatchWorkgroups"](
        Math.ceil((max_x - min_x) / 16),
        Math.ceil((max_y - min_y) / 8));
    this.triangle_batch_count++;
    return true;
};

/**
 * Queue an FBI snapshot after all preceding raster work. NOP/status polling
 * provides the asynchronous barrier before the guest performs LFB reads.
 *
 * @return {!Promise<!Uint8Array>}
 */
Voodoo1WebGPU.prototype.readback_fbi = function()
{
    if(this.readback_pending)
    {
        return this.readback_pending;
    }
    if(this.destroyed)
    {
        return Promise.reject(new Error("Voodoo Graphics WebGPU device is destroyed"));
    }

    this.flush_commands();

    const encoder = this.device["createCommandEncoder"]({
        "label": "Voodoo Graphics FBI readback",
    });
    encoder["copyBufferToBuffer"](this.fbi_buffer, 0,
        this.readback_buffer, 0, 2 * 1024 * 1024);
    this.device["queue"]["submit"]([encoder["finish"]()]);

    const map_mode = globalThis["GPUMapMode"];
    const pending = this.readback_buffer["mapAsync"](map_mode["READ"])
        .then(() =>
        {
            const result = new Uint8Array(
                this.readback_buffer["getMappedRange"]()).slice();
            this.readback_buffer["unmap"]();
            return result;
        });
    this.readback_pending = pending.then(result =>
    {
        this.readback_pending = null;
        return result;
    }, error =>
    {
        this.readback_pending = null;
        throw error;
    });
    return this.readback_pending;
};

/**
 * @param {{width: number, height: number, row_pixels: number, base: number}} state
 */
Voodoo1WebGPU.prototype.present = function(state)
{
    if(this.destroyed || state.width < 1 || state.width > 1024 ||
        state.height < 1 || state.height > 1024 ||
        state.row_pixels < state.width || state.row_pixels > 2048)
    {
        return;
    }

    this.flush_commands();

    this.bus.send("voodoo1-resize", {
        width: state.width,
        height: state.height,
    });
    this.device["queue"]["writeBuffer"](this.scanout_params, 0,
        new Uint32Array([
            state.width,
            state.height,
            state.row_pixels,
            state.base & 0x1FFFFF,
        ]));

    const encoder = this.device["createCommandEncoder"]({
        "label": "Voodoo Graphics scanout",
    });
    const pass = encoder["beginRenderPass"]({
        "colorAttachments": [{
            "view": this.context["getCurrentTexture"]()["createView"](),
            "clearValue": { "r": 0, "g": 0, "b": 0, "a": 1 },
            "loadOp": "clear",
            "storeOp": "store",
        }],
    });
    pass["setPipeline"](this.scanout_pipeline);
    pass["setBindGroup"](0, this.scanout_bind_group);
    pass["draw"](3);
    pass["end"]();
    this.device["queue"]["submit"]([encoder["finish"]()]);
};
