gtpAgent:
	TWIIGO_MONGO_URL=mongodb://localhost:4001 node switcher.js

winrate:
	NODE_ENV=production node winrate.js

winrate_dev:
	node winrate.js