import { LOG_PCI, MMAP_BLOCK_BITS } from "./const.js";
import { h } from "./lib.js";
import { dbg_log } from "./log.js";
import { v86 } from "./main.js";

// For Types Only
import { CPU } from "./cpu.js";
import { BusConnector } from "./bus.js";
import { Voodoo1WebGPU } from "./voodoo1_webgpu.js";

export const VOODOO1_PCI_ID = 0x13 << 3;
export const VOODOO1_BAR_BASE = 0xD0000000;
export const VOODOO1_BAR_SIZE = 16 * 1024 * 1024;
export const VOODOO1_FBI_MEMORY_SIZE = 2 * 1024 * 1024;
export const VOODOO1_TMU_MEMORY_SIZE = 2 * 1024 * 1024;

const VOODOO1_REGISTER_APERTURE_SIZE = 4 * 1024 * 1024;
const VOODOO1_LFB_APERTURE_START = 0x400000;
const VOODOO1_TEXTURE_APERTURE_START = 0x800000;
const VOODOO1_REGISTER_MASK = 0x3FF;
const VOODOO1_PCI_COMMAND_MEMORY = 1 << 1;
const VOODOO1_INIT_ENABLE_INIT_WRITES = 1 << 0;
const VOODOO1_INIT_ENABLE_FIFO_WRITES = 1 << 1;
const VOODOO1_INIT_ENABLE_MASK = 0xFF7;
const VOODOO1_STATUS_RESET = 0x0FFFF07F;
const VOODOO1_FRAME_PERIOD_MS = 1000 / 60;
const VOODOO1_DAC_READ = 1 << 11;

const DAC_PIXEL_ADDRESS_WRITE = 0;
const DAC_COLOR_VALUE = 1;
const DAC_PIXEL_MASK = 2;
const DAC_PIXEL_ADDRESS_READ = 3;
const DAC_PLL_ADDRESS_WRITE = 4;
const DAC_PLL_PARAMETER = 5;
const DAC_COMMAND = 6;
const DAC_PLL_ADDRESS_READ = 7;

const MMIO_TRACE_READ16 = 1;
const MMIO_TRACE_READ32 = 2;
const MMIO_TRACE_WRITE16 = 3;
const MMIO_TRACE_WRITE32 = 4;
const MMIO_TRACE_LENGTH = 8192;
const VOODOO1_TEXTURE_SIZE_EXPONENTS = [
    [14, 12, 10, 8, 6, 4, 2, 0, 0],
    [13, 11, 9, 7, 5, 3, 1, 0, 0],
    [12, 10, 8, 6, 4, 2, 1, 0, 0],
    [11, 9, 7, 5, 3, 2, 1, 0, 0],
];

const TELEMETRY_PCI_PROBES = 0;
const TELEMETRY_MMIO_READS = 1;
const TELEMETRY_MMIO_WRITES = 2;
const TELEMETRY_PROTECTED_INIT_WRITES = 3;
const TELEMETRY_LFB_BYTES = 4;
const TELEMETRY_TEXTURE_BYTES = 5;
const TELEMETRY_NOP_COMMANDS = 6;
const TELEMETRY_TRIANGLE_COMMANDS = 7;
const TELEMETRY_FASTFILL_COMMANDS = 8;
const TELEMETRY_SWAP_COMMANDS = 9;
const TELEMETRY_DAC_WRITES = 10;
const TELEMETRY_DAC_READS = 11;
const TELEMETRY_LENGTH = 12;

const REGISTER_CHIP_FBI = 1;
const REGISTER_CHIP_TMU = 2;
const REGISTER_CHIP_BOTH = REGISTER_CHIP_FBI | REGISTER_CHIP_TMU;

/** @type {!Array<?Object>} */
export const VOODOO1_REGISTERS = new Array(256).fill(null);

/**
 * @param {number} offset
 * @param {string} name
 * @param {number} mask
 * @param {number} chips
 * @param {string} access
 * @param {boolean=} fifo
 * @param {boolean=} tmu_unconditional
 * @param {boolean=} protected_write
 * @param {number=} reset
 * @param {string=} command
 */
function define_register(offset, name, mask, chips, access, fifo,
    tmu_unconditional, protected_write, reset, command)
{
    VOODOO1_REGISTERS[offset >> 2] = {
        offset,
        name,
        mask: mask >>> 0,
        chips,
        read: access.includes("R"),
        write: access.includes("W"),
        fifo: !!fifo,
        tmu_unconditional: !!tmu_unconditional,
        protected_write: !!protected_write,
        reset: (reset || 0) >>> 0,
        command: command || "",
    };
}

/**
 * @param {number} offset
 * @param {!Array<string>} names
 * @param {number} mask
 * @param {number} chips
 * @param {string} access
 * @param {boolean=} fifo
 * @param {boolean=} tmu_unconditional
 */
function define_register_range(offset, names, mask, chips, access,
    fifo, tmu_unconditional)
{
    for(let i = 0; i < names.length; i++)
    {
        define_register(offset + (i << 2), names[i], mask, chips, access,
            fifo, tmu_unconditional);
    }
}

define_register(0x000, "status", 0xFFFFFFFF, REGISTER_CHIP_FBI, "R");
define_register_range(0x008,
    ["vertexAx", "vertexAy", "vertexBx", "vertexBy", "vertexCx", "vertexCy"],
    0xFFFF, REGISTER_CHIP_BOTH, "W", true, true);
define_register_range(0x020,
    ["startR", "startG", "startB"], 0xFFFFFF, REGISTER_CHIP_FBI, "W", true);
define_register(0x02C, "startZ", 0xFFFFFFFF, REGISTER_CHIP_FBI, "W", true);
define_register(0x030, "startA", 0xFFFFFF, REGISTER_CHIP_FBI, "W", true);
define_register_range(0x034,
    ["startS", "startT"], 0xFFFFFFFF, REGISTER_CHIP_TMU, "W", true);
define_register(0x03C, "startW", 0xFFFFFFFF, REGISTER_CHIP_BOTH, "W", true);
define_register_range(0x040,
    ["dRdX", "dGdX", "dBdX"], 0xFFFFFF, REGISTER_CHIP_FBI, "W", true);
define_register(0x04C, "dZdX", 0xFFFFFFFF, REGISTER_CHIP_FBI, "W", true);
define_register(0x050, "dAdX", 0xFFFFFF, REGISTER_CHIP_FBI, "W", true);
define_register_range(0x054,
    ["dSdX", "dTdX"], 0xFFFFFFFF, REGISTER_CHIP_TMU, "W", true);
define_register(0x05C, "dWdX", 0xFFFFFFFF, REGISTER_CHIP_BOTH, "W", true);
define_register_range(0x060,
    ["dRdY", "dGdY", "dBdY"], 0xFFFFFF, REGISTER_CHIP_FBI, "W", true);
define_register(0x06C, "dZdY", 0xFFFFFFFF, REGISTER_CHIP_FBI, "W", true);
define_register(0x070, "dAdY", 0xFFFFFF, REGISTER_CHIP_FBI, "W", true);
define_register_range(0x074,
    ["dSdY", "dTdY"], 0xFFFFFFFF, REGISTER_CHIP_TMU, "W", true);
define_register(0x07C, "dWdY", 0xFFFFFFFF, REGISTER_CHIP_BOTH, "W", true);
define_register(0x080, "triangleCMD", 0x80000000, REGISTER_CHIP_BOTH, "W",
    true, true, false, 0, "triangle");

define_register_range(0x088,
    ["fvertexAx", "fvertexAy", "fvertexBx", "fvertexBy", "fvertexCx", "fvertexCy"],
    0xFFFFFFFF, REGISTER_CHIP_BOTH, "W", true, true);
define_register_range(0x0A0,
    ["fstartR", "fstartG", "fstartB", "fstartZ", "fstartA"],
    0xFFFFFFFF, REGISTER_CHIP_FBI, "W", true);
define_register_range(0x0B4,
    ["fstartS", "fstartT"], 0xFFFFFFFF, REGISTER_CHIP_TMU, "W", true);
define_register(0x0BC, "fstartW", 0xFFFFFFFF, REGISTER_CHIP_BOTH, "W", true);
define_register_range(0x0C0,
    ["fdRdX", "fdGdX", "fdBdX", "fdZdX", "fdAdX"],
    0xFFFFFFFF, REGISTER_CHIP_FBI, "W", true);
define_register_range(0x0D4,
    ["fdSdX", "fdTdX"], 0xFFFFFFFF, REGISTER_CHIP_TMU, "W", true);
define_register(0x0DC, "fdWdX", 0xFFFFFFFF, REGISTER_CHIP_BOTH, "W", true);
define_register_range(0x0E0,
    ["fdRdY", "fdGdY", "fdBdY", "fdZdY", "fdAdY"],
    0xFFFFFFFF, REGISTER_CHIP_FBI, "W", true);
define_register_range(0x0F4,
    ["fdSdY", "fdTdY"], 0xFFFFFFFF, REGISTER_CHIP_TMU, "W", true);
define_register(0x0FC, "fdWdY", 0xFFFFFFFF, REGISTER_CHIP_BOTH, "W", true);
define_register(0x100, "ftriangleCMD", 0x80000000, REGISTER_CHIP_BOTH, "W",
    true, true, false, 0, "triangle");

define_register(0x104, "fbzColorPath", 0x0FFFFFFF, REGISTER_CHIP_BOTH, "RW", true, true);
define_register(0x108, "fogMode", 0x3F, REGISTER_CHIP_FBI, "RW", true);
define_register(0x10C, "alphaMode", 0xFFFFFFFF, REGISTER_CHIP_FBI, "RW", true);
define_register(0x110, "fbzMode", 0x1FFFFF, REGISTER_CHIP_FBI, "RW", true);
define_register(0x114, "lfbMode", 0x1FFFF, REGISTER_CHIP_FBI, "RW", true);
define_register(0x118, "clipLeftRight", 0x03FF03FF, REGISTER_CHIP_FBI, "RW", true);
define_register(0x11C, "clipLowYHighY", 0x03FF03FF, REGISTER_CHIP_FBI, "RW", true);
define_register(0x120, "nopCMD", 1, REGISTER_CHIP_BOTH, "W",
    true, true, false, 0, "nop");
define_register(0x124, "fastfillCMD", 0, REGISTER_CHIP_FBI, "W",
    true, false, false, 0, "fastfill");
define_register(0x128, "swapbufferCMD", 0x1FF, REGISTER_CHIP_FBI, "W",
    true, false, false, 0, "swap");
define_register(0x12C, "fogColor", 0xFFFFFF, REGISTER_CHIP_FBI, "W", true);
define_register(0x130, "zaColor", 0xFF00FFFF, REGISTER_CHIP_FBI, "W", true);
define_register(0x134, "chromaKey", 0xFFFFFF, REGISTER_CHIP_FBI, "W", true);
define_register(0x140, "stipple", 0xFFFFFFFF, REGISTER_CHIP_FBI, "RW", true);
define_register(0x144, "color0", 0xFFFFFFFF, REGISTER_CHIP_FBI, "RW", true);
define_register(0x148, "color1", 0xFFFFFFFF, REGISTER_CHIP_FBI, "RW", true);
define_register_range(0x14C,
    ["fbiPixelsIn", "fbiChromaFail", "fbiZfuncFail", "fbiAfuncFail", "fbiPixelsOut"],
    0xFFFFFF, REGISTER_CHIP_FBI, "R");
for(let offset = 0x160; offset <= 0x1DC; offset += 4)
{
    define_register(offset, "fogTable" + (offset - 0x160 >> 2),
        0xFFFFFFFF, REGISTER_CHIP_FBI, "W", true);
}

define_register(0x200, "fbiInit4", 0x0FFFFFFF, REGISTER_CHIP_FBI, "RW",
    false, false, true, 1);
define_register(0x204, "vRetrace", 0xFFF, REGISTER_CHIP_FBI, "R");
define_register(0x208, "backPorch", 0x00FF00FF, REGISTER_CHIP_FBI, "RW");
define_register(0x20C, "videoDimensions", 0x03FF03FF, REGISTER_CHIP_FBI, "RW");
define_register(0x210, "fbiInit0", 0x7FFFFFDF, REGISTER_CHIP_FBI, "RW",
    false, false, true, 0x00000410);
define_register(0x214, "fbiInit1", 0xFEFFFFFA, REGISTER_CHIP_FBI, "RW",
    false, false, true, 0x00201102);
define_register(0x218, "fbiInit2", 0xFFFFFFF3, REGISTER_CHIP_FBI, "RW",
    false, false, true, 0x80000040);
define_register(0x21C, "fbiInit3", 0xFFFFE07F, REGISTER_CHIP_FBI, "RW",
    false, false, true, 0x001E4000);
define_register(0x220, "hSync", 0x03FF00FF, REGISTER_CHIP_FBI, "W");
define_register(0x224, "vSync", 0x0FFF0FFF, REGISTER_CHIP_FBI, "W");
define_register(0x228, "clutData", 0x3FFFFFFF, REGISTER_CHIP_FBI, "W");
define_register(0x22C, "dacData", 0xFFF, REGISTER_CHIP_FBI, "W");
define_register(0x230, "maxRgbDelta", 0xFFFFFF, REGISTER_CHIP_FBI, "W");

define_register(0x300, "textureMode", 0xFFFFFFFF, REGISTER_CHIP_TMU, "W", true);
define_register(0x304, "tLOD", 0x0FFFFFFF, REGISTER_CHIP_TMU, "W", true);
define_register(0x308, "tDetail", 0x1FFFF, REGISTER_CHIP_TMU, "W", true);
define_register_range(0x30C,
    ["texBaseAddr", "texBaseAddr_1", "texBaseAddr_2", "texBaseAddr_3_8"],
    0x7FFFF, REGISTER_CHIP_TMU, "W", true);
define_register_range(0x31C,
    ["trexInit0", "trexInit1"], 0xFFFFFFFF, REGISTER_CHIP_TMU, "W", true);
for(let offset = 0x324; offset <= 0x380; offset += 4)
{
    define_register(offset, (offset < 0x354 ? "nccTable0_" : "nccTable1_") +
        (offset < 0x354 ? offset - 0x324 >> 2 : offset - 0x354 >> 2),
        0xFFFFFFFF, REGISTER_CHIP_TMU, "W", true);
}

const ALTERNATE_REGISTER_MAP = new Uint16Array(256);
for(let i = 0; i < ALTERNATE_REGISTER_MAP.length; i++)
{
    ALTERNATE_REGISTER_MAP[i] = i << 2;
}

const ALTERNATE_FIXED_REGISTERS = [
    0x020, 0x040, 0x060, 0x024, 0x044, 0x064,
    0x028, 0x048, 0x068, 0x02C, 0x04C, 0x06C,
    0x030, 0x050, 0x070, 0x034, 0x054, 0x074,
    0x038, 0x058, 0x078, 0x03C, 0x05C, 0x07C,
];
const ALTERNATE_FLOAT_REGISTERS = [
    0x0A0, 0x0C0, 0x0E0, 0x0A4, 0x0C4, 0x0E4,
    0x0A8, 0x0C8, 0x0E8, 0x0AC, 0x0CC, 0x0EC,
    0x0B0, 0x0D0, 0x0F0, 0x0B4, 0x0D4, 0x0F4,
    0x0B8, 0x0D8, 0x0F8, 0x0BC, 0x0DC, 0x0FC,
];
for(let i = 0; i < ALTERNATE_FIXED_REGISTERS.length; i++)
{
    ALTERNATE_REGISTER_MAP[(0x020 >> 2) + i] = ALTERNATE_FIXED_REGISTERS[i];
    ALTERNATE_REGISTER_MAP[(0x0A0 >> 2) + i] = ALTERNATE_FLOAT_REGISTERS[i];
}

/**
 * 3dfx Voodoo Graphics (SST-1), one FBI and one TMU.
 *
 * @constructor
 * @param {!CPU} cpu
 * @param {?BusConnector} bus
 * @param {!Voodoo1WebGPU} webgpu
 */
export function Voodoo1(cpu, bus, webgpu)
{
    this.name = "3dfx Voodoo Graphics";
    this.cpu = cpu;
    this.bus = bus;
    this.webgpu = webgpu;

    this.fbi_memory = new Uint8Array(VOODOO1_FBI_MEMORY_SIZE);
    this.tmu_memory = new Uint8Array(VOODOO1_TMU_MEMORY_SIZE);
    this.texture_palette = new Uint32Array(256);
    this.texture_ncc = new Uint32Array(2 * 256);
    this.triangle_state = {};
    this.texture_level_state = {};
    this.registers = new Uint32Array(256);
    this.tmu_registers = new Uint32Array(256);
    this.telemetry = new Uint32Array(TELEMETRY_LENGTH);
    this.telemetry_pending = false;
    this.dac_palette = new Uint8Array(256 * 3);
    this.dac_pll_parameters = new Uint8Array(16 * 2);
    /** @type {!Array<!Object>} */
    this.dac_history = [];
    this.mmio_history = new Uint32Array(MMIO_TRACE_LENGTH * 4);
    this.mmio_history_index = 0;
    this.status_reads_since_mmio_trace = 0;
    this.mmio_trace_enabled = false;

    this.pci_command = 0;
    this.interrupt_line = 5;
    this.init_enable = 0;
    this.bus_snoop0 = 0;
    this.bus_snoop1 = 0;
    this.bar_base = VOODOO1_BAR_BASE;
    this.bar_mapping = null;
    this.front_buffer = 0;
    this.get_time = v86.microtick;
    this.video_frame_start = this.get_time();
    this.fbi_dirty_min = VOODOO1_FBI_MEMORY_SIZE;
    this.fbi_dirty_max = 0;
    this.tmu_dirty_min = VOODOO1_TMU_MEMORY_SIZE;
    this.tmu_dirty_max = 0;
    this.texture_palette_dirty = true;
    this.scanout_dirty = false;
    this.scanout_active = false;
    this.gpu_commands_pending = false;
    this.gpu_readback_pending = false;
    this.gpu_idle_pending = false;
    this.gpu_busy = false;
    this.gpu_wait_halt = false;
    this.gpu_generation = 0;

    this.pci_id = VOODOO1_PCI_ID;
    this.pci_space = Voodoo1.create_pci_space();
    this.pci_bars = [{ size: VOODOO1_BAR_SIZE }];

    this.pci_space32 = cpu.devices.pci.register_device(this);
    this.sync_pci_space();

    this.mmio_read8_handler = addr => this.mmio_read8(addr);
    this.mmio_write8_handler = (addr, value) => this.mmio_write8(addr, value);
    this.mmio_read16_handler = addr => this.mmio_read16(addr);
    this.mmio_write16_handler = (addr, value) => this.mmio_write16(addr, value);
    this.mmio_read32_handler = addr => this.mmio_read32(addr);
    this.mmio_write32_handler = (addr, value) => this.mmio_write32(addr, value);
    this.map_bar(this.bar_base);

    dbg_log("Voodoo Graphics mapped at " + h(this.bar_base, 8), LOG_PCI);

    this.reset_registers();
}

/** @return {!Array<number>} */
Voodoo1.create_pci_space = function()
{
    const space = new Array(256).fill(0);

    // 121a:0001, revision 2, undefined display class as documented by SST-1.
    space[0x00] = 0x1A;
    space[0x01] = 0x12;
    space[0x02] = 0x01;
    space[0x03] = 0x00;
    space[0x08] = 0x02;

    // Initially assigned, non-prefetchable 16 MiB memory BAR.
    space[0x10] = VOODOO1_BAR_BASE & 0xFF;
    space[0x11] = VOODOO1_BAR_BASE >>> 8 & 0xFF;
    space[0x12] = VOODOO1_BAR_BASE >>> 16 & 0xFF;
    space[0x13] = VOODOO1_BAR_BASE >>> 24;

    space[0x3C] = 5;
    space[0x3D] = 1;
    return space;
};

Voodoo1.prototype.sync_pci_space = function()
{
    const bar = this.pci_space32[0x10 >> 2];
    this.pci_space32.fill(0);
    this.pci_space32[0x00 >> 2] = 0x0001121A;
    this.pci_space32[0x04 >> 2] = this.pci_command;
    this.pci_space32[0x08 >> 2] = 0x00000002;
    this.pci_space32[0x10 >> 2] = bar;
    this.pci_space32[0x3C >> 2] = 0x00000100 | this.interrupt_line;
    this.pci_space32[0x40 >> 2] = this.init_enable;
};

/**
 * Move the SST-1 memory aperture while preserving the mappings which were
 * underneath its previous location. Win9x's PCI resource manager relocates
 * memory BARs before the Glide VxD maps them.
 *
 * @param {number} base
 */
Voodoo1.prototype.map_bar = function(base)
{
    base = (base & -VOODOO1_BAR_SIZE) >>> 0;
    if(this.bar_mapping && base === this.bar_base)
    {
        return;
    }

    const io = this.cpu.io;
    if(this.bar_mapping)
    {
        this.unmap_bar();
    }

    const block_count = VOODOO1_BAR_SIZE >>> MMAP_BLOCK_BITS;
    const first_block = base >>> MMAP_BLOCK_BITS;
    this.bar_mapping = new Array(block_count);
    for(let i = 0; i < block_count; i++)
    {
        const index = first_block + i;
        this.bar_mapping[i] = {
            read8: this.cpu.memory_map_read8[index],
            read16: this.cpu.memory_map_read16[index],
            read32: this.cpu.memory_map_read32[index],
            write8: this.cpu.memory_map_write8[index],
            write16: this.cpu.memory_map_write16[index],
            write32: this.cpu.memory_map_write32[index],
        };
    }

    this.bar_base = base;
    io.mmap_register(base, VOODOO1_BAR_SIZE,
        this.mmio_read8_handler, this.mmio_write8_handler,
        this.mmio_read32_handler, this.mmio_write32_handler,
        this.mmio_read16_handler, this.mmio_write16_handler);
    if(this.pci_space32)
    {
        this.pci_space32[0x10 >> 2] = base;
    }
};

Voodoo1.prototype.unmap_bar = function()
{
    if(!this.bar_mapping)
    {
        return;
    }

    for(let i = 0; i < this.bar_mapping.length; i++)
    {
        const entry = this.bar_mapping[i];
        const index = (this.bar_base >>> MMAP_BLOCK_BITS) + i;
        this.cpu.memory_map_read8[index] = entry.read8;
        this.cpu.memory_map_read16[index] = entry.read16;
        this.cpu.memory_map_read32[index] = entry.read32;
        this.cpu.memory_map_write8[index] = entry.write8;
        this.cpu.memory_map_write16[index] = entry.write16;
        this.cpu.memory_map_write32[index] = entry.write32;
    }
    this.bar_mapping = null;
};

/**
 * @param {number} bar_number
 * @param {number} value
 * @return {number}
 */
Voodoo1.prototype.pci_bar_write = function(bar_number, value)
{
    if(bar_number !== 0)
    {
        return 0;
    }

    this.map_bar(value);
    return this.bar_base;
};

/**
 * Called by PCI after a configuration-space write has applied generic BAR
 * handling. SST-1 has only a handful of writable configuration fields.
 *
 * @param {number} address
 * @param {number} size
 * @param {number} value
 */
Voodoo1.prototype.pci_write = function(address, size, value)
{
    for(let i = 0; i < size; i++)
    {
        const byte_address = address + i;
        const byte_value = value >>> (i << 3) & 0xFF;

        if(byte_address === 0x04)
        {
            this.pci_command = byte_value & VOODOO1_PCI_COMMAND_MEMORY;
        }
        else if(byte_address === 0x3C)
        {
            this.interrupt_line = byte_value;
        }
        else if(byte_address >= 0x40 && byte_address < 0x44)
        {
            const shift = (byte_address - 0x40) << 3;
            this.init_enable = (this.init_enable & ~(0xFF << shift) | byte_value << shift) >>> 0;
            this.init_enable &= VOODOO1_INIT_ENABLE_MASK;
        }
        else if(byte_address >= 0x44 && byte_address < 0x48)
        {
            const shift = (byte_address - 0x44) << 3;
            this.bus_snoop0 = (this.bus_snoop0 & ~(0xFF << shift) | byte_value << shift) >>> 0;
        }
        else if(byte_address >= 0x48 && byte_address < 0x4C)
        {
            const shift = (byte_address - 0x48) << 3;
            this.bus_snoop1 = (this.bus_snoop1 & ~(0xFF << shift) | byte_value << shift) >>> 0;
        }
    }

    this.sync_pci_space();
};

/**
 * @param {number} address
 * @return {number|undefined}
 */
Voodoo1.prototype.pci_read32 = function(address)
{
    if(address === 0)
    {
        this.telemetry[TELEMETRY_PCI_PROBES]++;
        this.emit_telemetry();
    }
    else if(address === 0x44 || address === 0x48)
    {
        // busSnoop0/1 are write-only.
        return 0;
    }
    else if(address === 0x4C)
    {
        return this.read_status();
    }

    return undefined;
};

/** @return {boolean} */
Voodoo1.prototype.memory_decode_enabled = function()
{
    return !!(this.pci_command & VOODOO1_PCI_COMMAND_MEMORY);
};

Voodoo1.prototype.emit_telemetry = function()
{
    if(this.telemetry_pending)
    {
        return;
    }

    this.telemetry_pending = true;
    setTimeout(() =>
    {
        this.telemetry_pending = false;
        this.bus.send("voodoo1-telemetry", this.telemetry);
    }, 0);
};

/** @return {number} */
Voodoo1.prototype.read_status = function()
{
    if(this.gpu_busy && !this.gpu_readback_pending && !this.gpu_idle_pending)
    {
        this.begin_gpu_idle_wait();
    }
    if(this.gpu_busy && (this.gpu_readback_pending || this.gpu_idle_pending) &&
        !this.gpu_wait_halt)
    {
        // A WebGPU mapping promise cannot settle while wasm is spinning in a
        // guest status loop. Suspend this CPU slice and resume it from the
        // readback callback, as a hardware wait state would do.
        this.gpu_wait_halt = true;
        this.cpu.in_hlt[0] = 1;
    }
    const vertical_counter = this.get_vertical_timing_counter();
    return (VOODOO1_STATUS_RESET & ~(1 << 6 | 3 << 10) |
        +(vertical_counter !== 0) << 6 |
        +this.gpu_busy << 7 |
        +this.gpu_busy << 9 |
        this.front_buffer << 10) >>> 0;
};

/**
 * SST-1 vSync timing is expressed in horizontal scan lines. The video DAC
 * clock is not modelled yet, so use the 60 Hz mode expected by the initial
 * 640x480 target while preserving the guest-programmed on/off line counts.
 *
 * @return {number}
 */
Voodoo1.prototype.get_vertical_timing_counter = function()
{
    const v_sync = this.registers[0x224 >> 2];
    let sync_on = v_sync & 0xFFF;
    let sync_off = v_sync >>> 16 & 0xFFF;
    if(!sync_on || !sync_off)
    {
        sync_on = 2;
        sync_off = 523;
    }

    const total_lines = sync_on + sync_off;
    let elapsed = (this.get_time() - this.video_frame_start) % VOODOO1_FRAME_PERIOD_MS;
    if(elapsed < 0)
    {
        elapsed += VOODOO1_FRAME_PERIOD_MS;
    }
    const line = Math.min(total_lines - 1,
        Math.floor(elapsed * total_lines / VOODOO1_FRAME_PERIOD_MS));
    return line < sync_on ? 0 : sync_off - (line - sync_on);
};

/** @return {{active: boolean, counter: number}} */
Voodoo1.prototype.get_vertical_timing = function()
{
    const counter = this.get_vertical_timing_counter();
    return { active: counter === 0, counter };
};

Voodoo1.prototype.reset_registers = function()
{
    this.registers.fill(0);
    this.tmu_registers.fill(0);
    this.texture_palette.fill(0);
    this.texture_palette_dirty = true;
    this.texture_ncc.fill(0);
    this.texture_ncc_dirty = true;

    for(const register of VOODOO1_REGISTERS)
    {
        if(!register)
        {
            continue;
        }

        if(register.chips & REGISTER_CHIP_FBI)
        {
            this.registers[register.offset >> 2] = register.reset;
        }
        if(register.chips & REGISTER_CHIP_TMU)
        {
            this.tmu_registers[register.offset >> 2] = register.reset;
        }
    }

    this.reset_dac();
};

Voodoo1.prototype.reset_dac = function()
{
    this.dac_palette.fill(0);
    this.dac_pll_parameters.fill(0);

    // ICS5342 power-on defaults for the eight video clocks and two memory
    // clocks. Each indexed PLL register contains an M byte followed by N.
    this.dac_pll_parameters.set([
        0x7D, 0x50, 0x55, 0x49, 0x2A, 0x43, 0x77, 0x4A,
        0x79, 0x49, 0x6F, 0x47, 0x74, 0x2B, 0x71, 0x29,
    ]);
    this.dac_pll_parameters.set([0x4F, 0x2B], 10 * 2);
    this.dac_pll_parameters.set([0x79, 0x2E], 11 * 2);

    this.dac_pixel_address = 0;
    this.dac_palette_address = 0;
    this.dac_palette_component = 0;
    this.dac_pll_address = 0;
    this.dac_pll_component = 0;
    this.dac_pixel_mask = 0xFF;
    this.dac_command = 0;
    this.dac_read_result = 0;
    this.dac_hidden_reads = 0;
    this.dac_history.length = 0;
};

/**
 * @param {number} address
 * @param {number} value
 */
Voodoo1.prototype.write_dac = function(address, value)
{
    value &= 0xFF;
    if(address === DAC_PIXEL_MASK)
    {
        if(this.dac_hidden_reads === 4)
        {
            this.dac_hidden_reads = 0;
            this.dac_command = value;
            return;
        }
        this.dac_hidden_reads = 0;
    }
    else
    {
        this.dac_hidden_reads = 0;
    }

    if(address === DAC_PIXEL_ADDRESS_WRITE)
    {
        this.dac_pixel_address = value;
        this.dac_palette_address = value;
        this.dac_palette_component = 0;
    }
    else if(address === DAC_COLOR_VALUE)
    {
        const index = this.dac_pixel_address * 3 + this.dac_palette_component;
        this.dac_palette[index] = value & 0x3F;
        this.dac_palette_component++;
        if(this.dac_palette_component === 3)
        {
            this.dac_palette_component = 0;
            this.dac_pixel_address = this.dac_pixel_address + 1 & 0xFF;
        }
    }
    else if(address === DAC_PIXEL_MASK)
    {
        this.dac_pixel_mask = value;
    }
    else if(address === DAC_PIXEL_ADDRESS_READ)
    {
        this.dac_palette_address = value;
        this.dac_pixel_address = value + 1 & 0xFF;
        this.dac_palette_component = 0;
    }
    else if(address === DAC_PLL_ADDRESS_WRITE || address === DAC_PLL_ADDRESS_READ)
    {
        this.dac_pll_address = value & 0xF;
        this.dac_pll_component = 0;
    }
    else if(address === DAC_PLL_PARAMETER)
    {
        const pll_address = this.dac_pll_address;
        if(pll_address <= 7 || pll_address === 10 || pll_address === 11 || pll_address === 14)
        {
            this.dac_pll_parameters[pll_address * 2 + this.dac_pll_component] = value;
        }
        this.advance_dac_pll_address();
    }
    else if(address === DAC_COMMAND)
    {
        this.dac_command = value;
    }
};

/** @return {number} */
Voodoo1.prototype.read_dac = function(address)
{
    if(address === DAC_PIXEL_MASK)
    {
        if(this.dac_hidden_reads === 4)
        {
            this.dac_hidden_reads = 0;
            return this.dac_command;
        }
        this.dac_hidden_reads++;
        return this.dac_pixel_mask;
    }

    this.dac_hidden_reads = 0;
    if(address === DAC_PIXEL_ADDRESS_WRITE || address === DAC_PIXEL_ADDRESS_READ)
    {
        return this.dac_pixel_address;
    }
    if(address === DAC_COLOR_VALUE)
    {
        const index = this.dac_palette_address * 3 + this.dac_palette_component;
        const value = this.dac_palette[index];
        this.dac_palette_component++;
        if(this.dac_palette_component === 3)
        {
            this.dac_palette_component = 0;
            this.dac_palette_address = this.dac_pixel_address;
            this.dac_pixel_address = this.dac_pixel_address + 1 & 0xFF;
        }
        return value;
    }
    if(address === DAC_PLL_ADDRESS_WRITE || address === DAC_PLL_ADDRESS_READ)
    {
        return this.dac_pll_address;
    }
    if(address === DAC_PLL_PARAMETER)
    {
        const index = this.dac_pll_address * 2 + this.dac_pll_component;
        const value = this.dac_pll_parameters[index];
        this.advance_dac_pll_address();
        return value;
    }
    if(address === DAC_COMMAND)
    {
        return this.dac_command;
    }
    return 0;
};

Voodoo1.prototype.advance_dac_pll_address = function()
{
    if(this.dac_pll_address === 14 || ++this.dac_pll_component === 2)
    {
        this.dac_pll_component = 0;
        this.dac_pll_address = this.dac_pll_address + 1 & 0xF;
    }
};

/**
 * @param {number} operation
 * @param {number} offset
 * @param {number} value
 */
Voodoo1.prototype.trace_mmio = function(operation, offset, value)
{
    const index = (this.mmio_history_index & MMIO_TRACE_LENGTH - 1) * 4;
    this.mmio_history[index] = operation;
    this.mmio_history[index + 1] = offset;
    this.mmio_history[index + 2] = value;
    this.mmio_history[index + 3] = this.status_reads_since_mmio_trace;
    this.status_reads_since_mmio_trace = 0;
    this.mmio_history_index++;
};

/** @return {!Array<!Object>} */
Voodoo1.prototype.get_mmio_history = function()
{
    const length = Math.min(this.mmio_history_index, MMIO_TRACE_LENGTH);
    const start = this.mmio_history_index - length;
    const result = new Array(length);
    for(let i = 0; i < length; i++)
    {
        const index = (start + i & MMIO_TRACE_LENGTH - 1) * 4;
        result[i] = {
            operation: this.mmio_history[index],
            offset: this.mmio_history[index + 1],
            value: this.mmio_history[index + 2],
            status_reads: this.mmio_history[index + 3],
        };
    }
    return result;
};

/**
 * @param {number} offset
 * @return {number}
 */
Voodoo1.prototype.decode_register_offset = function(offset)
{
    let register_offset = offset & VOODOO1_REGISTER_MASK;
    const alternate_mapping = this.registers[0x21C >> 2] & 1;
    if(alternate_mapping && offset & 0x200000)
    {
        register_offset = ALTERNATE_REGISTER_MAP[register_offset >> 2];
    }
    return register_offset;
};

/**
 * @param {number} value
 * @return {number}
 */
Voodoo1.byte_swizzle32 = function(value)
{
    return (value >>> 24 |
        value >>> 8 & 0x0000FF00 |
        value << 8 & 0x00FF0000 |
        value << 24) >>> 0;
};

/** @param {number} value @return {number} */
Voodoo1.word_swap32 = function(value)
{
    return (value >>> 16 | value << 16) >>> 0;
};

/** @param {number} value @return {number} */
Voodoo1.byte_swap16 = function(value)
{
    return (value >>> 8 | value << 8) & 0xFFFF;
};

/**
 * @param {Object=} result
 * @return {{width: number, height: number, row_pixels: number}}
 */
Voodoo1.prototype.get_video_dimensions = function(result)
{
    const dimensions = this.registers[0x20C >> 2];
    let width = dimensions & 0x3FF;
    let height = dimensions >>> 16 & 0x3FF;
    const tiles = this.registers[0x214 >> 2] >>> 4 & 0xF;
    // fbiInit1 stores the number of 64-pixel tiles in 3.1 notation after
    // division by two. The two factors cancel: the raw field is the actual
    // tile count, not half of it.
    const row_pixels = tiles ? tiles << 6 : width || 640;

    width = width || Math.min(row_pixels, 640);
    // Glide programs the last visible X coordinate on some SST-1 paths.
    // Prefer the complete scanline when the values differ by one pixel.
    if(width + 1 === row_pixels)
    {
        width = row_pixels;
    }
    height = height || 480;
    if(result)
    {
        const dimensions_result = /** @type {{width: number, height: number,
            row_pixels: number}} */ (/** @type {?} */ (result));
        dimensions_result.width = width;
        dimensions_result.height = height;
        dimensions_result.row_pixels = row_pixels;
        return dimensions_result;
    }
    return { width, height, row_pixels };
};

/** @return {number} */
Voodoo1.prototype.get_buffer_stride = function()
{
    const configured = (this.registers[0x218 >> 2] >>> 11 & 0x1FF) << 12;
    if(configured)
    {
        return configured;
    }

    const dimensions = this.get_video_dimensions();
    return dimensions.row_pixels * dimensions.height * 2 + 0xFFF & ~0xFFF;
};

/**
 * @param {number} selection 0=front, 1=back, 2=auxiliary
 * @return {number}
 */
Voodoo1.prototype.get_buffer_base = function(selection)
{
    const stride = this.get_buffer_stride();
    if(selection === 0)
    {
        return this.front_buffer * stride;
    }
    if(selection === 1)
    {
        return (this.front_buffer ^ 1) * stride;
    }
    return 2 * stride;
};

/**
 * @param {number} selection
 * @param {number} x
 * @param {number} y
 * @param {boolean} bottom_origin
 * @return {number}
 */
Voodoo1.prototype.get_fbi_pixel_address = function(selection, x, y, bottom_origin)
{
    const dimensions = this.get_video_dimensions();
    if(x < 0 || x >= dimensions.row_pixels || y < 0 || y >= dimensions.height)
    {
        return -1;
    }
    if(bottom_origin)
    {
        y = dimensions.height - 1 - y;
    }

    return (this.get_buffer_base(selection) +
        (y * dimensions.row_pixels + x) * 2) & (VOODOO1_FBI_MEMORY_SIZE - 1);
};

/** @param {number} address @return {number} */
Voodoo1.prototype.read_fbi16 = function(address)
{
    if(address < 0)
    {
        return 0xFFFF;
    }
    return this.fbi_memory[address] | this.fbi_memory[address + 1] << 8;
};

/** @param {number} address @param {number} value */
Voodoo1.prototype.write_fbi16 = function(address, value)
{
    if(address < 0)
    {
        return;
    }
    this.fbi_memory[address] = value;
    this.fbi_memory[address + 1] = value >>> 8;
    this.fbi_dirty_min = Math.min(this.fbi_dirty_min, address);
    this.fbi_dirty_max = Math.max(this.fbi_dirty_max, address + 2);
    this.scanout_dirty = true;
};

Voodoo1.prototype.flush_gpu_memory = function()
{
    if(this.fbi_dirty_min < this.fbi_dirty_max)
    {
        this.webgpu.upload_fbi_range(this.fbi_memory,
            this.fbi_dirty_min, this.fbi_dirty_max);
        this.fbi_dirty_min = VOODOO1_FBI_MEMORY_SIZE;
        this.fbi_dirty_max = 0;
    }
    if(this.tmu_dirty_min < this.tmu_dirty_max)
    {
        this.webgpu.upload_tmu_range(this.tmu_memory,
            this.tmu_dirty_min, this.tmu_dirty_max);
        this.tmu_dirty_min = VOODOO1_TMU_MEMORY_SIZE;
        this.tmu_dirty_max = 0;
    }
    if(this.texture_palette_dirty)
    {
        this.webgpu.upload_palette(this.texture_palette);
        this.texture_palette_dirty = false;
    }
    if(this.texture_ncc_dirty)
    {
        this.webgpu.upload_ncc(this.texture_ncc);
        this.texture_ncc_dirty = false;
    }
};

/**
 * Copy completed WebGPU raster work back into the CPU-visible FBI mirror.
 * SST software issues a NOP and polls the busy bits before reading the LFB;
 * that sequence is the asynchronous boundary required by WebGPU.
 */
Voodoo1.prototype.begin_gpu_readback = function()
{
    if(!this.gpu_commands_pending || this.gpu_readback_pending)
    {
        return;
    }

    this.gpu_readback_pending = true;
    this.gpu_busy = true;
    const generation = this.gpu_generation;
    this.webgpu.readback_fbi().then(memory =>
    {
        if(generation !== this.gpu_generation)
        {
            return;
        }
        this.fbi_memory.set(memory);
        this.gpu_readback_pending = false;
        this.gpu_commands_pending = false;
        this.gpu_busy = false;
        this.resume_after_gpu_wait();
    }, error =>
    {
        if(generation !== this.gpu_generation)
        {
            return;
        }
        this.gpu_readback_pending = false;
        this.gpu_commands_pending = false;
        this.gpu_busy = false;
        this.resume_after_gpu_wait();
        this.bus.send("voodoo1-device-lost", {
            reason: "readback-failed",
            message: String(error && error.message || error),
        });
    });
};

Voodoo1.prototype.begin_gpu_idle_wait = function()
{
    if(!this.gpu_commands_pending || this.gpu_idle_pending ||
        this.gpu_readback_pending)
    {
        return;
    }

    this.gpu_idle_pending = true;
    const generation = this.gpu_generation;
    this.webgpu.wait_for_idle().then(() =>
    {
        if(generation !== this.gpu_generation)
        {
            return;
        }
        this.gpu_idle_pending = false;
        this.gpu_commands_pending = false;
        this.gpu_busy = this.gpu_readback_pending;
        if(!this.gpu_busy)
        {
            this.resume_after_gpu_wait();
        }
    }, error =>
    {
        if(generation !== this.gpu_generation)
        {
            return;
        }
        this.gpu_idle_pending = false;
        this.gpu_busy = this.gpu_readback_pending;
        if(!this.gpu_busy)
        {
            this.resume_after_gpu_wait();
        }
        this.bus.send("voodoo1-device-lost", {
            reason: "command-failed",
            message: String(error && error.message || error),
        });
    });
};

Voodoo1.prototype.resume_after_gpu_wait = function()
{
    if(!this.gpu_wait_halt)
    {
        return;
    }

    this.gpu_wait_halt = false;
    this.cpu.in_hlt[0] = 0;
    this.cpu.stop_idling();
};

/** @param {number} value @return {number} */
Voodoo1.signed16 = function(value)
{
    return value << 16 >> 16;
};

const VOODOO1_FLOAT_BITS = new Uint32Array(1);
const VOODOO1_FLOAT_VALUE = new Float32Array(VOODOO1_FLOAT_BITS.buffer);

/** @param {number} value @return {number} */
Voodoo1.float32 = function(value)
{
    VOODOO1_FLOAT_BITS[0] = value;
    return VOODOO1_FLOAT_VALUE[0];
};

/** @param {number} value @return {number} */
Voodoo1.float_vertex_12_4 = function(value)
{
    // The floating setup path converts into the same signed 12.4 storage as
    // the fixed vertex registers. Glide relies on that 16-bit wrap when it
    // adds a large IEEE-754 bias to obtain deterministic subpixel rounding.
    return Voodoo1.signed16(Math.round(Voodoo1.float32(value) * 16));
};

/** @param {number} value @return {number} */
Voodoo1.signed24 = function(value)
{
    return value << 8 >> 8;
};

/** @param {number} value @return {number} */
Voodoo1.signed9 = function(value)
{
    return value << 23 >> 23;
};

/** @param {number} value @return {number} */
Voodoo1.clamp_byte = function(value)
{
    return Math.max(0, Math.min(255, value));
};

/** @param {number} table */
Voodoo1.prototype.update_ncc_table = function(table)
{
    const register_base = (table ? 0x354 : 0x324) >> 2;
    const lookup_base = table * 256;
    const y = new Uint8Array(16);

    for(let register = 0; register < 4; register++)
    {
        const value = this.tmu_registers[register_base + register];
        for(let component = 0; component < 4; component++)
        {
            y[register * 4 + component] = value >>> (component * 8) & 0xFF;
        }
    }

    for(let texel = 0; texel < 256; texel++)
    {
        const intensity = y[texel >>> 4];
        const i = this.tmu_registers[register_base + 4 + (texel >>> 2 & 3)];
        const q = this.tmu_registers[register_base + 8 + (texel & 3)];
        const red = Voodoo1.clamp_byte(intensity +
            Voodoo1.signed9(i >>> 18) + Voodoo1.signed9(q >>> 18));
        const green = Voodoo1.clamp_byte(intensity +
            Voodoo1.signed9(i >>> 9) + Voodoo1.signed9(q >>> 9));
        const blue = Voodoo1.clamp_byte(intensity +
            Voodoo1.signed9(i) + Voodoo1.signed9(q));
        this.texture_ncc[lookup_base + texel] = red << 16 | green << 8 | blue;
    }
    this.texture_ncc_dirty = true;
};

/**
 * Snapshot the register state consumed by one triangle command.
 * @param {boolean} floating
 * @return {{ax: number, ay: number, bx: number, by: number,
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
 *     auxiliary_base: number, fastfill: boolean}}
 */
Voodoo1.prototype.get_triangle_state = function(floating)
{
    const state = this.triangle_state || (this.triangle_state = {});
    const dimensions = this.get_video_dimensions(state);
    state.width = dimensions.width;
    state.height = dimensions.height;
    state.row_pixels = dimensions.row_pixels;
    const fbz_mode = this.registers[0x110 >> 2];
    const texture_lod = this.get_texture_render_lod();
    const texture_scale = 1 << texture_lod;
    const texture_level = this.get_texture_level(texture_lod,
        this.texture_level_state || (this.texture_level_state = {}));
    state.base = this.get_buffer_base(fbz_mode >>> 14 & 3);
    state.color = this.registers[0x148 >> 2];
    state.color0 = this.registers[0x144 >> 2];
    state.fbz_mode = fbz_mode;
    state.fbz_color_path = this.registers[0x104 >> 2];
    state.alpha_mode = this.registers[0x10C >> 2];
    state.chroma_key = this.registers[0x134 >> 2];
    state.za_color = this.registers[0x130 >> 2];
    state.auxiliary_base = this.get_buffer_base(2);
    state.fastfill = false;
    state.texture_mode = this.tmu_registers[0x300 >> 2];
    state.texture_base = this.get_texture_level_base(texture_lod);
    state.texture_width = texture_level.width;
    state.texture_height = texture_level.height;
    state.texture_row_bytes = texture_level.row_bytes;
    state.start_s = (this.tmu_registers[0x034 >> 2] | 0) /
        (0x40000 * texture_scale);
    state.start_t = (this.tmu_registers[0x038 >> 2] | 0) /
        (0x40000 * texture_scale);
    state.dsdx = (this.tmu_registers[0x054 >> 2] | 0) /
        (0x40000 * texture_scale);
    state.dtdx = (this.tmu_registers[0x058 >> 2] | 0) /
        (0x40000 * texture_scale);
    state.dsdy = (this.tmu_registers[0x074 >> 2] | 0) /
        (0x40000 * texture_scale);
    state.dtdy = (this.tmu_registers[0x078 >> 2] | 0) /
        (0x40000 * texture_scale);
    state.start_w = (this.tmu_registers[0x03C >> 2] | 0) / 0x40000000;
    state.dwdx = (this.tmu_registers[0x05C >> 2] | 0) / 0x40000000;
    state.dwdy = (this.tmu_registers[0x07C >> 2] | 0) / 0x40000000;
    state.start_r = Voodoo1.signed24(this.registers[0x020 >> 2]) / 0x1000;
    state.start_g = Voodoo1.signed24(this.registers[0x024 >> 2]) / 0x1000;
    state.start_b = Voodoo1.signed24(this.registers[0x028 >> 2]) / 0x1000;
    state.start_a = Voodoo1.signed24(this.registers[0x030 >> 2]) / 0x1000;
    state.drdx = Voodoo1.signed24(this.registers[0x040 >> 2]) / 0x1000;
    state.dgdx = Voodoo1.signed24(this.registers[0x044 >> 2]) / 0x1000;
    state.dbdx = Voodoo1.signed24(this.registers[0x048 >> 2]) / 0x1000;
    state.dadx = Voodoo1.signed24(this.registers[0x050 >> 2]) / 0x1000;
    state.drdy = Voodoo1.signed24(this.registers[0x060 >> 2]) / 0x1000;
    state.dgdy = Voodoo1.signed24(this.registers[0x064 >> 2]) / 0x1000;
    state.dbdy = Voodoo1.signed24(this.registers[0x068 >> 2]) / 0x1000;
    state.dady = Voodoo1.signed24(this.registers[0x070 >> 2]) / 0x1000;
    state.start_z = (this.registers[0x02C >> 2] | 0) / 0x1000;
    state.dzdx = (this.registers[0x04C >> 2] | 0) / 0x1000;
    state.dzdy = (this.registers[0x06C >> 2] | 0) / 0x1000;
    state.ax = 0;
    state.ay = 0;
    state.bx = 0;
    state.by = 0;
    state.cx = 0;
    state.cy = 0;

    if(floating)
    {
        state.ax = Voodoo1.float_vertex_12_4(this.registers[0x088 >> 2]);
        state.ay = Voodoo1.float_vertex_12_4(this.registers[0x08C >> 2]);
        state.bx = Voodoo1.float_vertex_12_4(this.registers[0x090 >> 2]);
        state.by = Voodoo1.float_vertex_12_4(this.registers[0x094 >> 2]);
        state.cx = Voodoo1.float_vertex_12_4(this.registers[0x098 >> 2]);
        state.cy = Voodoo1.float_vertex_12_4(this.registers[0x09C >> 2]);
        state.start_s = Voodoo1.float32(this.tmu_registers[0x0B4 >> 2]) /
            texture_scale;
        state.start_t = Voodoo1.float32(this.tmu_registers[0x0B8 >> 2]) /
            texture_scale;
        state.dsdx = Voodoo1.float32(this.tmu_registers[0x0D4 >> 2]) /
            texture_scale;
        state.dtdx = Voodoo1.float32(this.tmu_registers[0x0D8 >> 2]) /
            texture_scale;
        state.dsdy = Voodoo1.float32(this.tmu_registers[0x0F4 >> 2]) /
            texture_scale;
        state.dtdy = Voodoo1.float32(this.tmu_registers[0x0F8 >> 2]) /
            texture_scale;
        state.start_w = Voodoo1.float32(this.tmu_registers[0x0BC >> 2]);
        state.dwdx = Voodoo1.float32(this.tmu_registers[0x0DC >> 2]);
        state.dwdy = Voodoo1.float32(this.tmu_registers[0x0FC >> 2]);
        state.start_r = Voodoo1.float32(this.registers[0x0A0 >> 2]);
        state.start_g = Voodoo1.float32(this.registers[0x0A4 >> 2]);
        state.start_b = Voodoo1.float32(this.registers[0x0A8 >> 2]);
        state.start_a = Voodoo1.float32(this.registers[0x0B0 >> 2]);
        state.drdx = Voodoo1.float32(this.registers[0x0C0 >> 2]);
        state.dgdx = Voodoo1.float32(this.registers[0x0C4 >> 2]);
        state.dbdx = Voodoo1.float32(this.registers[0x0C8 >> 2]);
        state.dadx = Voodoo1.float32(this.registers[0x0D0 >> 2]);
        state.drdy = Voodoo1.float32(this.registers[0x0E0 >> 2]);
        state.dgdy = Voodoo1.float32(this.registers[0x0E4 >> 2]);
        state.dbdy = Voodoo1.float32(this.registers[0x0E8 >> 2]);
        state.dady = Voodoo1.float32(this.registers[0x0F0 >> 2]);
        state.start_z = Voodoo1.float32(this.registers[0x0AC >> 2]);
        state.dzdx = Voodoo1.float32(this.registers[0x0CC >> 2]);
        state.dzdy = Voodoo1.float32(this.registers[0x0EC >> 2]);
    }
    else
    {
        state.ax = Voodoo1.signed16(this.registers[0x008 >> 2]);
        state.ay = Voodoo1.signed16(this.registers[0x00C >> 2]);
        state.bx = Voodoo1.signed16(this.registers[0x010 >> 2]);
        state.by = Voodoo1.signed16(this.registers[0x014 >> 2]);
        state.cx = Voodoo1.signed16(this.registers[0x018 >> 2]);
        state.cy = Voodoo1.signed16(this.registers[0x01C >> 2]);
    }
    return state;
};

/** @return {number} */
Voodoo1.prototype.get_texture_render_lod = function()
{
    // The 4.2 minimum is an absolute clamp on the calculated LOD. Until
    // per-pixel trilinear selection is implemented, choose its integer level;
    // this also preserves the common LOD 0 path.
    return Math.min(8, (this.tmu_registers[0x304 >> 2] & 0x3F) >>> 2);
};

/**
 * Convert one documented 16-bit LFB color input to native RGB565.
 * @param {number} value
 * @param {number} format
 * @param {number} lanes
 * @return {{color: number, alpha: number}}
 */
Voodoo1.convert_lfb16 = function(value, format, lanes)
{
    let red;
    let green;
    let blue;
    let alpha = 0xFF;
    const blue_first = lanes === 1 || lanes === 3;

    if(format === 0 || format === 12)
    {
        const high = value >>> 11 & 0x1F;
        const low = value & 0x1F;
        red = blue_first ? low : high;
        green = value >>> 5 & 0x3F;
        blue = blue_first ? high : low;
    }
    else
    {
        const low_lane_alpha = lanes >= 2;
        const high = value >>> (low_lane_alpha ? 11 : 10) & 0x1F;
        const middle = value >>> (low_lane_alpha ? 6 : 5) & 0x1F;
        const low = value >>> (low_lane_alpha ? 1 : 0) & 0x1F;
        red = blue_first ? low : high;
        green = middle << 1 | middle >>> 4;
        blue = blue_first ? high : low;
        if(format === 2 || format === 14)
        {
            alpha = value >>> (low_lane_alpha ? 0 : 15) & 1 ? 0xFF : 0;
        }
    }

    return { color: red << 11 | green << 5 | blue, alpha };
};

/**
 * @param {number} value
 * @param {number} format
 * @param {number} lanes
 * @return {{color: number, alpha: number}}
 */
Voodoo1.convert_lfb32 = function(value, format, lanes)
{
    let red;
    let green;
    let blue;
    let alpha = 0xFF;

    if(lanes < 2)
    {
        alpha = value >>> 24;
        const high = value >>> 16 & 0xFF;
        green = value >>> 8 & 0xFF;
        const low = value & 0xFF;
        red = lanes === 1 ? low : high;
        blue = lanes === 1 ? high : low;
    }
    else
    {
        const high = value >>> 24;
        green = value >>> 16 & 0xFF;
        const low = value >>> 8 & 0xFF;
        alpha = value & 0xFF;
        red = lanes === 3 ? low : high;
        blue = lanes === 3 ? high : low;
    }
    if(format === 4)
    {
        alpha = 0xFF;
    }

    return {
        color: (red >>> 3) << 11 | (green >>> 2) << 5 | blue >>> 3,
        alpha,
    };
};

/**
 * @param {number} register_offset
 * @return {number}
 */
Voodoo1.prototype.read_register = function(register_offset)
{
    const register = VOODOO1_REGISTERS[register_offset >> 2];
    if(!register || !register.read || !(register.chips & REGISTER_CHIP_FBI))
    {
        return -1;
    }

    if(register_offset === 0)
    {
        return this.read_status();
    }

    if(register_offset === 0x204)
    {
        return this.get_vertical_timing_counter();
    }

    // initEnable[2] aliases these reads to the DAC result and video checksum.
    if(this.init_enable & 4)
    {
        if(register_offset === 0x218)
        {
            return this.dac_read_result;
        }
        if(register_offset === 0x21C)
        {
            return 0;
        }
    }

    return this.registers[register_offset >> 2] & register.mask;
};

/**
 * @param {string} command
 * @param {number} value
 * @param {number=} register_offset
 */
Voodoo1.prototype.execute_command = function(command, value, register_offset)
{
    if(command === "nop")
    {
        this.telemetry[TELEMETRY_NOP_COMMANDS]++;
        this.emit_telemetry();
        this.flush_gpu_memory();
        // NOP flushes the graphics pipeline, but does not transfer FBI RAM
        // across PCI. A full WebGPU readback here is both unnecessary and
        // especially costly for guests which use NOP as a frequent barrier.
        // Glide's SST self-test renders, issues NOP, and then verifies pixels
        // through the LFB before the first swap. Synchronize the CPU mirror
        // during that initialization phase. Gameplay status polling starts a
        // lightweight queue fence through read_status only when it is needed.
        const before_first_swap = !this.telemetry[TELEMETRY_SWAP_COMMANDS];
        if(before_first_swap)
        {
            this.begin_gpu_readback();
        }
        if(value & 1)
        {
            this.registers.fill(0, 0x14C >> 2, (0x15C >> 2) + 1);
        }
    }
    else if(command === "triangle")
    {
        this.telemetry[TELEMETRY_TRIANGLE_COMMANDS]++;
        if(this.telemetry[TELEMETRY_TRIANGLE_COMMANDS] === 1)
        {
            this.emit_telemetry();
        }
        this.flush_gpu_memory();
        if(this.webgpu.render_triangle(
            this.get_triangle_state(register_offset === 0x100)))
        {
            this.gpu_commands_pending = true;
            this.gpu_busy = true;
            this.scanout_dirty = true;
        }
    }
    else if(command === "fastfill")
    {
        this.telemetry[TELEMETRY_FASTFILL_COMMANDS]++;
        this.flush_gpu_memory();
        const left_right = this.registers[0x118 >> 2];
        const low_high = this.registers[0x11C >> 2];
        const left = left_right >>> 16 & 0x3FF;
        const right = left_right & 0x3FF;
        const low = low_high >>> 16 & 0x3FF;
        const high = low_high & 0x3FF;
        if(left < right && low < high)
        {
            const state = this.get_triangle_state(false);
            state.fastfill = true;
            state.fbz_color_path = state.fbz_color_path & ~3 | 2;
            state.ax = left << 4;
            state.ay = low << 4;
            state.bx = right << 4;
            state.by = low << 4;
            state.cx = left << 4;
            state.cy = high << 4;
            const first = this.webgpu.render_triangle(state);
            state.ax = right << 4;
            state.ay = low << 4;
            state.bx = right << 4;
            state.by = high << 4;
            state.cx = left << 4;
            state.cy = high << 4;
            const second = this.webgpu.render_triangle(state);
            this.gpu_commands_pending = first || second ||
                this.gpu_commands_pending;
            this.gpu_busy = first || second || this.gpu_busy;
            this.scanout_dirty = first || second || this.scanout_dirty;
        }
    }
    else if(command === "swap")
    {
        this.telemetry[TELEMETRY_SWAP_COMMANDS]++;
        this.emit_telemetry();
        const rendered_frame = this.scanout_dirty;
        this.front_buffer ^= 1;
        this.flush_gpu_memory();
        this.present_front_buffer();
        this.scanout_dirty = false;
        // SST initialization uses a run of empty swaps as a vertical-retrace
        // delay while a VGA splash screen remains visible. The first swap
        // also follows destructive framebuffer diagnostics. Do not take over
        // the display until a later swap contains newly rendered Voodoo data.
        if(rendered_frame && this.telemetry[TELEMETRY_SWAP_COMMANDS] > 1)
        {
            this.scanout_active = true;
            this.bus.send("voodoo1-set-active", true);
        }
    }
};

Voodoo1.prototype.present_front_buffer = function()
{
    const dimensions = this.get_video_dimensions();
    this.webgpu.present({
        width: dimensions.width,
        height: dimensions.height,
        row_pixels: dimensions.row_pixels,
        base: this.get_buffer_base(0),
    });
};

/**
 * @param {number} offset
 * @param {number} value
 */
Voodoo1.prototype.write_register = function(offset, value)
{
    let register_offset = this.decode_register_offset(offset);
    const register = VOODOO1_REGISTERS[register_offset >> 2];
    if(!register || !register.write)
    {
        // A status write only acknowledges an SST-generated PCI interrupt.
        return;
    }

    if(register.fifo && !(this.init_enable & VOODOO1_INIT_ENABLE_FIFO_WRITES))
    {
        return;
    }

    if(register.protected_write &&
        !(this.init_enable & VOODOO1_INIT_ENABLE_INIT_WRITES))
    {
        this.telemetry[TELEMETRY_PROTECTED_INIT_WRITES]++;
        return;
    }

    if(offset & 0x200000 && this.registers[0x210 >> 2] & 8)
    {
        value = Voodoo1.byte_swizzle32(value);
    }

    value = value & register.mask;

    const chip_field = offset >>> 10 & 0xF;
    const all_chips = chip_field === 0 || chip_field === 0xF;
    const fbi_selected = all_chips || !!(chip_field & 1);
    const tmu_selected = register.tmu_unconditional || all_chips || !!(chip_field & 2);

    if(register.chips & REGISTER_CHIP_FBI && fbi_selected)
    {
        const index = register_offset >> 2;
        const preserved = this.registers[index] & ~register.mask;
        this.registers[index] = (preserved | value) >>> 0;
        if(register_offset === 0x210)
        {
            const voodoo_active = !!(this.registers[index] & 1);
            // Glide selects the SST output while it is still running its
            // destructive front-buffer diagnostics. Keep VGA passthrough
            // visible until the first completed Voodoo frame, but continue
            // to honor an explicit switch back to VGA at any time.
            if(!voodoo_active)
            {
                this.scanout_active = false;
                this.bus.send("voodoo1-set-active", false);
            }
            else if(this.scanout_active)
            {
                this.bus.send("voodoo1-set-active", true);
            }
        }
        if(register_offset === 0x22C)
        {
            const dac_address = value >>> 8 & 7;
            let read_result = -1;
            if(value & VOODOO1_DAC_READ)
            {
                this.telemetry[TELEMETRY_DAC_READS]++;
                this.dac_read_result = this.read_dac(dac_address);
                read_result = this.dac_read_result;
            }
            else
            {
                this.telemetry[TELEMETRY_DAC_WRITES]++;
                this.write_dac(dac_address, value);
            }
            this.dac_history.push({ value, read_result });
            if(this.dac_history.length > 64)
            {
                this.dac_history.shift();
            }
        }
        if(register.command)
        {
            this.execute_command(register.command, value, register_offset);
        }
    }
    if(register.chips & REGISTER_CHIP_TMU && tmu_selected)
    {
        const index = register_offset >> 2;
        const palette_write = register_offset >= 0x334 &&
            register_offset <= 0x350 && !!(value & 0x80000000);
        if(palette_write)
        {
            const palette_index = (value >>> 24 & 0x7F) << 1 |
                ((register_offset - 0x334) >> 2 & 1);
            this.texture_palette[palette_index] = value & 0xFFFFFF;
            this.texture_palette_dirty = true;
        }
        else
        {
            const preserved = this.tmu_registers[index] & ~register.mask;
            this.tmu_registers[index] = (preserved | value) >>> 0;
            if(register_offset >= 0x324 && register_offset <= 0x380)
            {
                this.update_ncc_table(+(register_offset >= 0x354));
            }
        }
    }
};

/**
 * @param {number} aperture_offset
 * @param {number} access_bytes
 * @return {{x: number, y: number}}
 */
Voodoo1.get_lfb_coordinates = function(aperture_offset, access_bytes)
{
    const stride = access_bytes === 2 ? 2048 : 4096;
    return {
        x: aperture_offset % stride / access_bytes,
        y: Math.floor(aperture_offset / stride),
    };
};

/**
 * @param {number} x
 * @param {number} y
 * @param {number|undefined} color
 * @param {number|undefined} auxiliary
 */
Voodoo1.prototype.write_lfb_pixel = function(x, y, color, auxiliary)
{
    const lfb_mode = this.registers[0x114 >> 2];
    const color_selection = lfb_mode >>> 4 & 3;
    const bottom_origin = !!(lfb_mode & 1 << 13);

    if(color !== undefined && color_selection < 2)
    {
        this.write_fbi16(this.get_fbi_pixel_address(
            color_selection, x, y, bottom_origin), color);
    }
    if(auxiliary !== undefined)
    {
        this.write_fbi16(this.get_fbi_pixel_address(
            2, x, y, bottom_origin), auxiliary);
    }
};

/**
 * @param {number} aperture_offset
 * @param {number} value
 */
Voodoo1.prototype.write_lfb16 = function(aperture_offset, value)
{
    const lfb_mode = this.registers[0x114 >> 2];
    const format = lfb_mode & 0xF;
    if(aperture_offset & 1 || lfb_mode & 1 << 8 ||
        format !== 0 && format !== 1 && format !== 2 && format !== 15)
    {
        return;
    }

    if(lfb_mode & 1 << 12)
    {
        value = Voodoo1.byte_swap16(value);
    }
    const coordinates = Voodoo1.get_lfb_coordinates(aperture_offset, 2);
    if(format === 15)
    {
        this.write_lfb_pixel(coordinates.x, coordinates.y, undefined, value);
    }
    else
    {
        const converted = Voodoo1.convert_lfb16(value, format, lfb_mode >>> 9 & 3);
        const alpha_planes = !!(this.registers[0x110 >> 2] & 1 << 18);
        const auxiliary = alpha_planes && format === 2 ? converted.alpha : undefined;
        this.write_lfb_pixel(coordinates.x, coordinates.y, converted.color, auxiliary);
    }
};

/**
 * @param {number} aperture_offset
 * @param {number} value
 */
Voodoo1.prototype.write_lfb32 = function(aperture_offset, value)
{
    const lfb_mode = this.registers[0x114 >> 2];
    const format = lfb_mode & 0xF;
    if(aperture_offset & 3 || lfb_mode & 1 << 8 ||
        format === 3 || format >= 6 && format <= 11)
    {
        return;
    }

    if(lfb_mode & 1 << 12)
    {
        value = Voodoo1.byte_swizzle32(value);
    }
    if(format !== 4 && format !== 5 && lfb_mode & 1 << 11)
    {
        value = Voodoo1.word_swap32(value);
    }

    if(format <= 2)
    {
        const coordinates = Voodoo1.get_lfb_coordinates(aperture_offset, 2);
        const left = Voodoo1.convert_lfb16(value & 0xFFFF, format, lfb_mode >>> 9 & 3);
        const right = Voodoo1.convert_lfb16(value >>> 16, format, lfb_mode >>> 9 & 3);
        const alpha_planes = !!(this.registers[0x110 >> 2] & 1 << 18);
        this.write_lfb_pixel(coordinates.x, coordinates.y, left.color,
            alpha_planes && format === 2 ? left.alpha : undefined);
        this.write_lfb_pixel(coordinates.x + 1, coordinates.y, right.color,
            alpha_planes && format === 2 ? right.alpha : undefined);
        return;
    }

    const coordinates = Voodoo1.get_lfb_coordinates(aperture_offset, 4);
    if(format === 4 || format === 5)
    {
        const converted = Voodoo1.convert_lfb32(value, format, lfb_mode >>> 9 & 3);
        const alpha_planes = !!(this.registers[0x110 >> 2] & 1 << 18);
        this.write_lfb_pixel(coordinates.x, coordinates.y, converted.color,
            alpha_planes && format === 5 ? converted.alpha : undefined);
        return;
    }

    if(format === 15)
    {
        const depth_coordinates = Voodoo1.get_lfb_coordinates(aperture_offset, 2);
        this.write_lfb_pixel(depth_coordinates.x, depth_coordinates.y,
            undefined, value & 0xFFFF);
        this.write_lfb_pixel(depth_coordinates.x + 1, depth_coordinates.y,
            undefined, value >>> 16);
        return;
    }

    const color_value = value & 0xFFFF;
    const depth_value = value >>> 16;
    const converted = Voodoo1.convert_lfb16(
        color_value, format, lfb_mode >>> 9 & 3);
    const alpha_planes = !!(this.registers[0x110 >> 2] & 1 << 18);
    this.write_lfb_pixel(coordinates.x, coordinates.y, converted.color,
        format === 14 && alpha_planes ? converted.alpha : depth_value);
};

/**
 * @param {number} aperture_offset
 * @return {number}
 */
Voodoo1.prototype.read_lfb16 = function(aperture_offset)
{
    const lfb_mode = this.registers[0x114 >> 2];
    if(aperture_offset & 1 || !(this.registers[0x214 >> 2] & 8))
    {
        return 0xFFFF;
    }

    const coordinates = Voodoo1.get_lfb_coordinates(aperture_offset, 2);
    const selection = lfb_mode >>> 6 & 3;
    if(selection === 3)
    {
        return 0xFFFF;
    }
    let value = this.read_fbi16(this.get_fbi_pixel_address(selection,
        coordinates.x, coordinates.y, !!(lfb_mode & 1 << 13)));
    if(selection < 2 && (lfb_mode >>> 9 & 1))
    {
        value = (value & 0x7E0) |
            (value & 0x1F) << 11 | value >>> 11;
    }
    if(lfb_mode & 1 << 16)
    {
        value = Voodoo1.byte_swap16(value);
    }
    return value;
};

/**
 * @param {number} aperture_offset
 * @return {number}
 */
Voodoo1.prototype.read_lfb32 = function(aperture_offset)
{
    if(aperture_offset & 3)
    {
        return -1;
    }
    let value = this.read_lfb16(aperture_offset) |
        this.read_lfb16(aperture_offset + 2) << 16;
    const lfb_mode = this.registers[0x114 >> 2];
    if(lfb_mode & 1 << 15)
    {
        value = Voodoo1.word_swap32(value);
    }
    if(lfb_mode & 1 << 16)
    {
        // read_lfb16 already applied the per-word byte order. Undo that before
        // applying the documented post-word-swap 32-bit byte swizzle.
        value = Voodoo1.byte_swizzle32(
            Voodoo1.byte_swap16(value & 0xFFFF) |
            Voodoo1.byte_swap16(value >>> 16) << 16);
    }
    return value | 0;
};

/**
 * @param {number} lod
 * @param {Object=} result
 * @return {{width: number, height: number, texel_bytes: number,
 *     row_bytes: number, size: number}}
 */
Voodoo1.prototype.get_texture_level = function(lod, result)
{
    const texture_mode = this.tmu_registers[0x300 >> 2];
    const t_lod = this.tmu_registers[0x304 >> 2];
    const format = texture_mode >>> 8 & 0xF;
    const texel_bytes = format < 8 ? 1 : 2;
    const aspect = t_lod >>> 21 & 3;
    const large = Math.max(1, 256 >>> Math.min(lod, 8));
    const small = Math.max(1, large >>> aspect);
    const width = t_lod & 1 << 20 ? large : small;
    const height = t_lod & 1 << 20 ? small : large;
    const size = (texel_bytes === 1 ? 4 : 8) <<
        VOODOO1_TEXTURE_SIZE_EXPONENTS[aspect][lod];

    const level = /** @type {{width: number, height: number,
        texel_bytes: number, row_bytes: number, size: number}} */
        (/** @type {?} */ (result || {}));
    level.width = width;
    level.height = height;
    level.texel_bytes = texel_bytes;
    level.row_bytes = size / height;
    level.size = size;
    return level;
};

/** @param {number} lod @return {number} */
Voodoo1.prototype.get_texture_level_size = function(lod)
{
    const format = this.tmu_registers[0x300 >> 2] >>> 8 & 0xF;
    const aspect = this.tmu_registers[0x304 >> 2] >>> 21 & 3;
    return (format < 8 ? 4 : 8) <<
        VOODOO1_TEXTURE_SIZE_EXPONENTS[aspect][lod];
};

/**
 * @param {number} lod
 * @return {number}
 */
Voodoo1.prototype.get_texture_level_base = function(lod)
{
    const t_lod = this.tmu_registers[0x304 >> 2];
    let base_register = 0x30C;
    if(t_lod & 1 << 24)
    {
        base_register = lod === 0 ? 0x30C : lod === 1 ? 0x310 :
            lod === 2 ? 0x314 : 0x318;
    }
    let address = this.tmu_registers[base_register >> 2] << 3;

    // Supplemental base registers already describe their selected LOD.
    if(base_register !== 0x30C)
    {
        return address & (VOODOO1_TMU_MEMORY_SIZE - 1);
    }

    const split = !!(t_lod & 1 << 19);
    const odd = t_lod >>> 18 & 1;
    for(let level = 0; level < lod; level++)
    {
        if(!split || (level & 1) === odd)
        {
            address += this.get_texture_level_size(level);
        }
    }
    return address & (VOODOO1_TMU_MEMORY_SIZE - 1);
};

/** @param {number} address @param {number} value */
Voodoo1.prototype.write_tmu8 = function(address, value)
{
    address &= VOODOO1_TMU_MEMORY_SIZE - 1;
    this.tmu_memory[address] = value;
    this.tmu_dirty_min = Math.min(this.tmu_dirty_min, address);
    this.tmu_dirty_max = Math.max(this.tmu_dirty_max, address + 1);
};

/**
 * @param {number} aperture_offset
 * @param {number} value
 */
Voodoo1.prototype.write_texture32 = function(aperture_offset, value)
{
    if(aperture_offset & 3 || aperture_offset >>> 21 !== 0)
    {
        return;
    }

    const texture_mode = this.tmu_registers[0x300 >> 2];
    const t_lod = this.tmu_registers[0x304 >> 2];
    if(t_lod & 1 << 25)
    {
        value = Voodoo1.byte_swizzle32(value);
    }
    if(t_lod & 1 << 26)
    {
        value = Voodoo1.word_swap32(value);
    }

    if(t_lod & 1 << 27)
    {
        const address = aperture_offset & (VOODOO1_TMU_MEMORY_SIZE - 1);
        for(let i = 0; i < 4; i++)
        {
            this.write_tmu8(address + i, value >>> (i << 3));
        }
        return;
    }

    const lod = aperture_offset >>> 17 & 0xF;
    if(lod > 8)
    {
        return;
    }
    const split = !!(t_lod & 1 << 19);
    if(split && (lod & 1) !== (t_lod >>> 18 & 1))
    {
        return;
    }

    const level = this.get_texture_level(lod);
    const sequential = level.texel_bytes === 1 && !!(texture_mode & 0x80000000);
    const s = sequential ? (aperture_offset >>> 2 & 0x3F) << 2 :
        (aperture_offset >>> 2 & 0x7F) << 1;
    const t = aperture_offset >>> 9 & 0xFF;
    if(s >= level.width || t >= level.height)
    {
        return;
    }

    const texel_count = level.texel_bytes === 1 ? 4 : 2;
    const base = this.get_texture_level_base(lod) +
        t * level.row_bytes + s * level.texel_bytes;
    for(let texel = 0; texel < texel_count && s + texel < level.width; texel++)
    {
        for(let byte = 0; byte < level.texel_bytes; byte++)
        {
            const input_byte = texel * level.texel_bytes + byte;
            this.write_tmu8(base + input_byte, value >>> (input_byte << 3));
        }
    }
};

/**
 * @param {number} address
 * @return {number}
 */
Voodoo1.prototype.mmio_read8 = function(address)
{
    // SST-1 registers and texture downloads do not support byte accesses.
    // LFB byte accesses are invalid in every transfer mode as well.
    return 0xFF;
};

/**
 * @param {number} address
 * @return {number}
 */
Voodoo1.prototype.mmio_read16 = function(address)
{
    if(!this.memory_decode_enabled())
    {
        return 0xFFFF;
    }
    const offset = (address >>> 0) - this.bar_base >>> 0;
    if(offset < VOODOO1_LFB_APERTURE_START ||
        offset >= VOODOO1_TEXTURE_APERTURE_START || offset & 1)
    {
        return 0xFFFF;
    }

    this.telemetry[TELEMETRY_MMIO_READS]++;
    const value = this.read_lfb16(offset - VOODOO1_LFB_APERTURE_START);
    if(this.mmio_trace_enabled)
    {
        this.trace_mmio(MMIO_TRACE_READ16, offset, value);
    }
    return value;
};

/**
 * @param {number} address
 * @return {number}
 */
Voodoo1.prototype.mmio_read32 = function(address)
{
    if(!this.memory_decode_enabled())
    {
        return -1;
    }

    const offset = (address >>> 0) - this.bar_base >>> 0;
    if(offset >= VOODOO1_BAR_SIZE || offset & 3)
    {
        return -1;
    }

    this.telemetry[TELEMETRY_MMIO_READS]++;

    let value;
    if(offset < VOODOO1_REGISTER_APERTURE_SIZE)
    {
        value = this.read_register(this.decode_register_offset(offset));
    }
    else if(offset < VOODOO1_TEXTURE_APERTURE_START)
    {
        value = this.read_lfb32(offset - VOODOO1_LFB_APERTURE_START);
    }
    else
    {
        value = -1;
    }
    if(this.mmio_trace_enabled && offset === 0)
    {
        this.status_reads_since_mmio_trace++;
    }
    else if(this.mmio_trace_enabled)
    {
        this.trace_mmio(MMIO_TRACE_READ32, offset, value);
    }
    return value;
};

/**
 * @param {number} address
 * @param {number} value
 */
Voodoo1.prototype.mmio_write8 = function(address, value)
{
    // Invalid transaction size; deliberately side-effect free.
};

/**
 * @param {number} address
 * @param {number} value
 */
Voodoo1.prototype.mmio_write16 = function(address, value)
{
    if(!this.memory_decode_enabled())
    {
        return;
    }
    const offset = (address >>> 0) - this.bar_base >>> 0;
    if(offset < VOODOO1_LFB_APERTURE_START ||
        offset >= VOODOO1_TEXTURE_APERTURE_START || offset & 1)
    {
        return;
    }

    this.telemetry[TELEMETRY_MMIO_WRITES]++;
    this.telemetry[TELEMETRY_LFB_BYTES] += 2;
    if(this.mmio_trace_enabled)
    {
        this.trace_mmio(MMIO_TRACE_WRITE16, offset, value);
    }
    this.write_lfb16(offset - VOODOO1_LFB_APERTURE_START, value);
};

/**
 * @param {number} address
 * @param {number} value
 */
Voodoo1.prototype.mmio_write32 = function(address, value)
{
    if(!this.memory_decode_enabled())
    {
        return;
    }

    const offset = (address >>> 0) - this.bar_base >>> 0;
    if(offset >= VOODOO1_BAR_SIZE || offset & 3)
    {
        return;
    }

    this.telemetry[TELEMETRY_MMIO_WRITES]++;
    if(this.mmio_trace_enabled)
    {
        this.trace_mmio(MMIO_TRACE_WRITE32, offset, value);
    }

    if(offset < VOODOO1_REGISTER_APERTURE_SIZE)
    {
        this.write_register(offset, value >>> 0);
    }
    else if(offset < 0x800000)
    {
        this.telemetry[TELEMETRY_LFB_BYTES] += 4;
        this.write_lfb32(offset - VOODOO1_LFB_APERTURE_START, value >>> 0);
    }
    else
    {
        this.telemetry[TELEMETRY_TEXTURE_BYTES] += 4;
        this.write_texture32(offset - VOODOO1_TEXTURE_APERTURE_START, value >>> 0);
    }
};

Voodoo1.prototype.reset = function()
{
    this.gpu_generation++;
    this.gpu_commands_pending = false;
    this.gpu_readback_pending = false;
    this.gpu_idle_pending = false;
    this.gpu_busy = false;
    this.resume_after_gpu_wait();
    this.reset_registers();
    this.fbi_memory.fill(0);
    this.tmu_memory.fill(0);
    this.telemetry.fill(0);
    this.mmio_history.fill(0);
    this.mmio_history_index = 0;
    this.status_reads_since_mmio_trace = 0;
    this.pci_command = 0;
    this.interrupt_line = 5;
    this.init_enable = 0;
    this.bus_snoop0 = 0;
    this.bus_snoop1 = 0;
    this.map_bar(VOODOO1_BAR_BASE);
    this.front_buffer = 0;
    this.scanout_dirty = false;
    this.scanout_active = false;
    this.video_frame_start = this.get_time();
    this.fbi_dirty_min = VOODOO1_FBI_MEMORY_SIZE;
    this.fbi_dirty_max = 0;
    this.tmu_dirty_min = VOODOO1_TMU_MEMORY_SIZE;
    this.tmu_dirty_max = 0;
    this.sync_pci_space();
    this.webgpu.upload_memory(this.fbi_memory, this.tmu_memory);
    this.bus.send("voodoo1-set-active", false);
};

Voodoo1.prototype.get_state = function()
{
    return [
        this.registers,
        this.fbi_memory,
        this.tmu_memory,
        this.pci_command,
        this.interrupt_line,
        this.init_enable,
        this.bus_snoop0,
        this.bus_snoop1,
        this.telemetry,
        this.tmu_registers,
        this.front_buffer,
        this.dac_palette,
        this.dac_pll_parameters,
        this.dac_pixel_address,
        this.dac_palette_address,
        this.dac_palette_component,
        this.dac_pll_address,
        this.dac_pll_component,
        this.dac_pixel_mask,
        this.dac_command,
        this.dac_read_result,
        this.dac_hidden_reads,
        this.texture_palette,
        this.bar_base,
    ];
};

Voodoo1.prototype.set_state = function(state)
{
    this.dac_history.length = 0;
    this.mmio_history.fill(0);
    this.mmio_history_index = 0;
    this.status_reads_since_mmio_trace = 0;
    this.registers.set(state[0]);
    this.fbi_memory.set(state[1]);
    this.tmu_memory.set(state[2]);
    this.pci_command = state[3];
    this.interrupt_line = state[4];
    this.init_enable = state[5];
    this.bus_snoop0 = state[6];
    this.bus_snoop1 = state[7];
    this.telemetry.fill(0);
    this.telemetry.set(state[8]);
    this.tmu_registers.fill(0);
    if(state[9])
    {
        this.tmu_registers.set(state[9]);
    }
    this.front_buffer = state[10] || 0;
    this.scanout_dirty = false;
    if(state[11])
    {
        this.dac_palette.set(state[11]);
        this.dac_pll_parameters.set(state[12]);
        this.dac_pixel_address = state[13];
        this.dac_palette_address = state[14];
        this.dac_palette_component = state[15];
        this.dac_pll_address = state[16];
        this.dac_pll_component = state[17];
        this.dac_pixel_mask = state[18];
        this.dac_command = state[19];
        this.dac_read_result = state[20];
        this.dac_hidden_reads = state[21] || 0;
    }
    else
    {
        this.reset_dac();
    }
    this.texture_palette.fill(0);
    if(state[22])
    {
        this.texture_palette.set(state[22]);
    }
    this.map_bar(state[23] === undefined ? VOODOO1_BAR_BASE : state[23]);
    this.update_ncc_table(0);
    this.update_ncc_table(1);
    this.video_frame_start = this.get_time();
    this.fbi_dirty_min = VOODOO1_FBI_MEMORY_SIZE;
    this.fbi_dirty_max = 0;
    this.tmu_dirty_min = VOODOO1_TMU_MEMORY_SIZE;
    this.tmu_dirty_max = 0;
    this.sync_pci_space();
    this.webgpu.upload_memory(this.fbi_memory, this.tmu_memory);
    this.webgpu.upload_palette(this.texture_palette);
    this.webgpu.upload_ncc(this.texture_ncc);
    this.texture_palette_dirty = false;
    this.texture_ncc_dirty = false;
};

Voodoo1.prototype.destroy = function()
{
    this.unmap_bar();
    this.bus.send("voodoo1-set-active", false);
    this.webgpu.destroy();
};
