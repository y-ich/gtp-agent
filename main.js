/* global module */
const { RetryDDP } = require('./retry-ddp.js');
const { ddpCallPromise } = require('./util.js');
const { ChatAgent } = require('./chat-agent.js');

const TWIIGO_SERVER = process.env.NODE_ENV === 'production' ?
    'wss://twiigo.herokuapp.com/websocket' :
    'ws://localhost:4000/websocket';

if (require.main === module) {
    const twiigo = new RetryDDP({ url: TWIIGO_SERVER });
    const client = new ChatAgent(twiigo.ddp, 'twiigo2015');
    twiigo.on('connect-success', async function(wasReconnect) {
        if (wasReconnect) {
            await client.stop();
        }
        await ddpCallPromise(twiigo.ddp, 'becomeKako');
        client.start();
    });
    twiigo.on('connect-error', async function(error) {
        await client.stop();
    });
    twiigo.start();
}
