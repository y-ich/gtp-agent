/* global module */
const { DDPPlus } = require('ddp-plus');
const { LeelaClient } = require('./winrate.js');
const { ChatAgent } = require('./chat-agent.js');

const MIMIAKA_SERVER = process.env.NODE_ENV === 'production' ?
    'wss://mimiaka.herokuapp.com/websocket' :
    'ws://localhost:3000/websocket';
const TWIIGO_SERVER = process.env.NODE_ENV === 'production' ?
    'wss://twiigo.herokuapp.com/websocket' :
    'ws://localhost:4000/websocket';

if (require.main === module) {
    const mimiaka = new DDPPlus({ url: MIMIAKA_SERVER });
    const twiigo = new DDPPlus({ url: TWIIGO_SERVER });
    const winrate = new LeelaClient(mimiaka, parseInt(process.argv[2] || '1'));
    const agent = new ChatAgent(twiigo, 'twiigo2015');
    let winrateBusy = false;

    winrate.onTargetAdded = async function() {
        agent.say('急用が入りました。ごめんなさい。失礼します', 'ja');
        await agent.stop();
        winrateBusy = true;
    }
    winrate.onTargetRemoved = async function() {
        console.log('onTargetRemoved');
        winrateBusy = false;
        agent.start();
    }
    mimiaka.on('connect-success', async function(wasReconnect) {
        if (wasReconnect) {
            await winrate.destroy();
        }
        winrate.start();
    });
    mimiaka.on('connect-error', async function(error) {
        await winrate.destroy();
    });

    twiigo.on('connect-success', async function(wasReconnect) {
        if (wasReconnect) {
            await agent.stop();
        }
        await twiigo.call('becomeKako');
        if (!winrateBusy) {
            agent.start();
        }
    });
    twiigo.on('connect-error', async function(error) {
        await agent.stop();
    });

    mimiaka.connectWithRetry(1000, 60000);
    twiigo.connectWithRetry(1000, 60000);
}
