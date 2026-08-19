; Independently authored SST-1 LFB transfer probe.
; Runs as a DOS .COM program and reports its result on COM1 through BIOS INT 14h.

bits 16
org 0x100

PCI_ADDRESS equ 0xCF8
PCI_DATA equ 0xCFC
SST1_BDF equ 0x80009800
SST1_BASE equ 0xD0000000
SST1_LFB equ SST1_BASE + 0x400000

start:
    mov si, banner
    call print
    call setup_flat_fs

    ; Enable the BAR, initialization registers, and FIFOed register writes.
    mov eax, SST1_BDF | 0x04
    mov ebx, 2
    call pci_write32
    mov eax, SST1_BDF | 0x40
    mov ebx, 3
    call pci_write32

    ; 640x480, ten 64-pixel tiles, LFB reads enabled, 150 4K pages per buffer.
    mov edi, SST1_BASE + 0x214
    mov eax, 0x0020115A
    mov [fs:edi], eax
    mov edi, SST1_BASE + 0x218
    mov eax, 0x8004B040
    mov [fs:edi], eax
    mov edi, SST1_BASE + 0x20C
    mov eax, 0x01E00280
    mov [fs:edi], eax

    ; A real 16-bit RGB565 transaction must round-trip.
    mov edi, SST1_BASE + 0x114
    xor eax, eax
    mov [fs:edi], eax
    mov edi, SST1_LFB
    mov ax, 0xF800
    mov [fs:edi], ax
    mov ax, [fs:edi]
    cmp ax, 0xF800
    jne fail_word

    ; A byte transaction is invalid and must not alter either packed pixel.
    mov eax, 0x07E0F800
    mov [fs:edi + 4], eax
    mov byte [fs:edi + 4], 0
    mov eax, [fs:edi + 4]
    cmp eax, 0x07E0F800
    jne fail_byte

    ; Write word swapping reverses the two screen pixels in a packed transfer.
    mov edi, SST1_BASE + 0x114
    mov eax, 1 << 11
    mov [fs:edi], eax
    mov edi, SST1_LFB + 8
    mov eax, 0x001FF800
    mov [fs:edi], eax
    mov edi, SST1_BASE + 0x114
    xor eax, eax
    mov [fs:edi], eax
    mov edi, SST1_LFB + 8
    mov eax, [fs:edi]
    cmp eax, 0xF800001F
    jne fail_word_swap

    ; x888 input is converted to the native RGB565 framebuffer representation.
    mov edi, SST1_BASE + 0x114
    mov eax, 4
    mov [fs:edi], eax
    mov edi, SST1_LFB
    mov eax, 0x00FF0000
    mov [fs:edi], eax
    mov edi, SST1_BASE + 0x114
    xor eax, eax
    mov [fs:edi], eax
    mov edi, SST1_LFB
    mov ax, [fs:edi]
    cmp ax, 0xF800
    jne fail_x888

    ; BGR lanes are converted on write and converted back on read.
    mov edi, SST1_BASE + 0x114
    mov eax, 1 << 9
    mov [fs:edi], eax
    mov edi, SST1_LFB + 12
    mov ax, 0x001F
    mov [fs:edi], ax
    mov ax, [fs:edi]
    cmp ax, 0x001F
    jne fail_lanes
    mov edi, SST1_BASE + 0x114
    xor eax, eax
    mov [fs:edi], eax
    mov edi, SST1_LFB + 12
    mov ax, [fs:edi]
    cmp ax, 0xF800
    jne fail_lanes

    ; Format 12 writes both color and depth; read-select 2 exposes auxiliary RAM.
    mov edi, SST1_BASE + 0x114
    mov eax, 12
    mov [fs:edi], eax
    mov edi, SST1_LFB + 16
    mov eax, 0x1234F800
    mov [fs:edi], eax
    mov edi, SST1_BASE + 0x114
    mov eax, 2 << 6
    mov [fs:edi], eax
    mov edi, SST1_LFB + 8
    mov ax, [fs:edi]
    cmp ax, 0x1234
    jne fail_depth

    mov si, pass_message
    xor al, al
    jmp finish

fail_word:
    mov si, word_message
    jmp failed
fail_byte:
    mov si, byte_message
    jmp failed
fail_word_swap:
    mov si, word_swap_message
    jmp failed
fail_x888:
    mov si, x888_message
    jmp failed
fail_lanes:
    mov si, lanes_message
    jmp failed
fail_depth:
    mov si, depth_message

failed:
    mov al, 1

finish:
    push ax
    push ds
    pop fs
    call print
    pop ax
    mov ah, 0x4C
    int 0x21

setup_flat_fs:
    xor eax, eax
    mov ax, ds
    shl eax, 4
    add eax, gdt
    mov [gdt_pointer + 2], eax
    cli
    lgdt [gdt_pointer]
    mov eax, cr0
    or eax, 1
    mov cr0, eax
    jmp short $+2
    mov bx, 8
    mov fs, bx
    and eax, 0xFFFFFFFE
    mov cr0, eax
    jmp short $+2
    sti
    ret

pci_write32:
    mov dx, PCI_ADDRESS
    out dx, eax
    mov dx, PCI_DATA
    mov eax, ebx
    out dx, eax
    ret

print:
    lodsb
    test al, al
    jz .done
    push si
    mov ah, 1
    xor dx, dx
    int 0x14
    pop si
    jmp print
.done:
    ret

align 8
gdt:
    dq 0
    dw 0xFFFF, 0x0000
    db 0x00, 0x92, 0xCF, 0x00
gdt_end:
gdt_pointer:
    dw gdt_end - gdt - 1
    dd 0

banner db "VOODOO1 LFB PROBE", 13, 10, 0
pass_message db "VOODOO1 LFB PASS", 13, 10, 0
word_message db "VOODOO1 LFB FAIL word", 13, 10, 0
byte_message db "VOODOO1 LFB FAIL byte-reject", 13, 10, 0
word_swap_message db "VOODOO1 LFB FAIL word-swap", 13, 10, 0
x888_message db "VOODOO1 LFB FAIL x888", 13, 10, 0
lanes_message db "VOODOO1 LFB FAIL lanes", 13, 10, 0
depth_message db "VOODOO1 LFB FAIL depth", 13, 10, 0
