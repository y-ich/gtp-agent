#!/usr/bin/env node
/* global module */
const { DDPPlus } = require('ddp-plus');
const { ChatAgent } = require('./chat-agent.js');

const TWIIGO_SERVER = process.env.NODE_ENV === 'production' ?
    'wss://twiigo.herokuapp.com/websocket' :
    'ws://localhost:4000/websocket';

if (require.main === module) {
    const twiigo = new DDPPlus({ url: TWIIGO_SERVER });
    const client = new ChatAgent(twiigo, 'twiigo2015');
    twiigo.on('connect-success', async function(wasReconnect) {
        if (wasReconnect) {
            await client.stop();
        }
        client.start();
    });
    twiigo.on('connect-error', async function(error) {
        await client.stop();
    });
    twiigo.connectWithRetry(1000, 60000);
}
