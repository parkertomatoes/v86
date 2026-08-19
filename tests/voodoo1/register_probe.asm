; Independently authored SST-1 MMIO register probe.
; Runs as a DOS .COM program and reports its result on COM1 through BIOS INT 14h.

bits 16
org 0x100

PCI_ADDRESS equ 0xCF8
PCI_DATA equ 0xCFC
SST1_BDF equ 0x80009800       ; bus 0, device 19, function 0
SST1_BASE equ 0xD0000000

start:
    mov si, banner
    call print

    call setup_flat_fs

    ; Enable the memory BAR and FIFOed register writes.
    mov eax, SST1_BDF | 0x04
    mov ebx, 2
    call pci_write32
    mov eax, SST1_BDF | 0x40
    mov ebx, 2
    call pci_write32

    ; Main FBI rendering registers retain documented writable fields.
    mov edi, SST1_BASE + 0x110
    mov eax, 0x00100001
    mov [fs:edi], eax
    mov eax, [fs:edi]
    cmp eax, 0x00100001
    jne fail_fbz_mask

    mov edi, SST1_BASE + 0x118
    mov eax, 0x012301FF
    mov [fs:edi], eax
    mov eax, [fs:edi]
    cmp eax, 0x012301FF
    jne fail_clip_mask

    ; fbiInit writes remain protected while initEnable[0] is clear.
    mov edi, SST1_BASE + 0x210
    mov eax, [fs:edi]
    cmp eax, 0x00000410
    jne fail_init_reset
    xor eax, eax
    mov [fs:edi], eax
    mov eax, [fs:edi]
    cmp eax, 0x00000410
    jne fail_init_protect

    ; Unlock initialization registers and verify that writes are now accepted.
    mov eax, SST1_BDF | 0x40
    mov ebx, 3
    call pci_write32
    mov edi, SST1_BASE + 0x210
    xor eax, eax
    mov [fs:edi], eax
    mov eax, [fs:edi]
    test eax, eax
    jne fail_init_mask

    ; fbiInit0[3] byte-swizzles writes made through wrap bit 7 (AD[21]).
    mov edi, SST1_BASE + 0x210
    mov eax, 8
    mov [fs:edi], eax
    mov edi, SST1_BASE + 0x200000 + 0x110
    mov eax, 0x00010000
    mov [fs:edi], eax
    mov edi, SST1_BASE + 0x110
    mov eax, [fs:edi]
    cmp eax, 0x00000100
    jne fail_swizzle

    ; A TMU-only chip selection cannot update an FBI-only register.
    xor eax, eax
    mov [fs:edi], eax
    mov edi, SST1_BASE + 0x800 + 0x110
    mov eax, 0x55
    mov [fs:edi], eax
    mov edi, SST1_BASE + 0x110
    mov eax, [fs:edi]
    test eax, eax
    jnz fail_chip_select

    ; An FBI chip selection does update it, and reads ignore chip selection.
    mov edi, SST1_BASE + 0x400 + 0x110
    mov eax, 1
    mov [fs:edi], eax
    mov edi, SST1_BASE + 0xC00 + 0x110
    mov eax, [fs:edi]
    cmp eax, 1
    jne fail_chip_select

    mov si, pass_message
    xor al, al
    jmp finish

fail_fbz_mask:
    mov si, fbz_mask_message
    jmp failed
fail_clip_mask:
    mov si, clip_mask_message
    jmp failed
fail_init_reset:
    mov si, init_reset_message
    jmp failed
fail_init_protect:
    mov si, init_protect_message
    jmp failed
fail_init_mask:
    mov si, init_mask_message
    jmp failed
fail_swizzle:
    mov si, swizzle_message
    jmp failed
fail_chip_select:
    mov si, chip_select_message

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

; Load FS with a 4 GiB data segment, then return to real mode. This permits
; actual aligned 32-bit memory transactions to the PCI BAR without a DOS
; extender. No BIOS or DOS call is made until all MMIO checks are complete.
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

; EAX: configuration address, EBX: value.
pci_write32:
    mov dx, PCI_ADDRESS
    out dx, eax
    mov dx, PCI_DATA
    mov eax, ebx
    out dx, eax
    ret

; DS:SI: zero-terminated string.
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

banner db "VOODOO1 REGISTER PROBE", 13, 10, 0
pass_message db "VOODOO1 REGISTER PASS", 13, 10, 0
fbz_mask_message db "VOODOO1 REGISTER FAIL fbz-roundtrip", 13, 10, 0
clip_mask_message db "VOODOO1 REGISTER FAIL clip-roundtrip", 13, 10, 0
init_reset_message db "VOODOO1 REGISTER FAIL init-reset", 13, 10, 0
init_protect_message db "VOODOO1 REGISTER FAIL init-protect", 13, 10, 0
init_mask_message db "VOODOO1 REGISTER FAIL init-unlock", 13, 10, 0
swizzle_message db "VOODOO1 REGISTER FAIL byte-swizzle", 13, 10, 0
chip_select_message db "VOODOO1 REGISTER FAIL chip-select", 13, 10, 0
