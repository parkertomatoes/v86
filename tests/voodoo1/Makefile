BUILD_DIR=../../build/voodoo1

.PHONY: all clean test

all: $(BUILD_DIR)/pci_probe.com $(BUILD_DIR)/register_probe.com $(BUILD_DIR)/lfb_probe.com

test: all
	node device_test.js

$(BUILD_DIR)/pci_probe.com: pci_probe.asm
	mkdir -p $(BUILD_DIR)
	nasm -w+error -f bin -o $@ $<

$(BUILD_DIR)/register_probe.com: register_probe.asm
	mkdir -p $(BUILD_DIR)
	nasm -w+error -f bin -o $@ $<

$(BUILD_DIR)/lfb_probe.com: lfb_probe.asm
	mkdir -p $(BUILD_DIR)
	nasm -w+error -f bin -o $@ $<

clean:
	rm -f $(BUILD_DIR)/pci_probe.com $(BUILD_DIR)/register_probe.com $(BUILD_DIR)/lfb_probe.com
