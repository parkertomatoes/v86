/**
 * Minimal DOM owner for the Voodoo Graphics WebGPU canvas.
 * Voodoo 1 had a VGA pass-through and could switch between 3d mode and the other display adapter's VGA output.
 *
 * @constructor
 * @param {!Object} options
 * @param {!Object} bus
 */
export function Voodoo1ScreenAdapter(options, bus)
{
    const container = options.container;
    if(!container)
    {
        throw new Error("Voodoo Graphics requires a screen container");
    }

    this.bus = bus;
    this.container = container;
    this.vga_elements = Array.from(container.children);
    this.vga_display = [];
    this.requested_active = false;
    this.output_override = null;
    this.active = false;
    this.container_width = "";
    this.container_height = "";
    this.container_position = container.style.position;
    this.position_overridden = getComputedStyle(container).position === "static";
    if(this.position_overridden)
    {
        container.style.position = "relative";
    }

    /** @type {!HTMLCanvasElement} */
    const canvas = /** @type {!HTMLCanvasElement} */ (document.createElement("canvas"));
    canvas.width = 640;
    canvas.height = 480;
    canvas.style.display = "none";
    canvas.style.position = "absolute";
    canvas.style.left = "0";
    canvas.style.top = "0";
    canvas.style.zIndex = "1";
    canvas.setAttribute("aria-label", "Voodoo Graphics display");
    container.appendChild(canvas);
    this.canvas = canvas;

    bus.register("voodoo1-set-active", this.set_active, this);
    bus.register("voodoo1-set-output-override", this.set_output_override, this);
    bus.register("voodoo1-resize", this.resize, this);
}

/** @return {!HTMLCanvasElement} */
Voodoo1ScreenAdapter.prototype.get_canvas = function()
{
    return this.canvas;
};

/** @param {{width: number, height: number}} size */
Voodoo1ScreenAdapter.prototype.resize = function(size)
{
    this.canvas.width = size.width;
    this.canvas.height = size.height;
    if(this.active)
    {
        this.container.style.width = size.width + "px";
        this.container.style.height = size.height + "px";
    }
};

/** @param {boolean} active */
Voodoo1ScreenAdapter.prototype.set_active = function(active)
{
    this.requested_active = !!active;
    this.update_display();
};

/** @param {?boolean} active */
Voodoo1ScreenAdapter.prototype.set_output_override = function(active)
{
    this.output_override = active === null ? null : !!active;
    this.update_display();
};

Voodoo1ScreenAdapter.prototype.update_display = function()
{
    const active = this.output_override === null ? this.requested_active : this.output_override;
    if(active === this.active)
    {
        return;
    }

    this.active = active;
    if(active)
    {
        this.container_width = this.container.style.width;
        this.container_height = this.container.style.height;
        this.vga_display = this.vga_elements.map(element => element.style.display);
        for(const element of this.vga_elements)
        {
            element.style.display = "none";
        }
        // ScreenAdapter may subsequently change the VGA canvas back to block
        // when the guest enters graphics mode. Keep both outputs in the same
        // fixed display box and put Voodoo on top instead of letting the two
        // canvases stack and enlarge the page.
        this.container.style.width = this.canvas.width + "px";
        this.container.style.height = this.canvas.height + "px";
        this.canvas.style.display = "block";
    }
    else
    {
        this.canvas.style.display = "none";
        this.container.style.width = this.container_width;
        this.container.style.height = this.container_height;
        for(let i = 0; i < this.vga_elements.length; i++)
        {
            this.vga_elements[i].style.display = this.vga_display[i] || "";
        }
    }
};

Voodoo1ScreenAdapter.prototype.destroy = function()
{
    this.output_override = null;
    this.set_active(false);
    this.bus.unregister("voodoo1-set-active", this.set_active);
    this.bus.unregister("voodoo1-set-output-override", this.set_output_override);
    this.bus.unregister("voodoo1-resize", this.resize);
    this.canvas.remove();
    if(this.position_overridden)
    {
        this.container.style.position = this.container_position;
    }
};
