#!/usr/bin/env node
/* global module */
const { MongoClient } = require('mongodb');
const { DDPPlus } = require('ddp-plus');
const { DDPPlusPlus } = require('./ddp-plusplus');
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
    const twiigo = new DDPPlusPlus({ url: TWIIGO_SERVER, autoReconnect: false });
    const winrate = new LeelaClient(mimiaka);
    const agent = new ChatAgent(twiigo, 'twiigo2015', parseInt(process.argv[2] || '15'));
    let winrateBusy = false;

    winrate.onTargetAdded = async function() {
        try {
            await agent.say('急用が入りました。ごめんなさい。失礼します', 'ja');
            await agent.stop();
            twiigo.stopRetry();
            twiigo.close();
            winrateBusy = true;
        } catch (e) {
            console.log(e);
        }
    }
    winrate.onTargetRemoved = async function() {
        winrateBusy = false;
        twiigo.connectWithRetry(1000, 60000);
    }
    mimiaka.addListener('connect-success', async function(wasReconnect) {
        try {
            if (wasReconnect) {
                await winrate.destroy();
            }
            await winrate.start();
        } catch (e) {
            console.log(e);
        }
    });
    mimiaka.addListener('socket-close', async function(code, reason) {
        try {
            await winrate.destroy();
        } catch (e) {
            console.log(e);
        }
    });

    twiigo.addListener('connect-success', async function(wasReconnect) {
        try {
            if (wasReconnect) {
                await agent.stop();
            }
            if (!winrateBusy) {
                agent.start();
            }
        } catch (e) {
            console.log(e);
        }
    });

    twiigo.addListener('socket-close', async function(code, reason) {
        try {
            await agent.stop();
            twiigo.close();
            twiigo.connectWithRetry();
        } catch (e) {
            console.log(e);
        }
    });
    mimiaka.connectWithRetry(1000, 60000);
    twiigo.connectWithRetry(1000, 60000, async function() {
        try {
            if (winrateBusy) {
                return false;
            }
            const db = await MongoClient.connect(process.env.TWIIGO_MONGO_URL);
            try {
                const Constants = db.collection('constants');
                if (!Constants) {
                    return false;
                }
                const item = await Constants.findOne({ category: 'heroku-state' });
                console.log('connectWithRetry', item);
                return item == null || !item.sleep;
            } catch (e) {
                return false;
            } finally {
                db.close();
            }
        } catch (e) {
            console.log(e);
        }
    });
}
