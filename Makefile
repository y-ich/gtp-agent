gtpAgent:
	TWIIGO_MONGO_URL=mongodb://localhost:4001 node switcher.js

winrate:
	NODE_ENV=production LZ19_WEIGHTS=$(CURDIR)/elf_converted_weights.txt node winrate.js

winrate_dev:
	LZ19_WEIGHTS=$(CURDIR)/elf_converted_weights.txt node winrate.js