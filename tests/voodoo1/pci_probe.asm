; Independently authored SST-1 PCI configuration-space probe.
; Runs as a DOS .COM program and reports its result on COM1 through BIOS INT 14h.

bits 16
org 0x100

PCI_ADDRESS equ 0xCF8
PCI_DATA equ 0xCFC
SST1_BDF equ 0x80009800       ; bus 0, device 19, function 0
SST1_RELOCATED_BASE equ 0xC0000000

start:
    mov si, banner
    call print
    call setup_flat_fs

    mov eax, SST1_BDF | 0x00
    call pci_read32
    cmp eax, 0x0001121A
    jne fail_identity

    mov eax, SST1_BDF | 0x10
    call pci_read32
    cmp eax, 0xD0000000
    jne fail_bar
    mov esi, eax

    mov eax, SST1_BDF | 0x10
    mov ebx, 0xFFFFFFFF
    call pci_write32
    mov eax, SST1_BDF | 0x10
    call pci_read32
    cmp eax, 0xFF000000
    jne fail_bar_size

    ; Win9x's PCI resource manager relocates memory BARs before the Glide
    ; VxD maps them. The programmed address must read back and decode MMIO.
    mov eax, SST1_BDF | 0x10
    mov ebx, SST1_RELOCATED_BASE
    call pci_write32
    mov eax, SST1_BDF | 0x10
    call pci_read32
    cmp eax, SST1_RELOCATED_BASE
    jne fail_bar_move

    ; Only PCI command bit 1 (memory decode) is writable.
    mov eax, SST1_BDF | 0x04
    mov ebx, 0xFFFFFFFF
    call pci_write32
    mov eax, SST1_BDF | 0x04
    call pci_read32
    cmp eax, 2
    jne fail_command

    mov edi, SST1_RELOCATED_BASE
    mov eax, [fs:edi]
    and eax, 0xFFFFFFBF
    cmp eax, 0x0FFFF03F
    jne fail_bar_move

    mov eax, SST1_BDF | 0x10
    mov ebx, esi
    call pci_write32

    ; initEnable has documented bits 0:2 and 4:11 only.
    mov eax, SST1_BDF | 0x40
    mov ebx, 0xFFFFFFFF
    call pci_write32
    mov eax, SST1_BDF | 0x40
    call pci_read32
    cmp eax, 0x00000FF7
    jne fail_init_enable

    ; Both snoop addresses are write-only.
    mov eax, SST1_BDF | 0x44
    mov ebx, 0x12345678
    call pci_write32
    mov eax, SST1_BDF | 0x44
    call pci_read32
    test eax, eax
    jnz fail_snoop

    mov eax, SST1_BDF | 0x48
    mov ebx, 0x87654321
    call pci_write32
    mov eax, SST1_BDF | 0x48
    call pci_read32
    test eax, eax
    jnz fail_snoop

    ; cfgStatus aliases the idle, empty-FIFO memory-mapped status register.
    ; Vertical retrace is asynchronous, so accept either state for bit 6.
    mov eax, SST1_BDF | 0x4C
    call pci_read32
    and eax, 0xFFFFFFBF
    cmp eax, 0x0FFFF03F
    jne fail_status

    mov si, pass_message
    xor al, al
    jmp finish

fail_identity:
    mov si, identity_message
    jmp failed
fail_bar:
    mov si, bar_message
    jmp failed
fail_bar_size:
    mov si, bar_size_message
    jmp failed
fail_bar_move:
    mov si, bar_move_message
    jmp failed
fail_command:
    mov si, command_message
    jmp failed
fail_init_enable:
    mov si, init_enable_message
    jmp failed
fail_snoop:
    mov si, snoop_message
    jmp failed
fail_status:
    mov si, status_message

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

; EAX: configuration address, returns EAX: value.
pci_read32:
    mov dx, PCI_ADDRESS
    out dx, eax
    mov dx, PCI_DATA
    in eax, dx
    ret

; EAX: configuration address, EBX: value.
pci_write32:
    mov dx, PCI_ADDRESS
    out dx, eax
    mov dx, PCI_DATA
    mov eax, ebx
    out dx, eax
    ret

; Load FS with a 4 GiB data segment, then return to real mode. This permits
; a direct MMIO read from the relocated BAR without a DOS extender.
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

banner db "VOODOO1 PCI PROBE", 13, 10, 0
pass_message db "VOODOO1 PCI PASS", 13, 10, 0
identity_message db "VOODOO1 PCI FAIL identity", 13, 10, 0
bar_message db "VOODOO1 PCI FAIL bar", 13, 10, 0
bar_size_message db "VOODOO1 PCI FAIL bar-size", 13, 10, 0
bar_move_message db "VOODOO1 PCI FAIL bar-move", 13, 10, 0
command_message db "VOODOO1 PCI FAIL command", 13, 10, 0
init_enable_message db "VOODOO1 PCI FAIL init-enable", 13, 10, 0
snoop_message db "VOODOO1 PCI FAIL snoop", 13, 10, 0
status_message db "VOODOO1 PCI FAIL status", 13, 10, 0
