#!/usr/bin/env node

import assert from "node:assert/strict";

import { Bus } from "../../src/bus.js";
import { IO } from "../../src/io.js";
import { set_log_level } from "../../src/log.js";
import { ParallelPort } from "../../src/parallel.js";

process.on("unhandledRejection", exn => { throw exn; });
set_log_level(0);

const LPT1_PORT = 0x378;
const LPT2_PORT = 0x278;
const DATA_PORT = 0;
const STATUS_PORT = 1;
const CONTROL_PORT = 2;

const STATUS_ERROR = 0x08;
const STATUS_SELECT = 0x10;
const STATUS_ACK = 0x40;
const STATUS_NOT_BUSY = 0x80;
const STATUS_IDLE = STATUS_NOT_BUSY | STATUS_ACK | STATUS_SELECT | STATUS_ERROR;

const CONTROL_IRQ_ENABLE = 0x10;
const CONTROL_MASK = 0x1F;
const LPT1_IRQ = 7;
const LPT2_IRQ = 5;
const LPT_PORTS = [LPT1_PORT, LPT2_PORT];
const LPT_IRQS = [LPT1_IRQ, LPT2_IRQ];

function create_test_context(port = LPT1_PORT, irq = LPT1_IRQ, lpt = 0)
{
    const cpu = {
        memory_size: [16 * 1024 * 1024],
        memory_map_read8: [],
        memory_map_write8: [],
        memory_map_read32: [],
        memory_map_write32: [],
        lowered_irqs: [],
        raised_irqs: [],
        device_lower_irq(irq)
        {
            this.lowered_irqs.push(irq);
        },
        device_raise_irq(irq)
        {
            this.raised_irqs.push(irq);
        },
    };
    cpu.io = new IO(cpu);

    const [device_bus, adapter_bus] = Bus.create();
    const data_output = [];
    const control_output = [];

    adapter_bus.register("parallel" + lpt + "-data-output", value => data_output.push(value), undefined);
    adapter_bus.register("parallel" + lpt + "-control-output", value => control_output.push(value), undefined);

    const parallel = new ParallelPort(cpu, port, irq, lpt, device_bus);

    return {
        cpu,
        io: cpu.io,
        adapter_bus,
        parallel,
        data_output,
        control_output,
    };
}

{
    const { io, adapter_bus, data_output, control_output } = create_test_context();

    assert.equal(io.port_read8(LPT1_PORT + DATA_PORT), 0);
    assert.equal(io.port_read8(LPT1_PORT + STATUS_PORT), STATUS_IDLE);
    assert.equal(io.port_read8(LPT1_PORT + CONTROL_PORT), 0);

    io.port_write8(LPT1_PORT + DATA_PORT, 0x5A);
    assert.equal(io.port_read8(LPT1_PORT + DATA_PORT), 0x5A);
    assert.deepEqual(data_output, [0x5A]);

    adapter_bus.send("parallel0-status-input", 0x11);
    assert.equal(io.port_read16(LPT1_PORT + DATA_PORT), 0x115A);

    io.port_write8(LPT1_PORT + CONTROL_PORT, 0xFF);
    assert.equal(io.port_read8(LPT1_PORT + CONTROL_PORT), CONTROL_MASK);
    assert.deepEqual(control_output, [CONTROL_MASK]);
}

{
    for(let lpt = 0; lpt < LPT_PORTS.length; lpt++)
    {
        const port = LPT_PORTS[lpt];
        const irq = LPT_IRQS[lpt];
        const { io, adapter_bus, data_output, control_output, cpu } = create_test_context(port, irq, lpt);

        io.port_write8(port + DATA_PORT, 0x66 + lpt);
        io.port_write8(port + CONTROL_PORT, CONTROL_IRQ_ENABLE);
        adapter_bus.send("parallel" + lpt + "-status-input", STATUS_NOT_BUSY | STATUS_SELECT | STATUS_ERROR);

        assert.equal(io.port_read8(port + DATA_PORT), 0x66 + lpt);
        assert.deepEqual(data_output, [0x66 + lpt]);
        assert.deepEqual(control_output, [CONTROL_IRQ_ENABLE]);
        assert.deepEqual(cpu.lowered_irqs, [LPT_IRQS[lpt]]);
        assert.deepEqual(cpu.raised_irqs, [LPT_IRQS[lpt]]);
    }
}

{
    const { io, adapter_bus, cpu } = create_test_context();

    io.port_write8(LPT1_PORT + CONTROL_PORT, CONTROL_IRQ_ENABLE);
    adapter_bus.send("parallel0-status-input", STATUS_NOT_BUSY | STATUS_SELECT | STATUS_ERROR);
    adapter_bus.send("parallel0-status-input", STATUS_IDLE);

    assert.deepEqual(cpu.lowered_irqs, [LPT1_IRQ]);
    assert.deepEqual(cpu.raised_irqs, [LPT1_IRQ]);

    assert.equal(
        io.port_read8(LPT1_PORT + STATUS_PORT),
        STATUS_NOT_BUSY | STATUS_SELECT | STATUS_ERROR,
        "falling ACK status is latched for one read"
    );
    assert.equal(io.port_read8(LPT1_PORT + STATUS_PORT), STATUS_IDLE);
}

{
    const { io, parallel, adapter_bus } = create_test_context();

    io.port_write16(LPT1_PORT + DATA_PORT, 0xAA33);
    io.port_write16(LPT1_PORT + STATUS_PORT, 0x1200);
    adapter_bus.send("parallel0-status-input", STATUS_NOT_BUSY);

    assert.equal(io.port_read8(LPT1_PORT + DATA_PORT), 0x33);
    assert.equal(io.port_read16(LPT1_PORT + STATUS_PORT), STATUS_NOT_BUSY | 0x12 << 8);

    const state = parallel.get_state();
    io.port_write8(LPT1_PORT + DATA_PORT, 0x44);
    io.port_write8(LPT1_PORT + CONTROL_PORT, 0x03);
    adapter_bus.send("parallel0-status-input", STATUS_IDLE);

    parallel.set_state(state);

    assert.equal(io.port_read8(LPT1_PORT + DATA_PORT), 0x33);
    assert.equal(io.port_read8(LPT1_PORT + STATUS_PORT), STATUS_NOT_BUSY);
    assert.equal(io.port_read8(LPT1_PORT + CONTROL_PORT), 0x12);
}

console.log("Parallel port tests passed");
