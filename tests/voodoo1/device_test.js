import assert from "node:assert/strict";

import {
    Voodoo1,
    VOODOO1_BAR_BASE,
    VOODOO1_FBI_MEMORY_SIZE,
    VOODOO1_TMU_MEMORY_SIZE,
} from "../../src/voodoo1.js";
import { IO } from "../../src/io.js";
import { PCI } from "../../src/pci.js";
import { MMAP_BLOCK_BITS } from "../../src/const.js";

function create_device()
{
    const uploads = [];
    const presents = [];
    const triangles = [];
    const events = [];
    let wakeups = 0;
    let idle_waits = 0;
    let readbacks = 0;
    const device = Object.create(Voodoo1.prototype);

    device.registers = new Uint32Array(256);
    device.tmu_registers = new Uint32Array(256);
    device.fbi_memory = new Uint8Array(VOODOO1_FBI_MEMORY_SIZE);
    device.tmu_memory = new Uint8Array(VOODOO1_TMU_MEMORY_SIZE);
    device.texture_palette = new Uint32Array(256);
    device.texture_ncc = new Uint32Array(2 * 256);
    device.telemetry = new Uint32Array(12);
    device.dac_palette = new Uint8Array(256 * 3);
    device.dac_pll_parameters = new Uint8Array(16 * 2);
    device.dac_history = [];
    device.mmio_history = new Uint32Array(8192 * 4);
    device.mmio_history_index = 0;
    device.status_reads_since_mmio_trace = 0;
    device.mmio_trace_enabled = false;
    device.front_buffer = 0;
    device.get_time = () => 0;
    device.video_frame_start = 0;
    device.fbi_dirty_min = VOODOO1_FBI_MEMORY_SIZE;
    device.fbi_dirty_max = 0;
    device.tmu_dirty_min = VOODOO1_TMU_MEMORY_SIZE;
    device.tmu_dirty_max = 0;
    device.texture_palette_dirty = true;
    device.texture_ncc_dirty = true;
    device.scanout_dirty = false;
    device.scanout_active = false;
    device.gpu_commands_pending = false;
    device.gpu_readback_pending = false;
    device.gpu_idle_pending = false;
    device.gpu_busy = false;
    device.gpu_wait_halt = false;
    device.gpu_generation = 0;
    device.cpu = {
        in_hlt: new Uint8Array(1),
        stop_idling() { wakeups++; },
    };
    device.webgpu = {
        upload_fbi_range(memory, start, end) { uploads.push(["fbi", start, end]); },
        upload_tmu_range(memory, start, end) { uploads.push(["tmu", start, end]); },
        upload_palette(memory) { uploads.push(["palette", memory.length]); },
        upload_ncc(memory) { uploads.push(["ncc", memory.length]); },
        flush_commands() {},
        render_triangle(state) { triangles.push(state); return true; },
        wait_for_idle() { idle_waits++; return Promise.resolve(); },
        readback_fbi() { readbacks++; return Promise.resolve(device.fbi_memory.slice()); },
        present(state) { presents.push(state); },
    };
    device.bus = { send(name, value) { events.push([name, value]); } };
    device.reset_registers();

    device.registers[0x20C >> 2] = 640 | 480 << 16;
    device.registers[0x214 >> 2] = 0x002011AA;
    device.registers[0x218 >> 2] = 0x8004B040;
    return {
        device, uploads, presents, triangles, events,
        get_wakeups: () => wakeups,
        get_idle_waits: () => idle_waits,
        get_readbacks: () => readbacks,
    };
}

{
    const cpu = {
        memory_size: new Uint32Array([32 * 1024 * 1024]),
        memory_map_read8: [],
        memory_map_read16: [],
        memory_map_read32: [],
        memory_map_write8: [],
        memory_map_write16: [],
        memory_map_write32: [],
        devices: {},
        in_hlt: new Uint8Array(1),
        stop_idling() {},
    };
    cpu.io = new IO(cpu);
    cpu.devices.pci = new PCI(cpu);

    const default_block = VOODOO1_BAR_BASE >>> MMAP_BLOCK_BITS;
    const underlying_read32 = cpu.memory_map_read32[default_block];
    const webgpu = {
        upload_memory() {},
        upload_palette() {},
        upload_ncc() {},
        destroy() {},
    };
    const device = new Voodoo1(cpu, { send() {} }, webgpu);

    const pci_read32 = address =>
    {
        cpu.io.port_write32(0xCF8, 0x80009800 | address);
        return cpu.io.port_read32(0xCFC) >>> 0;
    };
    const pci_write32 = (address, value) =>
    {
        cpu.io.port_write32(0xCF8, 0x80009800 | address);
        cpu.io.port_write32(0xCFC, value);
    };

    assert.equal(pci_read32(0), 0x0001121A);
    assert.equal(pci_read32(0x10), VOODOO1_BAR_BASE);

    const relocated_base = 0xC0000000;
    pci_write32(0x10, relocated_base);
    assert.equal(pci_read32(0x10), relocated_base);
    assert.equal(device.bar_base, relocated_base);
    assert.equal(cpu.memory_map_read32[default_block], underlying_read32);

    pci_write32(0x04, 2);
    const relocated_read32 = cpu.memory_map_read32[relocated_base >>> MMAP_BLOCK_BITS];
    assert.equal(relocated_read32(relocated_base) & 0xFFFFFFBF, 0x0FFFF03F);

    pci_write32(0x10, 0xFFFFFFFF);
    assert.equal(pci_read32(0x10), 0xFF000000);
    assert.equal(device.bar_base, relocated_base);
    assert.equal(cpu.memory_map_read32[relocated_base >>> MMAP_BLOCK_BITS], relocated_read32);

    pci_write32(0x10, relocated_base);
    const state = device.get_state();
    pci_write32(0x10, 0xB0000000);
    device.set_state(state);
    assert.equal(device.bar_base, relocated_base);
    assert.equal(pci_read32(0x10), relocated_base);

    device.reset();
    assert.equal(device.bar_base, VOODOO1_BAR_BASE);
    assert.equal(pci_read32(0x10), VOODOO1_BAR_BASE);
    assert.notEqual(cpu.memory_map_read32[relocated_base >>> MMAP_BLOCK_BITS], relocated_read32);

    device.destroy();
    assert.equal(cpu.memory_map_read32[default_block], underlying_read32);
}

{
    const float = new Float32Array([524599.4375]);
    const bits = new Uint32Array(float.buffer)[0];
    assert.equal(Voodoo1.float_vertex_12_4(bits), 4983);
}

{
    const { device, get_idle_waits, get_wakeups } = create_device();
    device.registers[0x008 >> 2] = 0;
    device.registers[0x00C >> 2] = 0;
    device.registers[0x010 >> 2] = 16;
    device.registers[0x014 >> 2] = 0;
    device.registers[0x018 >> 2] = 0;
    device.registers[0x01C >> 2] = 16;
    device.telemetry[9] = 1;

    device.execute_command("triangle", 0, 0x080);
    device.execute_command("nop", 0);
    assert.equal(get_idle_waits(), 0);
    assert.equal(device.gpu_idle_pending, false);
    assert.equal(device.read_status() >>> 7 & 1, 1);
    assert.equal(get_idle_waits(), 1);
    assert.equal(device.gpu_idle_pending, true);
    assert.equal(device.cpu.in_hlt[0], 1);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(device.gpu_idle_pending, false);
    assert.equal(device.gpu_commands_pending, false);
    assert.equal(device.cpu.in_hlt[0], 0);
    assert.equal(get_wakeups(), 1);
}

{
    const { device, get_idle_waits, get_readbacks } = create_device();
    device.execute_command("triangle", 0, 0x080);
    device.execute_command("nop", 0);
    assert.equal(get_readbacks(), 1);
    assert.equal(get_idle_waits(), 0);
    assert.equal(device.gpu_readback_pending, true);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(device.gpu_readback_pending, false);
    assert.equal(device.gpu_commands_pending, false);
}

{
    const { device } = create_device();
    device.mmio_trace_enabled = true;
    for(let i = 0; i < 8300; i++)
    {
        device.trace_mmio(2, i << 2, i);
    }
    const history = device.get_mmio_history();
    assert.equal(history.length, 8192);
    assert.deepEqual(history[0], {
        operation: 2, offset: 108 << 2, value: 108, status_reads: 0,
    });
    assert.deepEqual(history.at(-1), {
        operation: 2, offset: 8299 << 2, value: 8299, status_reads: 0,
    });
}

{
    const { device } = create_device();
    device.init_enable = 4;

    device.write_register(0x22C, 2 << 8 | 0x5A);
    device.write_register(0x22C, 1 << 11 | 2 << 8);
    assert.equal(device.read_register(0x218), 0x5A);

    device.write_register(0x22C, 6 << 8 | 0x50);
    device.write_register(0x22C, 1 << 11 | 6 << 8);
    assert.equal(device.read_register(0x218), 0x50);

    device.write_register(0x22C, 4 << 8 | 3);
    device.write_register(0x22C, 5 << 8 | 0x12);
    device.write_register(0x22C, 5 << 8 | 0x34);
    device.write_register(0x22C, 7 << 8 | 3);
    device.write_register(0x22C, 1 << 11 | 5 << 8);
    assert.equal(device.read_register(0x218), 0x12);
    device.write_register(0x22C, 1 << 11 | 5 << 8);
    assert.equal(device.read_register(0x218), 0x34);
    device.write_register(0x22C, 1 << 11 | 7 << 8);
    assert.equal(device.read_register(0x218), 4);
    assert.deepEqual(Array.from(device.telemetry.subarray(10)), [6, 5]);
    assert.deepEqual(device.dac_history.at(-1), { value: 0xF00, read_result: 4 });

    device.write_register(0x22C, 7 << 8 | 0x0B);
    device.write_register(0x22C, 1 << 11 | 5 << 8);
    assert.equal(device.read_register(0x218), 0x79);
    device.write_register(0x22C, 1 << 11 | 5 << 8);
    assert.equal(device.read_register(0x218), 0x2E);

    device.reset_dac();
    for(const [address, expected] of [
        [0x0B, [0x79, 0x2E]],
        [0x01, [0x55, 0x49]],
        [0x07, [0x71, 0x29]],
    ])
    {
        device.write_dac(7, address);
        assert.deepEqual([device.read_dac(5), device.read_dac(5)], expected);
    }

    for(let i = 0; i < 4; i++)
    {
        assert.equal(device.read_dac(2), 0xFF);
    }
    device.write_dac(2, 3);
    assert.equal(device.dac_command, 3);
    assert.equal(device.dac_pixel_mask, 0xFF);

    device.write_dac(0, 2);
    assert.equal(device.read_dac(2), 0xFF);
    device.write_dac(0, 0);
    for(let i = 0; i < 4; i++)
    {
        assert.equal(device.read_dac(2), 0xFF);
    }
    assert.equal(device.read_dac(2), 3);
}

{
    const { device } = create_device();
    let now = 0;
    device.get_time = () => now;
    device.registers[0x224 >> 2] = 2 | 8 << 16;

    assert.equal(device.read_status() >>> 6 & 1, 0);
    assert.equal(device.read_register(0x204), 0);

    now = 5;
    assert.equal(device.read_status() >>> 6 & 1, 1);
    assert.equal(device.read_register(0x204), 7);

    now = 16;
    assert.equal(device.read_register(0x204), 1);
}

{
    const writes = [];
    const shim = {
        cpu: {
            memory_map_read8: [() => 0x34, () => 0x12],
            memory_map_write8: [
                (address, value) => writes.push([0, address, value]),
                (address, value) => writes.push([1, address, value]),
            ],
        },
    };
    assert.equal(IO.prototype.mmap_read16_shim.call(shim, 0x1FFFF), 0x1234);
    IO.prototype.mmap_write16_shim.call(shim, 0x1FFFF, 0x5678);
    assert.deepEqual(writes, [[0, 0x1FFFF, 0x78], [1, 0x20000, 0x56]]);
}

{
    const { device, uploads, presents, events } = create_device();

    device.registers[0x114 >> 2] = 0;
    device.write_lfb16(0, 0xF800);
    assert.equal(device.read_lfb16(0), 0xF800);

    device.write_lfb32(4, 0x07E0F800);
    assert.equal(device.read_lfb32(4) >>> 0, 0x07E0F800);

    device.registers[0x114 >> 2] = 1 << 11;
    device.write_lfb32(8, 0x001FF800);
    device.registers[0x114 >> 2] = 0;
    assert.equal(device.read_lfb32(8) >>> 0, 0xF800001F);

    device.registers[0x114 >> 2] = 4;
    device.write_lfb32(0, 0x00FF0000);
    device.registers[0x114 >> 2] = 0;
    assert.equal(device.read_lfb16(0), 0xF800);

    device.registers[0x114 >> 2] = 1 << 9;
    device.write_lfb16(12, 0x001F);
    assert.equal(device.read_lfb16(12), 0x001F);
    device.registers[0x114 >> 2] = 0;
    assert.equal(device.read_lfb16(12), 0xF800);

    device.registers[0x114 >> 2] = 12;
    device.write_lfb32(16, 0x1234F800);
    device.registers[0x114 >> 2] = 2 << 6;
    assert.equal(device.read_lfb16(8), 0x1234);

    device.flush_gpu_memory();
    assert.deepEqual(uploads[0], ["fbi", 0, 1228810]);

    device.registers[0x114 >> 2] = 1 << 4;
    device.write_lfb16(0, 0x001F);
    device.execute_command("swap", 0);
    assert.equal(device.front_buffer, 1);
    assert.equal(device.scanout_dirty, false);
    assert.equal(presents.length, 1);
    assert.equal(presents[0].base, 614400);
    assert.equal(device.scanout_active, false);
    assert.equal(events.length, 0);
}

{
    const { device, presents, events } = create_device();
    device.init_enable = 1;
    device.write_register(0x210, 0x410);
    assert.deepEqual(events.at(-1), ["voodoo1-set-active", false]);

    device.write_fbi16(0, 0xFFFF);
    device.write_register(0x210, 0x411);
    device.execute_command("nop", 0);
    assert.equal(presents.length, 0);
    assert.equal(device.scanout_dirty, true);
    assert.deepEqual(events.at(-1), ["voodoo1-set-active", false]);

    device.execute_command("swap", 0);
    assert.equal(presents.length, 1);
    assert.equal(device.scanout_dirty, false);
    assert.equal(device.scanout_active, false);
    assert.deepEqual(events.at(-1), ["voodoo1-set-active", false]);

    device.execute_command("triangle", 0, 0x080);
    device.execute_command("swap", 0);
    assert.equal(presents.length, 2);
    assert.equal(device.scanout_active, true);
    assert.deepEqual(events.at(-1), ["voodoo1-set-active", true]);

    device.write_register(0x210, 0x410);
    assert.deepEqual(events.at(-1), ["voodoo1-set-active", false]);
}

{
    const { device, uploads } = create_device();

    device.tmu_registers[0x300 >> 2] = 10 << 8;
    device.tmu_registers[0x304 >> 2] = 0;
    device.tmu_registers[0x30C >> 2] = 0;
    device.write_texture32(0, 0x44332211);
    assert.deepEqual(Array.from(device.tmu_memory.subarray(0, 4)),
        [0x11, 0x22, 0x33, 0x44]);

    device.write_texture32(1 << 17, 0x88776655);
    assert.deepEqual(Array.from(device.tmu_memory.subarray(131072, 131076)),
        [0x55, 0x66, 0x77, 0x88]);

    device.tmu_registers[0x300 >> 2] = 0x80000000;
    device.tmu_registers[0x304 >> 2] = 0;
    device.tmu_memory.fill(0);
    device.write_texture32(4, 0x04030201);
    assert.deepEqual(Array.from(device.tmu_memory.subarray(4, 8)),
        [1, 2, 3, 4]);

    device.tmu_registers[0x304 >> 2] = 1 << 27;
    device.write_texture32(0x100, 0xA4A3A2A1);
    assert.deepEqual(Array.from(device.tmu_memory.subarray(0x100, 0x104)),
        [0xA1, 0xA2, 0xA3, 0xA4]);

    device.flush_gpu_memory();
    assert.equal(uploads.some(upload => upload[0] === "tmu"), true);

    device.init_enable = 2;
    const pack9 = value => value & 0x1FF;
    const i0 = pack9(20) << 18 | pack9(-5) << 9;
    const q0 = pack9(-5) << 18 | pack9(10) << 9 | pack9(30);
    device.write_register(0x324, 100);
    device.write_register(0x334, i0);
    device.write_register(0x344, q0);
    assert.equal(device.texture_ncc[0], 0x736982);

    device.write_register(0x334, 0x80ABCDEF);
    device.write_register(0x338, 0x80FEDCBA);
    assert.equal(device.texture_palette[0], 0xABCDEF);
    assert.equal(device.texture_palette[1], 0xFEDCBA);
    assert.equal(device.tmu_registers[0x334 >> 2], i0);
    assert.equal(device.texture_ncc[0], 0x736982);
    const ncc_uploads = uploads.filter(upload => upload[0] === "ncc").length;
    device.flush_gpu_memory();
    assert.equal(uploads.filter(upload => upload[0] === "ncc").length,
        ncc_uploads + 1);
}

{
    const { device } = create_device();

    device.tmu_registers[0x300 >> 2] = 3 << 8;
    device.tmu_registers[0x304 >> 2] = 3 << 2;
    device.tmu_registers[0x30C >> 2] = 0x7D8AC;
    device.tmu_registers[0x034 >> 2] = 256 * 0x40000;

    const state = device.get_triangle_state(false);
    assert.equal(state.texture_base, 0x1560);
    assert.equal(state.texture_width, 32);
    assert.equal(state.texture_height, 32);
    assert.equal(state.texture_row_bytes, 32);
    assert.equal(state.start_s, 32);
}

{
    const { device, triangles, get_wakeups } = create_device();
    device.registers[0x008 >> 2] = 0xFFF0;
    device.registers[0x00C >> 2] = 0x0010;
    device.registers[0x010 >> 2] = 0x0240;
    device.registers[0x014 >> 2] = 0;
    device.registers[0x018 >> 2] = 0;
    device.registers[0x01C >> 2] = 0x0240;
    device.registers[0x110 >> 2] = 0x300;
    device.registers[0x148 >> 2] = 0x010101;

    device.execute_command("triangle", 0, 0x080);
    assert.equal(device.read_status() >>> 7 & 1, 1);
    assert.deepEqual(triangles[0], {
        width: 640,
        height: 480,
        row_pixels: 640,
        base: 0,
        color: 0x010101,
        color0: 0,
        fbz_mode: 0x300,
        fbz_color_path: 0,
        alpha_mode: 0,
        chroma_key: 0,
        za_color: 0,
        auxiliary_base: 1228800,
        fastfill: false,
        texture_mode: 0,
        texture_base: 0,
        texture_width: 256,
        texture_height: 256,
        texture_row_bytes: 256,
        start_s: 0,
        start_t: 0,
        dsdx: 0,
        dtdx: 0,
        dsdy: 0,
        dtdy: 0,
        start_w: 0,
        dwdx: 0,
        dwdy: 0,
        start_r: 0,
        start_g: 0,
        start_b: 0,
        start_a: 0,
        drdx: 0,
        dgdx: 0,
        dbdx: 0,
        dadx: 0,
        drdy: 0,
        dgdy: 0,
        dbdy: 0,
        dady: 0,
        start_z: 0,
        dzdx: 0,
        dzdy: 0,
        ax: -16,
        ay: 16,
        bx: 576,
        by: 0,
        cx: 0,
        cy: 576,
    });
    assert.equal(device.read_status() >>> 7 & 1, 1);
    assert.equal(device.cpu.in_hlt[0], 1);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(device.read_status() >>> 7 & 1, 0);
    assert.equal(device.cpu.in_hlt[0], 0);
    assert.equal(get_wakeups(), 1);

    device.execute_command("nop", 0);
    assert.equal(device.read_status() >>> 7 & 1, 0);
    assert.equal(device.cpu.in_hlt[0], 0);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(device.read_status() >>> 7 & 1, 0);
    assert.equal(device.cpu.in_hlt[0], 0);
    assert.equal(get_wakeups(), 1);
}

console.log("Voodoo1 device transfer tests passed");
