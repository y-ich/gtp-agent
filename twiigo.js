#!/usr/bin/env node
/* global module */
const { DDPPlus } = require('ddp-plus');
const { ChatAgent } = require('./chat-agent.js');

const TWIIGO_SERVER = process.env.NODE_ENV === 'production' ?
    'wss://twiigo.herokuapp.com/websocket' :
    'ws://localhost:4000/websocket';

if (require.main === module) {
    const twiigo = new DDPPlus({ url: TWIIGO_SERVER });
    const client = new ChatAgent(twiigo, 'twiigo2015', parseInt(process.argv[2] || '15'));
    twiigo.addListener('connect-success', async function(wasReconnect) {
        if (wasReconnect) {
            await client.stop();
        }
        client.start();
    });
    twiigo.addListener('socket-close', async function(code, reason) {
        console.log('socket-close', reason);
        await client.stop();
    });
    twiigo.connectWithRetry(1000, 60000);
}
